// Test helpers: temporary stores, GitHub star payloads and X rows with a fake browser.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { RawStar } from '../collect/github.ts'
import { collectGithub } from '../collect/github.ts'
import { collectX, type OpenXBrowser, type RawRow, type XList } from '../collect/x.ts'
import { saveCategoriesTable } from '../core/store.ts'
import type { CategoryTable } from '../core/types.ts'

/** A fixed table for tests, independent of the default one `categories init` writes, so its names can change freely. */
export const TEST_CATEGORIES: CategoryTable = {
  schemaVersion: 1,
  categories: [
    { name: 'Agent 技能/插件', description: 'Skills, plugins, MCP servers, rules and extensions for AI coding agents' },
    { name: '库与框架', description: 'Libraries, SDKs and frameworks used from code' },
    { name: 'CLI 与开发工具', description: 'Command-line tools, developer tooling, editors, build and test tools' },
    { name: '应用', description: 'End-user applications: desktop, web, mobile apps and self-hosted services' },
    { name: '模型与数据集', description: 'AI models, weights, datasets and benchmarks' },
    { name: '教程与观点', description: 'Tutorials, courses, guides, books, articles and opinions' },
    { name: '资料合集', description: 'Awesome lists, curated collections, prompt and resource collections' },
    { name: '未分类', description: 'Anything that does not fit the other Categories' },
  ],
}

export function star(
  fullName: string,
  over: Partial<NonNullable<RawStar['repo']>> & { starred_at?: string } = {},
): RawStar {
  const { starred_at, ...repo } = over
  return {
    starred_at: starred_at ?? '2026-11-01T00:00:00Z',
    repo: {
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      description: `${fullName} description`,
      language: 'TypeScript',
      topics: ['cli'],
      stargazers_count: 10,
      private: false,
      archived: false,
      ...repo,
    },
  }
}

export async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'starsieve-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A store with TEST_CATEGORIES and the given stars collected. */
export async function seedStore(dir: string, stars: RawStar[]): Promise<string> {
  const store = join(dir, 'store')
  await collectGithub(store, async () => stars)
  await saveCategoriesTable(store, TEST_CATEGORIES)
  return store
}

/** Every file under `dir` with its content, to assert that nothing was written. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    out[relative(dir, path)] = await readFile(path, 'utf8')
  }
  return out
}

export const FAKE_AGENT = new URL('./fake-agent.js', import.meta.url).pathname

/** One `article` as the browser script reads it. */
export function xRaw(statusId: string, over: Partial<RawRow> & { author?: string } = {}): RawRow {
  const { author = 'dev', ...rest } = over
  const path = `/${author}/status/${statusId}`
  return {
    hrefs: [`/${author}`, path, `${path}/analytics`],
    timeHref: path,
    datetime: '2026-11-10T00:00:00.000Z',
    text: `post ${statusId} about TypeScript`,
    hasMediaElement: false,
    ...rest,
  }
}

/**
 * A stand-in for the ego-browser session. `pages[list][0]` is what load returns, each later entry what one
 * scroll returns; past the end, scrolls keep returning the last entry (nothing new). `calls` records every call.
 */
export function fakeXBrowser(
  pages: Partial<Record<XList, RawRow[][]>>,
  over: { failOnScroll?: number; error?: Error } = {},
): { open: OpenXBrowser; calls: string[] } {
  const calls: string[] = []
  let list: XList = 'likes'
  let step = 0
  let scrolls = 0
  const at = (i: number) => {
    const p = pages[list] ?? [[]]
    return p[Math.min(i, p.length - 1)] ?? []
  }
  const open: OpenXBrowser = async () => {
    calls.push('open')
    return {
      async load(l) {
        calls.push(`load ${l}`)
        list = l
        step = 0
        const rows = at(0)
        return { rows, empty: rows.length === 0 }
      },
      async scroll() {
        scrolls++
        calls.push('scroll')
        if (over.failOnScroll === scrolls) throw over.error ?? new Error('net::ERR_NETWORK_CHANGED')
        step++
        return at(step)
      },
      async close() {
        calls.push('close')
      },
    }
  }
  return { open, calls }
}

/** A store with TEST_CATEGORIES, the given stars and the given X likes (one screen, no scrolls). */
export async function seedMixedStore(dir: string, stars: RawStar[], likes: RawRow[]): Promise<string> {
  const store = await seedStore(dir, stars)
  const browser = fakeXBrowser({ likes: [likes] })
  await collectX(store, {
    lists: ['likes'],
    maxScrolls: 0,
    openBrowser: browser.open,
    now: () => new Date('2026-11-20T00:00:00.000Z'),
  })
  return store
}
