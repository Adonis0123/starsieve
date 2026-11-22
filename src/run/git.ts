// The git calls run makes in the Private Store's repository and in the public repository's local clone.
import { exec, tail } from './exec.ts'

export class GitError extends Error {}

/** Runs git in `cwd`; a non-zero exit throws GitError with git's own message. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const r = await exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (r.code !== 0) throw new GitError(`git ${args.join(' ')} (in ${cwd}) failed: ${tail(r)}`)
  return r.stdout
}

/** Like git(), but a non-zero exit is false. */
export async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  const r = await exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return r.code === 0
}

export async function topLevel(dir: string): Promise<string> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    throw new GitError(`${dir} is not inside a git repository; clone the repository there first`)
  }
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return gitOk(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

export async function revParse(repo: string, ref: string): Promise<string | undefined> {
  return (await refExists(repo, ref)) ? (await git(repo, ['rev-parse', `${ref}^{commit}`])).trim() : undefined
}

/** The file at `ref`, or undefined when the ref or the file does not exist. */
export async function showFile(repo: string, ref: string, path: string): Promise<string | undefined> {
  const r = await exec('git', ['show', `${ref}:${path}`], { cwd: repo })
  return r.code === 0 ? r.stdout : undefined
}

/** Paths with changes (staged, unstaged or untracked) under `pathspec`. */
export async function changedPaths(repo: string, pathspec: readonly string[] = []): Promise<string[]> {
  const out = await git(repo, ['status', '--porcelain', '--untracked-files=all', '--', ...pathspec])
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
}

/** Stages `pathspec` and commits when anything changed; returns the new commit, or undefined when nothing changed. */
export async function commitPaths(repo: string, pathspec: readonly string[], message: string): Promise<string | undefined> {
  await git(repo, ['add', '-A', '--', ...pathspec])
  if (await gitOk(repo, ['diff', '--cached', '--quiet', '--', ...pathspec])) return undefined
  await git(repo, ['commit', '--quiet', '--no-verify', '-m', message, '--', ...pathspec])
  return (await git(repo, ['rev-parse', 'HEAD'])).trim()
}

export async function currentBranch(repo: string): Promise<string | undefined> {
  const r = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo })
  return r.code === 0 ? r.stdout.trim() : undefined
}

export async function originUrl(repo: string): Promise<string | undefined> {
  const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repo })
  return r.code === 0 ? r.stdout.trim() : undefined
}

/** Every URL `git fetch origin` and `git push origin` use: all fetch URLs, and all push URLs (`pushurl`, else the URL). */
export async function originUrls(repo: string): Promise<string[]> {
  const urls: string[] = []
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
    const r = await exec('git', args, { cwd: repo })
    if (r.code === 0) urls.push(...r.stdout.split('\n').map((u) => u.trim()).filter(Boolean))
  }
  return [...new Set(urls)]
}

/** `owner/name` from a github.com remote URL (https or ssh), else undefined. */
export function githubSlug(url: string | undefined): string | undefined {
  const m = /github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url ?? '')
  return m ? `${m[1]}/${m[2]}` : undefined
}
