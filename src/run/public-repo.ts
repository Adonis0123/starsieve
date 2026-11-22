// The public repository's local clone: which branch a run publishes on, what main holds now, and pushing it.
import { access, mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PublicDoc } from '../publish/projection.ts'
import { exec, tail } from './exec.ts'
import { git, gitOk, refExists, revParse, showFile } from './git.ts'

export const BRANCH_PREFIX = 'starsieve/'
export const ITEMS_FILE = 'data/items.json'
/** Everything `run` writes into the public repository; the required check allows nothing else. */
export const PUBLIC_PATHS = ['data', 'README.md', 'docs'] as const

/** `origin/main` when the clone has it, else `main`. */
export async function baseRef(repo: string): Promise<string> {
  if (await refExists(repo, 'origin/main')) return 'origin/main'
  if (await refExists(repo, 'main')) return 'main'
  throw new Error(`${repo} has no main branch; push an initial commit to main first (see "starsieve init data")`)
}

export async function readPublicDoc(repo: string, ref: string): Promise<PublicDoc | undefined> {
  const text = await showFile(repo, ref, ITEMS_FILE)
  if (text === undefined) return undefined
  try {
    const doc = JSON.parse(text) as PublicDoc
    return Array.isArray(doc?.items) ? doc : undefined
  } catch {
    return undefined
  }
}

export interface BranchChoice {
  branch: string
  /** Where the branch starts: its own tip when reused, else the base. */
  from: string
  reused: boolean
}

/** The branch was pushed before: run pushes with `-u`, so its upstream is the same-named branch on origin. */
export async function pushedBefore(repo: string, branch: string): Promise<boolean> {
  const r = await exec('git', ['config', '--get', `branch.${branch}.merge`], { cwd: repo })
  return r.code === 0 && r.stdout.trim() === `refs/heads/${branch}`
}

/**
 * An open PR's branch is reused. Otherwise `starsieve/YYYYMMDD` (then `-2`, `-3`, …): a local branch that was never
 * pushed, or has commits its remote branch lacks, is reused; one that was pushed and has no open PR (merged or closed)
 * is done, so the next name is taken.
 */
export async function pickBranch(repo: string, day: string, base: string, openPrBranch?: string): Promise<BranchChoice> {
  if (openPrBranch) {
    const remote = `origin/${openPrBranch}`
    const from = (await refExists(repo, openPrBranch)) ? openPrBranch : (await refExists(repo, remote)) ? remote : base
    return { branch: openPrBranch, from, reused: from !== base }
  }
  for (let n = 1; n < 100; n++) {
    const branch = `${BRANCH_PREFIX}${day}${n === 1 ? '' : `-${n}`}`
    const local = await revParse(repo, branch)
    const remote = await revParse(repo, `origin/${branch}`)
    if (local) {
      if (!(await pushedBefore(repo, branch))) return { branch, from: branch, reused: true }
      if (remote && remote !== local && (await gitOk(repo, ['merge-base', '--is-ancestor', remote, local]))) {
        return { branch, from: branch, reused: true }
      }
      continue
    }
    if (remote) continue
    return { branch, from: base, reused: false }
  }
  throw new Error(`no free branch name for ${day}`)
}

/** Clean apart from ignored files; run never mixes the owner's edits into a published commit. */
export async function assertClean(repo: string): Promise<void> {
  const status = await git(repo, ['status', '--porcelain', '--untracked-files=all'])
  if (status.trim()) {
    throw new Error(`the public clone ${repo} has uncommitted changes; commit or stash them first:\n${status.trim().split('\n').slice(0, 5).join('\n')}`)
  }
}

/** The branch has commits that the base does not, and the remote branch lacks some of them. */
export async function needsPush(repo: string, branch: string, base: string): Promise<boolean> {
  const tip = await revParse(repo, branch)
  if (!tip || tip === (await revParse(repo, base))) return false
  return tip !== (await revParse(repo, `origin/${branch}`))
}

/** Something differs between the branch and the base in the published paths. */
export async function differsFromBase(repo: string, branch: string, base: string): Promise<boolean> {
  return !(await gitOk(repo, ['diff', '--quiet', base, branch, '--', ...PUBLIC_PATHS]))
}

/** git with a separate index file, so building a commit never touches the clone's index or working tree. */
async function gitWithIndex(repo: string, index: string, args: readonly string[], input?: string): Promise<string> {
  const r = await exec('git', args, { cwd: repo, input, env: { ...process.env, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0' } })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} (in ${repo}) failed: ${tail(r)}`)
  return r.stdout
}

/**
 * Before a push: when `branch` has more than one commit that no remote has seen (or its one commit is not on top of
 * what it would be pushed onto), they are replaced by a single commit holding the branch tip's published paths, on
 * top of origin's copy of the branch, or of the base when it was never pushed. So an earlier local commit that
 * published an Item the owner later took back never leaves the machine. What was already pushed stays as it is.
 * Throws, leaving the branch untouched, when origin's copy of the branch is not part of the local branch (they have
 * diverged), or when the unpushed commits change anything outside PUBLIC_PATHS (say a CI fix): squashing would drop
 * it. Returns the new tip, or undefined when nothing was rewritten.
 */
export async function squashUnpushed(repo: string, branch: string, base: string, message: string): Promise<string | undefined> {
  const tip = await revParse(repo, branch)
  if (!tip) return undefined
  const remote = await revParse(repo, `origin/${branch}`)
  if (remote && !(await gitOk(repo, ['merge-base', '--is-ancestor', remote, tip]))) {
    throw new Error(`${branch} and origin/${branch} have diverged; nothing was squashed or pushed. Bring them together by hand (for example rebase ${branch} onto origin/${branch}), then run again`)
  }
  const onto = remote ?? (await revParse(repo, base))
  if (!onto || tip === onto) return undefined
  const count = Number((await git(repo, ['rev-list', '--count', `${onto}..${tip}`])).trim())
  if (count === 1 && (await revParse(repo, `${tip}^`)) === onto) return undefined

  // What the unpushed commits changed (since they left `onto`'s line): only published paths may be squashed.
  const isPublished = (path: string) => PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
  const touched = (await git(repo, ['diff', '--name-only', '--no-renames', '-z', `${onto}...${tip}`])).split('\0').filter(Boolean)
  const outside = touched.filter((p) => !isPublished(p))
  if (outside.length) {
    throw new Error(
      `${branch} has unpushed commits that change files outside ${PUBLIC_PATHS.join(', ')} (${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}); squashing would drop them, so ${branch} is left as it is and nothing was pushed. Move those changes to their own branch, then run again`,
    )
  }

  const dir = await mkdtemp(join(tmpdir(), 'starsieve-index-'))
  let next: string
  try {
    // The tree of `onto` with the published paths taken from the tip instead.
    const published = (entry: string) => isPublished(entry.slice(entry.indexOf('\t') + 1))
    const entries = (ref: string) => git(repo, ['ls-tree', '-r', '-z', '--full-tree', ref]).then((o) => o.split('\0').filter(Boolean))
    const kept = (await entries(onto)).filter((e) => !published(e))
    const fresh = (await entries(tip)).filter(published)
    const index = join(dir, 'index')
    await gitWithIndex(repo, index, ['update-index', '-z', '--index-info'], [...kept, ...fresh].map((e) => `${e}\0`).join(''))
    const tree = (await gitWithIndex(repo, index, ['write-tree'])).trim()
    const ontoTree = (await git(repo, ['rev-parse', `${onto}^{tree}`])).trim()
    next = tree === ontoTree ? onto : (await git(repo, ['commit-tree', tree, '-p', onto, '-m', message])).trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // The new tip holds the old tip's published paths, and `onto`'s other files, which the branch never changed (checked
  // above). `--keep` stops instead of overwriting a local change to a file that differs.
  const current = (await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo })).stdout.trim()
  if (current === branch) await git(repo, ['reset', '--quiet', '--keep', next])
  else await git(repo, ['branch', '--quiet', '--force', branch, next])
  return next
}

/** The git blob hash of each of `paths` (relative to the repository) that exists as a file; missing ones are left out. */
export async function hashFiles(repo: string, paths: readonly string[]): Promise<Map<string, string>> {
  const present: string[] = []
  for (const p of paths) {
    if (await access(join(repo, p)).then(() => true, () => false)) present.push(p)
  }
  const hashes = new Map<string, string>()
  if (!present.length) return hashes
  const out = (await git(repo, ['hash-object', '--', ...present])).trim().split('\n')
  present.forEach((p, i) => hashes.set(p, out[i]!))
  return hashes
}

/** Every path with a change against HEAD (staged, unstaged or untracked; ignored files are not). */
async function dirtyPaths(repo: string): Promise<string[]> {
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
  return out.split('\0').filter(Boolean).map((e) => e.slice(3))
}

/**
 * After a failed run: undoes the uncommitted writes this run made, and nothing else. A changed file goes back to HEAD
 * (or is removed when HEAD lacks it) only while its content is still exactly what the run wrote (`written`: path → blob
 * hash). Every other change, including an edit the owner made to a file the run wrote, is left as it is and returned
 * in `kept`. Commits are never undone.
 */
export async function rollbackWrites(repo: string, written: ReadonlyMap<string, string>): Promise<{ reverted: string[]; kept: string[] }> {
  const dirty = await dirtyPaths(repo)
  const current = await hashFiles(repo, dirty.filter((p) => written.has(p)))
  const reverted = dirty.filter((p) => current.has(p) && current.get(p) === written.get(p))
  const kept = dirty.filter((p) => !reverted.includes(p))
  const inHead: string[] = []
  const added: string[] = []
  for (const p of reverted) (await gitOk(repo, ['cat-file', '-e', `HEAD:${p}`]) ? inHead : added).push(p)
  if (inHead.length) await git(repo, ['checkout', '--quiet', 'HEAD', '--', ...inHead])
  for (const p of added) {
    await git(repo, ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', p])
    await rm(join(repo, p), { force: true })
    // Directories the run created for the file; stops at the first one that still holds something.
    for (let d = dirname(p); d !== '.' && d !== '/'; d = dirname(d)) {
      if (!(await rmdir(join(repo, d)).then(() => true, () => false))) break
    }
  }
  return { reverted, kept }
}
