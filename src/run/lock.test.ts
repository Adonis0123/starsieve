// Lock files: a dead pid's lock is taken over, a live one holds, rivals at a stale lock get it once, withLock waits.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withDir } from '../testing/fixtures.ts'
import { acquireLock, LockedError, lockClaims, withLock } from './lock.ts'

const RIVAL = new URL('../testing/lock-rival.ts', import.meta.url).pathname

describe('lock', () => {
  it('a dead pid is taken over, a live holder holds, and release leaves no file behind', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      await acquireLock(path, 999_999)
      assert.deepEqual((await lockClaims(path)).map((c) => c.pid), [999_999])
      const release = await acquireLock(path)
      assert.deepEqual((await lockClaims(path)).map((c) => c.pid), [process.pid], 'the dead claim was removed')
      await assert.rejects(acquireLock(path), LockedError)
      await release()
      assert.deepEqual(await readdir(dir), [])
    })
  })

  it('rivals arriving together at a stale lock: exactly one gets it, every time', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'run.lock')
      for (let round = 0; round < 20; round++) {
        await acquireLock(path, 999_999)
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(path)))
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
      // A live rival claimed the lock after a dead process left its claim: the rival's name sorts lowest, then highest,
      // to cover both "step back at once" and "look again, then give up".
      for (const uuid of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
        await writeFile(join(dir, `run.lock.999999.${randomUUID()}`), '999999\n')
        const rival = `run.lock.${process.pid}.${uuid}`
        await writeFile(join(dir, rival), `${process.pid}\n`)
        await assert.rejects(acquireLock(path), LockedError)
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
        await assert.rejects(acquireLock(path), /EACCES/)
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
})
