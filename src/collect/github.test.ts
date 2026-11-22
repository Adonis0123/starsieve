// collect: mapping from the GitHub payload, idempotent merge, Classifications untouched, failed fetch writes nothing.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyBatch } from '../core/apply.ts'
import { buildBatch, pendingItems } from '../core/batch.ts'
import { loadClassifications, loadItems } from '../core/store.ts'
import { seedStore, snapshot, star, withDir } from '../testing/fixtures.ts'
import { collectGithub, toItem } from './github.ts'

describe('collect github', () => {
  it('maps a star to an Item', () => {
    const item = toItem(
      star('acme/alpha', {
        starred_at: '2026-10-01T12:00:00Z',
        topics: ['a', 'b'],
        stargazers_count: 42,
        private: true,
        archived: true,
        language: null,
        description: null,
      }),
      0,
    )
    assert.deepEqual(item, {
      id: 'github:acme/alpha',
      source: 'github',
      signal: 'star',
      url: 'https://github.com/acme/alpha',
      name: 'acme/alpha',
      description: null,
      language: null,
      topics: ['a', 'b'],
      stargazers: 42,
      starredAt: '2026-10-01T12:00:00Z',
      repoPrivate: true,
      archived: true,
    })
  })

  it('treats a missing repo.private as private', () => {
    assert.equal(toItem(star('acme/alpha', { private: undefined }), 0).repoPrivate, true)
  })

  it('is idempotent: a second run with the same stars changes no file', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const stars = [star('acme/alpha'), star('acme/beta')]
      const first = await collectGithub(store, async () => stars)
      assert.equal(first.added, 2)
      const before = await snapshot(store)
      const second = await collectGithub(store, async () => stars)
      assert.deepEqual(
        { total: second.total, added: second.added, updated: second.updated, unchanged: second.unchanged },
        { total: 2, added: 0, updated: 0, unchanged: 2 },
      )
      assert.deepEqual(await snapshot(store), before)
    })
  })

  it('keeps Items sorted by id and keeps unstarred Items', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await collectGithub(store, async () => [star('zeta/z'), star('acme/a')])
      const r = await collectGithub(store, async () => [star('mid/m')])
      assert.equal(r.notSeen, 2)
      assert.deepEqual(
        (await loadItems(store)).map((i) => i.id),
        ['github:acme/a', 'github:mid/m', 'github:zeta/z'],
      )
    })
  })

  it('never touches existing Classifications', async () => {
    await withDir(async (dir) => {
      const store = await seedStore(dir, [star('acme/alpha')])
      const batch = buildBatch(await loadItems(store), {}, 25)
      await applyBatch(store, {
        schemaVersion: 1,
        batchId: batch.batchId,
        items: batch.items,
        classifications: [{ id: 'github:acme/alpha', category: '应用', tags: [], summary: 's', visibility: 'public' }],
      })
      const before = await loadClassifications(store)
      await collectGithub(store, async () => [star('acme/alpha', { stargazers_count: 5000 }), star('acme/new')])
      assert.deepEqual(await loadClassifications(store), before)
    })
  })

  it('writes nothing when the fetch fails or a star is malformed', async () => {
    await withDir(async (dir) => {
      const store = await seedStore(dir, [star('acme/alpha')])
      const before = await snapshot(store)
      await assert.rejects(
        collectGithub(store, async () => {
          throw new Error('gh: HTTP 401')
        }),
        /401/,
      )
      await assert.rejects(collectGithub(store, async () => [star('acme/new'), { repo: {} }]), /star #1/)
      assert.deepEqual(await snapshot(store), before)
    })
  })
})

describe('collect github: private repositories', () => {
  it('classifies a private repository star as private itself, so it never reaches the Classifier', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const r = await collectGithub(store, async () => [star('acme/open'), star('corp/secret', { private: true })])
      assert.equal(r.privateClassified, 1)
      const c = (await loadClassifications(store))['github:corp/secret']
      assert.deepEqual(
        { ...c, inputHash: undefined },
        { category: '未分类', tags: [], summary: '', visibility: 'private', needsReview: false, locked: false, by: 'collector', inputHash: undefined },
      )
      const items = await loadItems(store)
      assert.deepEqual(pendingItems(items, await loadClassifications(store)).map((i) => i.id), ['github:acme/open'])
      // Even with no Classification at all (a store collected before this fix), it is never pending.
      assert.deepEqual(pendingItems(items, {}).map((i) => i.id), ['github:acme/open'])
      assert.equal((await collectGithub(store, async () => [star('corp/secret', { private: true })])).privateClassified, 0)
    })
  })

  it('sends a repository that turned public to the Classifier', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await collectGithub(store, async () => [star('corp/secret', { private: true })])
      await collectGithub(store, async () => [star('corp/secret', { private: false })])
      const pending = pendingItems(await loadItems(store), await loadClassifications(store))
      assert.deepEqual(pending.map((i) => i.id), ['github:corp/secret'])
    })
  })
})
