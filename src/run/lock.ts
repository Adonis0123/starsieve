// Locks made of claim files. `acquireLock`: one run at a time on this machine, retrying briefly. `withLock`: waits for
// the lock longer (the store write lock, held only for one read-modify-write).
// A process claims the lock at `path` by creating its own empty file `<path>.<pid>.<uuid>`, then listing the
// directory: it holds the lock when no claim of another live process is there. A claim whose process is gone is
// removed by its exact name, so taking over a dead process's lock can never remove a claim someone else just made
// (unlike stat-then-remove on one shared file, where two processes can each remove the stale lock and both end up
// holding a new one). This relies on a directory listing showing every file created before the listing started (true
// of local file systems). proper-lockfile 4.1.2 is not used: its stale takeover is that same stat → rmdir → mkdir.
// When live claims meet, the earliest (mtime, then name) stays and looks again; the others withdraw and retry later,
// so contention ends with one holder instead of everyone stepping back.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export class LockedError extends Error {}

/** How often a claim that is first in line looks again. */
const SETTLE_MS = 15
/** Claims younger than this are not checked for pid reuse: their pid cannot have been recycled yet. */
const REUSE_AGE_MS = 10_000
/** A live pid whose process started more than this after the claim was made did not make it: ps truncates to whole seconds, so a start read by `psStartedAt` is at most 1 s late. */
const START_SLACK_MS = 2_000

const CLAIM = /^(\d+)\.[0-9a-f-]{36}$/

/** How a lock tells whether a claim's process still exists. Injectable so tests can fake a recycled pid. */
export interface ProcessProbe {
  alive(pid: number): boolean
  /** When the process `pid` started, in ms since the epoch; undefined when that cannot be told. */
  startedAt(pid: number): Promise<number | undefined>
}

export const systemProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  startedAt: (pid) => psStartedAt(pid),
}

/** Runs ps for `pid` and hands over its output, or undefined on any failure. */
export type Ps = (pid: number, done: (out: string | undefined) => void) => void

// `ps -o etime=` is POSIX: elapsed time as [[dd-]hh:]mm:ss. Without ps (Windows) or on any failure: undefined.
const runPs: Ps = (pid, done) =>
  void execFile('ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 2000 }, (err, out) => done(err ? undefined : out))

/**
 * When `pid` started, from ps's elapsed time. The reference time is read before ps samples it, so a late callback
 * (event-loop stall, machine sleep) only makes the start earlier: a live claimant is never mistaken for a recycled pid.
 */
export function psStartedAt(pid: number, ps: Ps = runPs, now: () => number = Date.now): Promise<number | undefined> {
  const ref = now()
  return new Promise((done) => {
    ps(pid, (out) => {
      const m = out === undefined ? null : /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(out)
      if (!m) return done(undefined)
      const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number]
      done(ref - (((d * 24 + h) * 60 + min) * 60 + s) * 1000)
    })
  })
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

interface Live {
  name: string
  pid: number
  at: number
}

const before = (a: Live, b: Live) => a.at < b.at || (a.at === b.at && a.name < b.name)

interface Attempt {
  pid: number
  until: number
  probe: ProcessProbe
  /** Claims already found to be no recycled pid's, so ps runs once per claim per acquire. */
  checked: Set<string>
}

/**
 * The other live claims, with their creation times; dead ones are removed by name. Every doubt (no ps, a failed stat)
 * counts as live: calling a live claim dead would let two processes hold the lock.
 */
async function liveClaims(path: string, mine: string, a: Attempt): Promise<Live[]> {
  const dir = dirname(path)
  const live: Live[] = []
  for (const c of await lockClaims(path)) {
    if (c.name === mine) continue
    let dead = !a.probe.alive(c.pid)
    let at = Number.NEGATIVE_INFINITY
    if (!dead) {
      const s = await stat(join(dir, c.name)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined))
      if (s === null) continue // withdrawn meanwhile
      if (s) at = s.mtimeMs
      if (s && !a.checked.has(c.name) && Date.now() - at >= REUSE_AGE_MS) {
        const started = await a.probe.startedAt(c.pid)
        dead = started !== undefined && started > at + START_SLACK_MS
        if (!dead) a.checked.add(c.name)
      }
    }
    if (dead) await rm(join(dir, c.name), { force: true })
    else live.push({ ...c, at })
  }
  return live
}

/**
 * One claim. Returns the release function, or a description of who holds the lock. Only a listing with no other live
 * claim means held. While other live claims are there, the claim first in line looks again until `until`; any other
 * withdraws at once.
 */
async function tryAcquire(path: string, a: Attempt): Promise<(() => Promise<void>) | string> {
  const dir = dirname(path)
  const name = `${basename(path)}.${a.pid}.${randomUUID()}`
  const release = () => rm(join(dir, name), { force: true })
  let mine: Live
  try {
    // Created empty and never written, so every observer reads the same mtime for it.
    const fh = await open(join(dir, name), 'wx')
    try {
      mine = { name, pid: a.pid, at: (await fh.stat()).mtimeMs }
    } finally {
      await fh.close()
    }
  } catch (e) {
    // A claim that failed half way must not stay behind and block every later run.
    await release().catch(() => {})
    throw e
  }
  try {
    for (;;) {
      const others = await liveClaims(path, name, a)
      if (others.length === 0) return release
      const first = others.reduce((x, y) => (before(y, x) ? y : x))
      if (before(first, mine) || Date.now() >= a.until) {
        await release()
        return `pid ${first.pid}`
      }
      await new Promise((done) => setTimeout(done, SETTLE_MS))
    }
  } catch (e) {
    await release()
    throw e
  }
}

export interface LockOptions {
  /** How long to keep trying before throwing LockedError. */
  waitMs?: number
  /** The mean pause between tries; each pause is jittered. */
  pollMs?: number
  probe?: ProcessProbe
}

async function acquire(path: string, pid: number, waitMs: number, options: LockOptions) {
  const pollMs = options.pollMs ?? 25
  await mkdir(dirname(path), { recursive: true })
  const a: Attempt = { pid, until: Date.now() + waitMs, probe: options.probe ?? systemProbe, checked: new Set() }
  for (;;) {
    const r = await tryAcquire(path, a)
    if (typeof r === 'function' || Date.now() >= a.until) return r
    await new Promise((done) => setTimeout(done, pollMs * (0.5 + Math.random())))
  }
}

/** Takes the lock, trying for up to `waitMs` (default 1 s), or throws LockedError; the returned function releases it. */
export async function acquireLock(path: string, pid = process.pid, options: LockOptions = {}): Promise<() => Promise<void>> {
  const r = await acquire(path, pid, options.waitMs ?? 1000, options)
  if (typeof r === 'function') return r
  throw new LockedError(`another starsieve run (${r}) holds ${path}; only one run at a time`)
}

/** Runs `fn` holding the lock at `path`, waiting up to `waitMs` (default 30 s) for it. Not reentrant: never nest two on one path. */
export async function withLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? 30_000
  const r = await acquire(path, process.pid, waitMs, options)
  if (typeof r !== 'function') throw new LockedError(`${path} is held by ${r} for over ${Math.round(waitMs / 1000)} s; try again`)
  try {
    return await fn()
  } finally {
    await r()
  }
}
