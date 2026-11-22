// Locks made of claim files. `acquireLock`: one run at a time on this machine. `withLock`: waits for the lock instead
// (the store write lock, held only for one read-modify-write).
// A process claims the lock at `path` by creating its own file `<path>.<pid>.<uuid>`, then listing the directory: it
// holds the lock when no claim of another live process is there. A claim whose pid is gone is removed by its exact
// name, so taking over a dead process's lock can never remove a claim someone else just made (unlike stat-then-remove
// on one shared file, where two processes can each remove the stale lock and both end up holding a new one).
// This relies on a directory listing showing every file created before the listing started (true of local file
// systems). proper-lockfile 4.1.2 is not used: its stale takeover is that same stat → rmdir → mkdir sequence.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export class LockedError extends Error {}

/** When claimants arrive together, the lowest claim looks again this many times before giving up. */
const SETTLE_TRIES = 10
const SETTLE_MS = 15

const CLAIM = /^(\d+)\.[0-9a-f-]{36}$/

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The claim files of the lock at `path`, with their pids. */
export async function lockClaims(path: string): Promise<{ name: string; pid: number }[]> {
  const prefix = `${basename(path)}.`
  // Only a missing directory means no claims; any other listing error throws, so a lock is never taken unseen.
  const names = await readdir(dirname(path)).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[]
    throw e
  })
  return names.flatMap((name) => {
    const m = name.startsWith(prefix) ? CLAIM.exec(name.slice(prefix.length)) : null
    return m ? [{ name, pid: Number(m[1]) }] : []
  })
}

/**
 * One try. Returns the release function, or a description of who holds the lock. With other live claims present the
 * claim is withdrawn; when they all arrived at the same moment, the lowest name stays a little and looks again while
 * the others withdraw, so one of them gets the lock. Only a listing with no other live claim means held.
 */
async function tryAcquire(path: string, pid: number): Promise<(() => Promise<void>) | string> {
  const dir = dirname(path)
  const mine = `${basename(path)}.${pid}.${randomUUID()}`
  const release = () => rm(join(dir, mine), { force: true })
  try {
    await writeFile(join(dir, mine), `${pid}\n`, { flag: 'wx' })
  } catch (e) {
    // A claim created but not fully written (ENOSPC) must not stay behind and block every later run.
    await release().catch(() => {})
    throw e
  }
  try {
    for (let attempt = 0; ; attempt++) {
      const others: { name: string; pid: number }[] = []
      for (const c of await lockClaims(path)) {
        if (c.name === mine) continue
        if (alive(c.pid)) others.push(c)
        else await rm(join(dir, c.name), { force: true })
      }
      if (others.length === 0) return release
      if (attempt >= SETTLE_TRIES || others.some((c) => c.name < mine)) {
        await release()
        return `pid ${others[0]!.pid}`
      }
      await new Promise((done) => setTimeout(done, SETTLE_MS))
    }
  } catch (e) {
    await release()
    throw e
  }
}

/** Takes the lock or throws LockedError; the returned function releases it. */
export async function acquireLock(path: string, pid = process.pid): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true })
  const r = await tryAcquire(path, pid)
  if (typeof r === 'function') return r
  throw new LockedError(`another starsieve run (${r}) holds ${path}; only one run at a time`)
}

export interface WithLockOptions {
  /** How long to wait for the lock before throwing LockedError. */
  waitMs?: number
  pollMs?: number
}

/** Runs `fn` holding the lock at `path`, waiting up to `waitMs` for it. Not reentrant: never nest two on one path. */
export async function withLock<T>(path: string, fn: () => Promise<T>, options: WithLockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? 30_000
  const pollMs = options.pollMs ?? 25
  await mkdir(dirname(path), { recursive: true })
  const until = Date.now() + waitMs
  for (;;) {
    const r = await tryAcquire(path, process.pid)
    if (typeof r === 'function') {
      try {
        return await fn()
      } finally {
        await r()
      }
    }
    if (Date.now() >= until) throw new LockedError(`${path} is held by ${r} for over ${Math.round(waitMs / 1000)} s; try again`)
    await new Promise((done) => setTimeout(done, pollMs))
  }
}
