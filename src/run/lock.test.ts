// Lock files: a dead or recycled pid's lock is taken over, a live one holds, rivals get it once each, withLock waits.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withDir } from '../testing/fixtures.ts'
import { acquireLock, LockedError, lockClaims, type ProcessProbe, type Ps, psStartedAt, systemProbe, withLock } from './lock.ts'

const RIVAL = new URL('../testing/lock-rival.ts', import.meta.url).pathname

describe('lock', () => {
  it('a dead pid is taken over, a live holder holds, and release leaves no file behind', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      await acquireLock(path, 999_999)
      assert.deepEqual((await lockClaims(path)).map((c) => c.pid), [999_999])
      const release = await acquireLock(path)
      assert.deepEqual((await lockClaims(path)).map((c) => c.pid), [process.pid], 'the dead claim was removed')
      await assert.rejects(acquireLock(path, process.pid, { waitMs: 100 }), LockedError)
      await release()
      assert.deepEqual(await readdir(dir), [])
    })
  })

  it('rivals arriving together at a stale lock: exactly one gets it, every time', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      for (let round = 0; round < 20; round++) {
        await acquireLock(path, 999_999)
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(path, process.pid, { waitMs: 100 })))
        const won = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
        for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof LockedError, String(r.reason))
        assert.equal(won.length, 1, `round ${round}: ${won.length} holders`)
        for (const release of won) await release()
        assert.deepEqual(await readdir(dir), [], `round ${round}: files left behind`)
      }
    })
  })

  it('separate processes at a stale lock: exactly one gets it', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      for (let round = 0; round < 2; round++) {
        await acquireLock(path, 999_999)
        const start = String(Date.now() + 800)
        // Each rival answers, then a winner holds on until every rival has answered and their stdin is closed.
        const rivals = Array.from({ length: 4 }, () => spawn(process.execPath, [RIVAL, path, start], { stdio: ['pipe', 'pipe', 'inherit'] }))
        const outs = await Promise.all(rivals.map((c) => once(c.stdout, 'data').then(([chunk]) => String(chunk).trim())))
        await Promise.all(rivals.map((c) => (c.stdin.end(), once(c, 'exit'))))
        assert.equal(outs.filter((o) => o === 'won').length, 1, outs.join(', '))
        assert.deepEqual(outs.filter((o) => o !== 'won'), ['LockedError', 'LockedError', 'LockedError'])
        assert.deepEqual(await readdir(dir), [])
      }
    })
  })

  it('taking over a dead claim never removes a rival claim made meanwhile; that rival holds the lock', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      // A live rival claimed the lock after a dead process left its claim: the rival's claim is earlier, then later, to
      // cover both "step back at once" and "look again, then give up".
      for (const later of [false, true]) {
        await writeFile(join(dir, `run.lock.999999.${randomUUID()}`), '999999\n')
        const rival = `run.lock.${process.pid}.${randomUUID()}`
        await writeFile(join(dir, rival), `${process.pid}\n`)
        if (later) await utimes(join(dir, rival), new Date(), new Date(Date.now() + 3_600_000))
        await assert.rejects(acquireLock(path, process.pid, { waitMs: 100 }), LockedError)
        assert.deepEqual(await readdir(dir), [rival], 'the dead claim is gone, the rival claim stays')
        await rm(join(dir, rival))
      }
      const release = await acquireLock(path)
      await release()
    })
  })

  it('a directory that cannot be listed fails the lock instead of granting it, and leaves no claim behind', async () => {
    await withDir(async (dir) => {
      const locks = join(dir, 'locks')
      const path = join(locks, 'run.lock')
      await (await acquireLock(path))()
      await chmod(locks, 0o300) // files can be created, not listed
      try {
        await assert.rejects(acquireLock(path, process.pid, { waitMs: 100 }), /EACCES/)
      } finally {
        await chmod(locks, 0o700)
      }
      assert.deepEqual(await readdir(locks), [])
    })
  })

  it('withLock waits for the holder, then runs; it gives up after waitMs', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'store.lock')
      const release = await acquireLock(path)
      const order: string[] = []
      const waiting = withLock(path, async () => order.push('second'), { pollMs: 5 })
      await new Promise((r) => setTimeout(r, 30))
      order.push('first done')
      await release()
      await waiting
      assert.deepEqual(order, ['first done', 'second'])
      const held = await acquireLock(path)
      await assert.rejects(withLock(path, async () => 1, { waitMs: 20, pollMs: 5 }), LockedError)
      await held()
    })
  })
  it('a live pid whose process started after the claim was made is a recycled pid: its claim is taken over', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      const claimedAt = Date.now() - 3_600_000
      const probe = (started: number | undefined): ProcessProbe => ({ alive: () => true, startedAt: async () => started })
      const old = `run.lock.4242.${randomUUID()}`
      await writeFile(join(dir, old), '')
      await utimes(join(dir, old), new Date(claimedAt), new Date(claimedAt))
      // Started just after the claim (ps counts whole seconds), or when ps cannot tell: still the claimant.
      for (const started of [claimedAt + 2_000, undefined]) {
        await assert.rejects(acquireLock(path, process.pid, { waitMs: 100, probe: probe(started) }), LockedError)
        assert.deepEqual(await readdir(dir), [old])
      }
      const release = await acquireLock(path, process.pid, { waitMs: 100, probe: probe(Date.now() - 5_000) })
      assert.deepEqual((await lockClaims(path)).map((c) => c.pid), [process.pid], 'the recycled claim was removed')
      await release()
    })
  })

  it('a pid reused 3 s after the claim was made is a recycled pid: its claim is taken over', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      const claimedAt = Date.now() - 3_600_000
      const old = `run.lock.4242.${randomUUID()}`
      await writeFile(join(dir, old), '')
      await utimes(join(dir, old), new Date(claimedAt), new Date(claimedAt))
      const probe: ProcessProbe = { alive: () => true, startedAt: async () => claimedAt + 3_000 }
      const release = await acquireLock(path, process.pid, { waitMs: 100, probe })
      assert.deepEqual((await lockClaims(path)).map((c) => c.pid), [process.pid], 'the recycled claim was removed')
      await release()
    })
  })

  it('a ps answer that arrives late does not move the start later', async () => {
    let clock = 1_000_000_000
    // ps reports 1 h elapsed, but its answer reaches us a minute after it was asked for.
    const slowPs: Ps = (_pid, done) => {
      clock += 60_000
      done('   01:00:00\n')
    }
    assert.equal(await psStartedAt(4242, slowPs, () => clock), 1_000_000_000 - 3_600_000)
  })

  it('the system probe reads a real process start time, so an old claim on this pid is taken over', async () => {
    const started = await systemProbe.startedAt(process.pid)
    assert.ok(started !== undefined && Math.abs(started - (Date.now() - process.uptime() * 1000)) < 3_000, String(started))
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      const old = `run.lock.${process.pid}.${randomUUID()}`
      await writeFile(join(dir, old), '')
      await utimes(join(dir, old), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
      await (await acquireLock(path, process.pid, { waitMs: 100 }))()
      assert.deepEqual(await readdir(dir), [])
    })
  })

  it('the claim first in line keeps looking while a later rival is slow to withdraw, then holds', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      const rival = `run.lock.${process.pid}.${randomUUID()}`
      await writeFile(join(dir, rival), '')
      await utimes(join(dir, rival), new Date(), new Date(Date.now() + 3_600_000))
      setTimeout(() => void rm(join(dir, rival)), 300)
      const release = await acquireLock(path, process.pid, { waitMs: 5_000 })
      assert.deepEqual((await lockClaims(path)).map((c) => c.name).includes(rival), false)
      await release()
    })
  })

  it('the claim first in line stays put while it waits, instead of withdrawing and claiming again', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      const rival = `run.lock.${process.pid}.${randomUUID()}`
      await writeFile(join(dir, rival), '')
      await utimes(join(dir, rival), new Date(), new Date(Date.now() + 3_600_000))
      const trying = assert.rejects(acquireLock(path, process.pid, { waitMs: 600 }), LockedError)
      const mine = async () => (await readdir(dir)).filter((n) => n !== rival)
      await new Promise((r) => setTimeout(r, 100))
      const first = await mine()
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(await mine(), first)
      assert.equal(first.length, 1)
      await trying
      assert.deepEqual(await readdir(dir), [rival])
    })
  })

  it('rivals arriving together all get the run lock in turn instead of all stepping back', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      const holders = new Set<number>()
      let overlap = false
      await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const release = await acquireLock(path, process.pid, { waitMs: 10_000 })
          if (holders.size > 0) overlap = true
          holders.add(i)
          await new Promise((r) => setTimeout(r, 10))
          holders.delete(i)
          await release()
        }),
      )
      assert.equal(overlap, false, 'two held the lock at once')
      assert.deepEqual(await readdir(dir), [])
    })
  })
})
