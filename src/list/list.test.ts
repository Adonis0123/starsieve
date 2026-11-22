// list: read-only search over the store through the CLI, with Classifications and Skipped Items seeded directly.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { main } from '../cli/main.ts'
import { saveClassifications, saveSkipped } from '../core/store.ts'
import type { Classification } from '../core/types.ts'
import { seedMixedStore, snapshot, star, withDir, xRaw } from '../testing/fixtures.ts'

const LONG = `${'agent '.repeat(30)}tail-that-must-not-appear`

function cls(over: Partial<Classification> = {}): Classification {
  return {
    category: '库与框架',
    tags: [],
    summary: '',
    visibility: 'public',
    needsReview: false,
    locked: false,
    by: 'classifier',
    inputHash: 'h',
    ...over,
  }
}

async function seed(dir: string): Promise<string> {
  const store = await seedMixedStore(
    dir,
    [
      star('acme/alpha', { starred_at: '2026-11-01T00:00:00Z', topics: ['mcp'], description: 'a server', stargazers_count: 7 }),
      star('acme/beta', { starred_at: '2026-11-05T00:00:00Z', topics: [], description: 'agent runtime' }),
      star('acme/gamma', { starred_at: '2026-11-03T00:00:00Z', topics: [], description: 'plain' }),
    ],
    [xRaw('111', { author: 'alice', text: LONG }), xRaw('222', { author: 'bob', text: 'mcp tips' })],
  )
  await saveClassifications(store, {
    'github:acme/alpha': cls({ summary: 'TypeScript toolkit', tags: ['agent'] }),
    'github:acme/beta': cls({ category: '应用', visibility: 'private', needsReview: true, locked: true }),
    'x:111': cls({ category: '应用', summary: 'thread' }),
  })
  await saveSkipped(store, { 'x:222': { skippedAt: '2026-11-20T00:00:00.000Z' } })
  return store
}

async function list(store: string, ...args: string[]) {
  let out = ''
  const code = await main(['list', '--store', store, ...args], { io: { out: (s) => (out += `${s}\n`), err: () => {} } })
  return { code, out, json: args.includes('--json') ? (JSON.parse(out) as Record<string, any>) : {} }
}

const ids = (j: Record<string, any>) => (j.items as { id: string }[]).map((i) => i.id)

describe('list', () => {
  it('prints the envelope, newest first, without Skipped Items, and writes nothing', async () => {
    await withDir(async (dir) => {
      const store = await seed(dir)
      const before = await snapshot(store)
      const r = await list(store, '--json')
      assert.equal(r.code, 0)
      assert.deepEqual([r.json.schemaVersion, r.json.ok, r.json.command, r.json.total], [1, true, 'list', 4])
      assert.deepEqual(ids(r.json), ['x:111', 'github:acme/beta', 'github:acme/gamma', 'github:acme/alpha'])
      const gamma = r.json.items.find((i: { id: string }) => i.id === 'github:acme/gamma')
      assert.deepEqual([gamma.category, gamma.visibility, gamma.needsReview, gamma.locked], [null, null, false, false])
      assert.equal(r.json.items.find((i: { id: string }) => i.id === 'github:acme/alpha').stargazers, 7)
      assert.deepEqual(await snapshot(store), before)
    })
  })

  it('q needs every word, in any field, ignoring case', async () => {
    await withDir(async (dir) => {
      const store = await seed(dir)
      // A word found only in a topic.
      assert.deepEqual(ids((await list(store, '--q', 'MCP', '--json')).json), ['github:acme/alpha'])
      // Two words in different fields: topic and summary.
      assert.deepEqual(ids((await list(store, '--q', 'mcp toolkit', '--json')).json), ['github:acme/alpha'])
      // Tags, description and X text all count.
      assert.deepEqual(ids((await list(store, '--q', 'agent', '--json')).json), ['x:111', 'github:acme/beta', 'github:acme/alpha'])
      // The second word misses.
      assert.deepEqual(ids((await list(store, '--q', 'mcp nowhere', '--json')).json), [])
      // Author.
      assert.deepEqual(ids((await list(store, '--q', 'ALICE', '--json')).json), ['x:111'])
    })
  })

  it('filters by category, source, visibility and needs-review; unclassified Items match none of them', async () => {
    await withDir(async (dir) => {
      const store = await seed(dir)
      assert.deepEqual(ids((await list(store, '--category', '应用', '--json')).json), ['x:111', 'github:acme/beta'])
      assert.deepEqual(ids((await list(store, '--source', 'x', '--json')).json), ['x:111'])
      assert.deepEqual(ids((await list(store, '--visibility', 'public', '--json')).json), ['x:111', 'github:acme/alpha'])
      assert.deepEqual(ids((await list(store, '--visibility', 'private', '--json')).json), ['github:acme/beta'])
      assert.deepEqual(ids((await list(store, '--needs-review', '--json')).json), ['github:acme/beta'])
      assert.equal((await list(store, '--visibility', 'secret', '--json')).code, 2)
      assert.equal((await list(store, '--source', 'mastodon', '--json')).code, 2)
    })
  })

  it('limit caps items while total counts every match', async () => {
    await withDir(async (dir) => {
      const store = await seed(dir)
      const r = await list(store, '--limit', '2', '--json')
      assert.deepEqual([r.json.total, ids(r.json)], [4, ['x:111', 'github:acme/beta']])
      assert.equal((await list(store, '--limit', '0', '--json')).code, 2)
    })
  })

  it('gives an X post a 120-character excerpt, never its text', async () => {
    await withDir(async (dir) => {
      const store = await seed(dir)
      const r = await list(store, '--source', 'x', '--json')
      const x = r.json.items[0]
      assert.equal('text' in x, false)
      assert.equal(x.excerpt.length, 120)
      assert.equal(x.url, 'https://x.com/alice/status/111')
      assert.equal(r.out.includes('tail-that-must-not-appear'), false)
    })
  })

  it('prints one line per Item without --json', async () => {
    await withDir(async (dir) => {
      const store = await seed(dir)
      const r = await list(store, '--q', 'agent')
      const lines = r.out.trim().split('\n')
      assert.equal(lines.length, 4)
      assert.match(lines[0]!, /^x:111\t@alice /)
      assert.equal(lines[3], '3 of 3 shown')
      assert.equal(r.out.includes('tail-that-must-not-appear'), false)
    })
  })
})
