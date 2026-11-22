// Test helpers for run and lists sync: two local bare repositories as the remotes, a working clone of each, a store
// inside the private clone, and a fake `gh` that records every call and answers GraphQL from fixture lists.
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { collectGithub, type RawStar } from '../collect/github.ts'
import { writeJson } from '../core/json.ts'
import { paths, saveCategoriesTable } from '../core/store.ts'
import { initData } from '../init/init.ts'
import type { Exec, ExecResult } from '../run/exec.ts'
import { FAKE_AGENT, TEST_CATEGORIES } from './fixtures.ts'

const run = promisify(execFile)

export async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd })
  return stdout
}

async function newClone(dir: string, name: string): Promise<{ bare: string; clone: string }> {
  const bare = join(dir, `${name}.git`)
  const clone = join(dir, name)
  await run('git', ['init', '--quiet', '--bare', '-b', 'main', bare])
  await run('git', ['init', '--quiet', '-b', 'main', clone])
  await gitIn(clone, 'config', 'user.name', 'starsieve test')
  await gitIn(clone, 'config', 'user.email', 'test@example.invalid')
  await gitIn(clone, 'config', 'commit.gpgsign', 'false')
  await gitIn(clone, 'remote', 'add', 'origin', bare)
  return { bare, clone }
}

export interface Repos {
  dir: string
  privateBare: string
  publicBare: string
  /** The private clone; the store is its root. */
  store: string
  pub: string
  css: string
}

/** Both remotes with an initial main (templates from `init data`), a store with these stars and the fake Classifier. */
export async function makeRepos(dir: string, stars: RawStar[], agentMode = 'ok'): Promise<Repos> {
  const p = await newClone(dir, 'private')
  const q = await newClone(dir, 'public')
  await collectGithub(p.clone, async () => stars)
  await saveCategoriesTable(p.clone, TEST_CATEGORIES)
  await writeJson(paths.config(p.clone), {
    schemaVersion: 1,
    classifier: { command: ['node', FAKE_AGENT, agentMode, '{prompt}'], timeoutMs: 20_000 },
  })
  await initData({ privateDir: p.clone, publicDir: q.clone })
  for (const clone of [p.clone, q.clone]) {
    await gitIn(clone, 'add', '-A')
    await gitIn(clone, 'commit', '--quiet', '-m', 'initial')
    await gitIn(clone, 'push', '--quiet', '-u', 'origin', 'main')
  }
  const css = join(dir, 'local-tools.css')
  await writeFile(css, ':root { --kit-bg: #fff; }\n')
  return { dir, privateBare: p.bare, publicBare: q.bare, store: p.clone, pub: q.clone, css }
}

export interface FakeList {
  id: string
  name: string
  repos: { id: string; nameWithOwner: string }[]
}

export interface GhCall {
  args: string[]
  input?: string
}

/** A fake `gh`: GraphQL for Lists (viewer.lists, repository lookups, createUserList, updateUserListsForItem) and PRs. */
export function fakeGh(
  lists: FakeList[] = [],
  over: {
    prState?: string
    failListsRead?: boolean
    pageSize?: number
    /** What `gh pr list` answers. */
    prList?: Record<string, unknown>[]
    /** The PR's head commit as GitHub sees it (`gh pr view --json headRefOid`); tests read the bare remote's branch. */
    prHead?: () => Promise<string | undefined>
    /** The PR's head repository: `o` (the public repository's owner) and not cross-repository unless set. */
    prHeadRepo?: { isCrossRepository: boolean; owner: string }
  } = {},
): { exec: Exec; calls: GhCall[]; mutations: { query: string; variables: Record<string, unknown> }[] } {
  const calls: GhCall[] = []
  const mutations: { query: string; variables: Record<string, unknown> }[] = []
  const ok = (data: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' })
  const pageSize = over.pageSize ?? 100
  const itemsPage = (l: FakeList, after: string | null) => {
    const start = after ? Number(after) : 0
    const slice = l.repos.slice(start, start + pageSize)
    const next = start + pageSize < l.repos.length
    return {
      pageInfo: { hasNextPage: next, endCursor: next ? String(start + pageSize) : null },
      nodes: slice.map((r) => ({ __typename: 'Repository', ...r })),
    }
  }
  const exec: Exec = async (_cmd, args, options = {}) => {
    calls.push({ args: [...args], input: options.input })
    if (args[0] === 'api' && args[1] === 'graphql') {
      const body = JSON.parse(options.input ?? '{}') as { query: string; variables: Record<string, unknown> }
      const q = body.query
      if (q.startsWith('mutation')) {
        mutations.push(body)
        if (q.includes('createUserList')) {
          const name = String(body.variables.name)
          lists.push({ id: `L_${name}`, name, repos: [] })
          return ok({ data: { createUserList: { list: { id: `L_${name}`, name } } } })
        }
        return ok({ data: {} })
      }
      if (q.includes('viewer { lists')) {
        if (over.failListsRead) return { code: 1, stdout: '', stderr: 'HTTP 502' }
        return ok({
          data: {
            viewer: {
              lists: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: lists.map((l) => ({ id: l.id, name: l.name, items: itemsPage(l, null) })),
              },
            },
          },
        })
      }
      if (q.includes('node(id: $id)')) {
        const l = lists.find((x) => x.id === body.variables.id)!
        return ok({ data: { node: { items: itemsPage(l, String(body.variables.after)) } } })
      }
      // repository lookups: r0: repository(owner: "a", name: "b")
      const data: Record<string, unknown> = {}
      for (const m of q.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        data[m[1]!] = m[3] === 'gone' ? null : { id: `R_${m[2]}/${m[3]}`, nameWithOwner: `${m[2]}/${m[3]}` }
      }
      return ok({ data })
    }
    if (args[0] === 'pr' && args[1] === 'list') return ok(over.prList ?? [])
    if (args[0] === 'pr' && args[1] === 'create') return { code: 0, stdout: 'https://github.com/o/stars/pull/7\n', stderr: '' }
    if (args[0] === 'pr' && args[1] === 'merge') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'pr' && args[1] === 'view') {
      const repo = over.prHeadRepo ?? { isCrossRepository: false, owner: 'o' }
      return ok({
        state: over.prState ?? 'MERGED',
        headRefOid: await over.prHead?.(),
        isCrossRepository: repo.isCrossRepository,
        headRepositoryOwner: { login: repo.owner },
      })
    }
    return { code: 1, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}` }
  }
  return { exec, calls, mutations }
}
