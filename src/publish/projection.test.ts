// publish: the deterministic filter. Private repositories and private Items never reach items.json or README.md.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyBatch } from '../core/apply.ts'
import { buildBatch } from '../core/batch.ts'
import { overrideItem } from '../core/override.ts'
import { loadItems } from '../core/store.ts'
import { seedMixedStore, seedStore, snapshot, star, withDir, xRaw } from '../testing/fixtures.ts'
import { buildProjection, check, contentHash, holdSources, publish } from './projection.ts'
import { collectGithub } from '../collect/github.ts'

const PUB = 'github:acme/open'
const PRIV_REPO = 'github:corp/secret-repo'
const PRIV_ITEM = 'github:acme/personal'
const UNCLASSIFIED = 'github:acme/later'

async function setup(dir: string) {
  const store = await seedStore(dir, [
    star('acme/open', { starred_at: '2026-11-01T00:00:00Z' }),
    star('acme/older', { starred_at: '2026-10-01T00:00:00Z' }),
    star('corp/secret-repo', { private: true }),
    star('acme/personal'),
    star('acme/later'),
  ])
  const batch = buildBatch(await loadItems(store), {}, 25)
  const entry = (id: string, visibility: string) => ({
    id,
    category: 'CLI 与开发工具',
    tags: ['t'],
    summary: `${id} 摘要`,
    visibility,
  })
  await applyBatch(store, {
    schemaVersion: 1,
    batchId: batch.batchId,
    items: batch.items,
    classifications: [
      entry(PUB, 'public'),
      entry('github:acme/older', 'public'),
      entry(PRIV_REPO, 'public'),
      entry(PRIV_ITEM, 'private'),
    ],
  })
  return { store, out: join(dir, 'out') }
}

describe('publish', () => {
  it('includes only public Items of public repositories that have a Classification', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const r = await publish(store, out, false)
      assert.equal(r.publicItems, 2)
      const items = await readFile(join(out, 'items.json'), 'utf8')
      const readme = await readFile(join(out, 'README.md'), 'utf8')
      const doc = JSON.parse(items) as { schemaVersion: number; items: { id: string }[] }
      assert.equal(doc.schemaVersion, 1)
      assert.deepEqual(
        doc.items.map((i) => i.id),
        [PUB, 'github:acme/older'],
      )
      for (const text of [items, readme]) {
        assert.ok(!text.includes('secret-repo'), 'private repository leaked')
        assert.ok(!text.includes('acme/personal'), 'private Item leaked')
        assert.ok(!text.includes('acme/later'), 'unclassified Item leaked')
      }
      assert.match(readme, /## CLI 与开发工具\n\n- \[acme\/open\]\(https:\/\/github.com\/acme\/open\) — /)
    })
  })

  it('keeps a private repository out even after the owner overrides it to public', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await overrideItem(store, PRIV_REPO, { visibility: 'public' })
      await publish(store, out, false)
      const items = await readFile(join(out, 'items.json'), 'utf8')
      const readme = await readFile(join(out, 'README.md'), 'utf8')
      assert.ok(!items.includes('secret-repo') && !readme.includes('secret-repo'))
    })
  })

  it('publishes nothing from the store beyond the allowlisted fields', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await publish(store, out, false)
      const doc = JSON.parse(await readFile(join(out, 'items.json'), 'utf8')) as { items: object[] }
      assert.deepEqual(Object.keys(doc.items[0]!).sort(), [
        'addedAt',
        'archived',
        'category',
        'description',
        'id',
        'language',
        'name',
        'needsReview',
        'stargazers',
        'starredAt',
        'summary',
        'tags',
        'topics',
        'url',
      ])
    })
  })

  it('--dry-run writes nothing and reports the difference; after publishing it reports none', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const storeBefore = await snapshot(store)
      const dry = await publish(store, out, true)
      assert.deepEqual(dry.added, [PUB, 'github:acme/older'])
      assert.equal(dry.identical, false)
      assert.deepEqual(await snapshot(store), storeBefore)
      await assert.rejects(readFile(join(out, 'items.json')), { code: 'ENOENT' })

      await publish(store, out, false)
      const again = await publish(store, out, true)
      assert.equal(again.identical, true)
      assert.deepEqual([again.added, again.removed, again.changed], [[], [], []])
    })
  })

  it('reports changed Items in a dry run after an override', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await publish(store, out, false)
      await overrideItem(store, PUB, { category: '应用' })
      await overrideItem(store, 'github:acme/older', { visibility: 'private' })
      const dry = await publish(store, out, true)
      assert.deepEqual([dry.changed, dry.removed], [[PUB], ['github:acme/older']])
    })
  })
})

describe('publish: star counts, Needs Review, addedAt', () => {
  it('carries stargazers, needsReview and addedAt; star counts alone are not something new to publish', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await overrideItem(store, 'github:acme/older', { visibility: 'public' })
      const doc = await buildProjection(store)
      const open = doc.items.find((i) => 'id' in i && i.id === PUB) as unknown as Record<string, unknown>
      assert.deepEqual([open.stargazers, open.needsReview, open.addedAt], [10, false, '2026-11-01T00:00:00Z'])
      await publish(store, out, false)
      assert.equal((await check(store)).pendingPublish, false)
      // Star counts move: the file would change, but there is nothing new.
      await collectGithub(store, async () => [star('acme/open', { starred_at: '2026-11-01T00:00:00Z', stargazers_count: 5000 })])
      const moved = await buildProjection(store)
      assert.notDeepEqual(moved, doc)
      assert.equal(contentHash(moved), contentHash(doc))
      assert.equal((await check(store)).pendingPublish, false)
      const dry = await publish(store, out, true)
      assert.deepEqual([dry.identical, dry.contentChanged], [false, false])
    })
  })

  it('holdSources keeps a held Source as it was and takes the rest fresh', async () => {
    await withDir(async (dir) => {
      const { store } = await setup(dir)
      const before = await buildProjection(store)
      await overrideItem(store, PUB, { summary: 'new summary' })
      const now = await buildProjection(store)
      const held = holdSources(now, before, ['github'], [])
      assert.ok(!JSON.stringify(held).includes('new summary'))
      assert.ok(JSON.stringify(holdSources(now, before, ['x'], [])).includes('new summary'))
    })
  })

  it('holdSources drops a held Item the store no longer has as public: made private, gone, or never public now', async () => {
    await withDir(async (dir) => {
      const { store } = await setup(dir)
      const before = await buildProjection(store)
      // The public file also lists an Item the store does not have, and one of a private repository (an older bug).
      const stale = { ...before.items[0]!, id: 'github:acme/deleted', url: 'https://github.com/acme/deleted' }
      const leaked = { ...before.items[0]!, id: PRIV_REPO, url: 'https://github.com/corp/secret-repo' }
      const xPost = { url: 'https://x.com/dev/status/9', author: 'dev', postedAt: null, addedAt: '2026-11-01T00:00:00Z', category: 'CLI 与开发工具', tags: [], summary: 'skipped since', needsReview: false }
      const previous = { ...before, items: [...before.items, stale, leaked, xPost] }
      // The owner takes one back while GitHub collection is failing.
      await overrideItem(store, PUB, { visibility: 'private', summary: 'changed while held' })
      const now = await buildProjection(store)
      const held = holdSources(now, previous, ['github', 'x'], [])
      const keys = held.items.map((i) => ('id' in i ? i.id : i.url))
      assert.deepEqual(keys, ['github:acme/older'])
      assert.ok(!JSON.stringify(held).includes('changed while held'))
    })
  })
})

describe('check', () => {
  it('reports pending Classification and an unpublished Public Projection', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const before = await check(store)
      assert.equal(before.pendingClassification, 1)
      assert.equal(before.pendingPublish, true)
      assert.equal(before.hasWork, true)
      await publish(store, out, false)
      const after = await check(store)
      assert.equal(after.pendingPublish, false)
      assert.equal(after.publicItems, 2)
      assert.equal(after.classified, 4)
      assert.equal(after.hasWork, true)
      await overrideItem(store, UNCLASSIFIED, {})
      assert.equal((await check(store)).hasWork, false)
    })
  })
})

describe('publish X Items', () => {
  it('publishes only url, author, postedAt, addedAt, category, tags, summary and needsReview; never text or Skipped Items', async () => {
    await withDir(async (dir) => {
      const store = await seedMixedStore(dir, [star('acme/open')], [
        xRaw('111', { author: 'alice', text: 'SECRET-TEXT about Rust' }),
        xRaw('222', { text: 'NONTECH cats' }),
        xRaw('333', { text: '' }),
      ])
      const batch = buildBatch(await loadItems(store), {}, 25, 'x')
      const keep = (id: string) => ({ id, keep: true, category: '教程与观点', tags: ['rust'], summary: `${id} 摘要`, visibility: 'public' })
      await applyBatch(store, {
        schemaVersion: 1,
        batchId: batch.batchId,
        items: batch.items,
        classifications: [keep('x:111'), { id: 'x:222', keep: false }, keep('x:333')],
      })
      const out = join(dir, 'out')
      const r = await publish(store, out, false)
      assert.deepEqual(r.added, ['https://x.com/alice/status/111'])
      const items = await readFile(join(out, 'items.json'), 'utf8')
      const readme = await readFile(join(out, 'README.md'), 'utf8')
      const doc = JSON.parse(items) as { items: Record<string, unknown>[] }
      assert.deepEqual(doc.items, [
        {
          addedAt: '2026-11-20T00:00:00.000Z',
          author: 'alice',
          category: '教程与观点',
          needsReview: false,
          postedAt: '2026-11-10T00:00:00.000Z',
          summary: 'x:111 摘要',
          tags: ['rust'],
          url: 'https://x.com/alice/status/111',
        },
      ])
      for (const text of [items, readme]) {
        assert.ok(!text.includes('SECRET-TEXT'), 'post text published')
        assert.ok(!text.includes('222'), 'Skipped Item published')
        // No text: forced private by apply.
        assert.ok(!text.includes('333'), 'post with no text published')
      }
      assert.match(readme, /- \[@alice\]\(https:\/\/x.com\/alice\/status\/111\) — x:111 摘要 `rust`/)
      const k = await check(store)
      assert.deepEqual([k.bySource.x, k.skippedItems, k.pendingPublish], [{ items: 2, pendingClassification: 0 }, 1, false])
    })
  })
})
