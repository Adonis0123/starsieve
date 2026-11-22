// apply: one test per validation rule; the store must hold exactly what was accepted.
import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { collectGithub } from '../collect/github.ts'
import { collectX } from '../collect/x.ts'
import { fakeXBrowser, seedMixedStore, seedStore, snapshot, star, withDir, xRaw } from '../testing/fixtures.ts'
import { ApplyInputError, applyBatch } from './apply.ts'
import { buildBatch, pendingItems } from './batch.ts'
import { overrideItem, unskipItem } from './override.ts'
import { acquireLock, lockClaims } from '../run/lock.ts'
import { loadClassifications, loadItems, loadOwnerKept, loadSkipped, loadXItems, paths, saveClassifications } from './store.ts'
import { SCHEMA_VERSION } from './types.ts'

const A = 'github:acme/alpha'
const B = 'github:acme/beta'

async function setup(dir: string) {
  const store = await seedStore(dir, [star('acme/alpha'), star('acme/beta', { starred_at: '2026-11-02T00:00:00Z' })])
  const batch = buildBatch(await loadItems(store), {}, 25)
  const input = (classifications: unknown[], over: Record<string, unknown> = {}) => ({
    schemaVersion: SCHEMA_VERSION,
    batchId: batch.batchId,
    items: batch.items.map(({ id, inputHash }) => ({ id, inputHash })),
    classifications,
    ...over,
  })
  return { store, batch, input }
}

const good = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  category: '库与框架',
  tags: ['ts'],
  summary: '一个库',
  visibility: 'public',
  ...over,
})

describe('apply', () => {
  it('writes accepted Classifications and reports counts', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const r = await applyBatch(store, input([good(A), good(B)]))
      assert.equal(r.accepted, 2)
      assert.equal(r.rejected, 0)
      const saved = await loadClassifications(store)
      assert.equal(saved[A]?.category, '库与框架')
      assert.equal(saved[A]?.by, 'classifier')
      assert.equal(saved[A]?.locked, false)
    })
  })

  it('rejects the whole file on a wrong schemaVersion and writes nothing', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const before = await snapshot(store)
      await assert.rejects(applyBatch(store, input([good(A)], { schemaVersion: 2 })), ApplyInputError)
      assert.deepEqual(await snapshot(store), before)
    })
  })

  it('rejects the whole file when batchId does not match its items', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await assert.rejects(applyBatch(store, input([good(A)], { batchId: 'batch-0000000000000000' })), /batchId/)
      const tampered = input([good(A)])
      tampered.items = tampered.items.slice(0, 1)
      await assert.rejects(applyBatch(store, tampered), /batchId/)
      assert.deepEqual(await loadClassifications(store), {})
    })
  })

  it('rejects ids that are not in the store or not in the Batch', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const r = await applyBatch(store, input([good('github:nobody/ghost'), good(A)]))
      assert.equal(r.accepted, 1)
      assert.deepEqual(r.results[0], {
        id: 'github:nobody/ghost',
        status: 'rejected',
        reasons: ['no such Item in the store'],
        warnings: [],
      })
      assert.deepEqual(r.missing, [B])
    })
  })

  it('rejects an Item that is in the store but not in the Batch', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await collectGithub(store, async () => [star('acme/alpha'), star('acme/beta'), star('acme/gamma')])
      const r = await applyBatch(store, input([good('github:acme/gamma')]))
      assert.deepEqual(r.results[0]?.reasons, ['Item is not in this Batch'])
      assert.deepEqual(await loadClassifications(store), {})
    })
  })

  it('rejects the whole file when the store has no Category Table', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await unlink(paths.categories(store))
      await assert.rejects(applyBatch(store, input([good(A)])), /no Category Table/)
      assert.deepEqual(await loadClassifications(store), {})
    })
  })

  it('rejects an entry whose inputHash no longer matches the Item', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await collectGithub(store, async () => [
        star('acme/alpha', { description: 'rewritten description' }),
        star('acme/beta', { starred_at: '2026-11-02T00:00:00Z' }),
      ])
      const r = await applyBatch(store, input([good(A), good(B)]))
      assert.equal(r.accepted, 1)
      assert.equal(r.rejected, 1)
      assert.match(r.results.find((x) => x.id === A)!.reasons[0]!, /inputHash/)
      assert.equal((await loadClassifications(store))[A], undefined)
    })
  })

  it('stargazer changes do not invalidate a Batch', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await collectGithub(store, async () => [
        star('acme/alpha', { stargazers_count: 999 }),
        star('acme/beta', { starred_at: '2026-11-02T00:00:00Z' }),
      ])
      assert.equal((await applyBatch(store, input([good(A)]))).accepted, 1)
    })
  })

  it('puts an unknown category under 未分类 with needsReview', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const r = await applyBatch(store, input([good(A, { category: '游戏' }), good(B, { category: undefined })]))
      assert.equal(r.accepted, 2)
      const saved = await loadClassifications(store)
      for (const id of [A, B]) {
        assert.equal(saved[id]?.category, '未分类')
        assert.equal(saved[id]?.needsReview, true)
      }
      assert.match(r.results[0]!.warnings[0]!, /not in the Category Table/)
    })
  })

  it('keeps at most 6 tags', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const r = await applyBatch(store, input([good(A, { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })]))
      assert.deepEqual((await loadClassifications(store))[A]?.tags, ['a', 'b', 'c', 'd', 'e', 'f'])
      assert.match(r.results[0]!.warnings[0]!, /8 tags/)
    })
  })

  it('strips URLs and HTML from the summary and caps it at 80 code points', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const long = '中'.repeat(100)
      const r = await applyBatch(
        store,
        input([
          good(A, { summary: '<b>好用</b> 的库 https://evil.example/x 见 [文档](http://x.y) <img src=x onerror=alert(1)>' }),
          good(B, { summary: long }),
        ]),
      )
      const saved = await loadClassifications(store)
      assert.equal(saved[A]?.summary, '好用 的库 见 文档')
      assert.deepEqual(r.results[0]!.warnings, ['removed links or HTML from the summary'])
      assert.deepEqual(r.results[1]!.warnings, ['summary cut to 80 characters'])
      assert.equal([...saved[B]!.summary].length, 80)
      assert.ok(saved[B]!.summary.endsWith('…'))
    })
  })

  it('keeps Chinese text that follows a link with no space', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await applyBatch(store, input([good(A, { summary: '文档见https://x.com/a?b=1，支持多种语言。' })]))
      assert.equal((await loadClassifications(store))[A]?.summary, '文档见 ，支持多种语言。')
    })
  })

  it('treats a missing or invalid visibility as private', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      await applyBatch(store, input([good(A, { visibility: 'unlisted' }), good(B, { visibility: undefined })]))
      const saved = await loadClassifications(store)
      assert.equal(saved[A]?.visibility, 'private')
      assert.equal(saved[B]?.visibility, 'private')
    })
  })

  it('skips Locked Items and leaves them unchanged', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const locked = await overrideItem(store, A, { category: '应用', visibility: 'private' })
      const r = await applyBatch(store, input([good(A), good(B)]))
      assert.equal(r.skipped, 1)
      assert.deepEqual(r.results.find((x) => x.id === A)?.reasons, ['Locked: changed by the owner'])
      assert.deepEqual((await loadClassifications(store))[A], locked)
    })
  })

  it('waits for the store write lock and reads Classifications afresh: a Locked edit made meanwhile survives', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      // Another process (the Panel) holds the store lock while the Classifier's answer comes in.
      const release = await acquireLock(paths.writeLock(store), process.pid)
      let done = false
      const applying = applyBatch(store, input([good(A, { visibility: 'public' }), good(B)])).finally(() => (done = true))
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(done, false, 'apply waits for the lock')
      const locked = { category: '其他', tags: [], summary: 'owner', visibility: 'private' as const, needsReview: false, locked: true, by: 'owner' as const, inputHash: 'x' }
      await saveClassifications(store, { [A]: locked })
      await release()
      const r = await applying
      assert.deepEqual(r.results.find((e) => e.id === A)?.status, 'skipped')
      const saved = await loadClassifications(store)
      assert.deepEqual(saved[A], locked)
      assert.equal(saved[B]?.by, 'classifier')
      assert.deepEqual(await lockClaims(paths.writeLock(store)), [], 'the lock was released')
    })
  })

  it('an override waits for an apply in progress instead of being overwritten by it', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const results = await Promise.all([
        applyBatch(store, input([good(A), good(B)])),
        overrideItem(store, A, { visibility: 'private', summary: 'mine' }),
      ])
      const saved = await loadClassifications(store)
      // Whichever ran first, the owner's Locked edit is what remains.
      assert.equal(saved[A]?.locked, true)
      assert.equal(saved[A]?.summary, 'mine')
      assert.equal(saved[B]?.by, 'classifier')
      assert.ok(['accepted', 'skipped'].includes(results[0].results.find((e) => e.id === A)!.status))
    })
  })

  it('rejects a duplicate id in one answer', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const r = await applyBatch(store, input([good(A), good(A, { category: '应用' })]))
      assert.equal(r.accepted, 1)
      assert.equal(r.rejected, 1)
      assert.equal((await loadClassifications(store))[A]?.category, '库与框架')
    })
  })
})

describe('apply X Items', () => {
  async function setupX(dir: string) {
    const store = await seedMixedStore(dir, [star('acme/alpha')], [
      xRaw('1'),
      xRaw('2', { text: 'NONTECH dinner photos' }),
      xRaw('3', { text: '', hasMediaElement: true }),
    ])
    const batch = buildBatch(await loadItems(store), {}, 25, 'x')
    const input = (classifications: unknown[]) => ({
      schemaVersion: SCHEMA_VERSION,
      batchId: batch.batchId,
      items: batch.items.map(({ id, inputHash }) => ({ id, inputHash })),
      classifications,
    })
    return { store, batch, input }
  }

  it('an Owner-kept post is never skipped again: keep false becomes keep true with Needs Review', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setupX(dir)
      await applyBatch(store, input([{ id: 'x:2', keep: false }]))
      assert.ok((await loadSkipped(store))['x:2'])
      await unskipItem(store, 'x:2', () => new Date('2026-11-21T01:00:00.000Z'))
      assert.deepEqual(await loadOwnerKept(store), { 'x:2': { keptAt: '2026-11-21T01:00:00.000Z' } })
      // The next collection stores the post again as pending; the Classifier says keep false once more.
      await collectX(store, { lists: ['likes'], maxScrolls: 0, openBrowser: fakeXBrowser({ likes: [[xRaw('2', { text: 'NONTECH dinner photos' })]] }).open })
      const again = buildBatch(await loadItems(store), await loadClassifications(store), 25, 'x')
      assert.ok(again.items.some((e) => e.id === 'x:2'))
      const r = await applyBatch(store, {
        schemaVersion: SCHEMA_VERSION,
        batchId: again.batchId,
        items: again.items.map(({ id, inputHash }) => ({ id, inputHash })),
        classifications: [{ id: 'x:2', keep: false }],
      })
      assert.deepEqual([r.accepted, r.skippedItems], [1, 0])
      assert.deepEqual(await loadSkipped(store), {})
      const c = (await loadClassifications(store))['x:2']!
      assert.deepEqual([c.needsReview, c.visibility, c.category], [true, 'private', '未分类'])
      assert.ok((await loadXItems(store)).some((i) => i.id === 'x:2'))
    })
  })

  it('turns keep false into a Skipped Item: id only, gone from Items, pending and later collects', async () => {
    await withDir(async (dir) => {
      const { store, batch, input } = await setupX(dir)
      assert.equal(batch.source, 'x')
      assert.deepEqual(batch.items.map((e) => e.id).sort(), ['x:1', 'x:2', 'x:3'])
      const r = await applyBatch(
        store,
        input([good('x:1', { keep: true }), { id: 'x:2', keep: false }]),
        () => new Date('2026-11-21T00:00:00.000Z'),
      )
      assert.deepEqual([r.accepted, r.skippedItems, r.rejected, r.missing], [1, 1, 0, ['x:3']])
      assert.deepEqual(await loadSkipped(store), { 'x:2': { skippedAt: '2026-11-21T00:00:00.000Z' } })
      const stored = await loadXItems(store)
      assert.deepEqual(stored.map((i) => i.id), ['x:1', 'x:3'])
      assert.ok(!JSON.stringify(stored).includes('dinner'), 'Skipped Item text kept')
      assert.equal((await loadClassifications(store))['x:2'], undefined)
      const pending = pendingItems(await loadItems(store), await loadClassifications(store), 'x')
      assert.deepEqual(pending.map((i) => i.id), ['x:3'])

      // Seen again in the likes list: only a known link.
      const again = await collectX(store, {
        lists: ['likes'],
        maxScrolls: 0,
        knownStop: 20,
        openBrowser: fakeXBrowser({ likes: [[xRaw('2', { text: 'NONTECH dinner photos' })]] }).open,
      })
      assert.equal(again[0]!.added, 0)
      assert.deepEqual((await loadXItems(store)).map((i) => i.id), ['x:1', 'x:3'])
    })
  })

  it('rejects an X answer without a boolean keep, and leaves it pending', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setupX(dir)
      const r = await applyBatch(store, input([good('x:1'), good('x:2', { keep: 'no' })]))
      assert.deepEqual(
        r.results.map((x) => [x.id, x.status, x.reasons[0]]),
        [
          ['x:1', 'rejected', 'X Items need keep: true or false'],
          ['x:2', 'rejected', 'X Items need keep: true or false'],
        ],
      )
      assert.deepEqual(await loadClassifications(store), {})
      assert.equal((await loadXItems(store)).length, 3)
    })
  })

  it('makes a post with no text private and Needs Review whatever the answer says', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setupX(dir)
      const r = await applyBatch(store, input([good('x:3', { keep: true, needsReview: false })]))
      assert.equal(r.accepted, 1)
      const c = (await loadClassifications(store))['x:3']!
      assert.deepEqual([c.visibility, c.needsReview], ['private', true])
    })
  })

  it('never lets keep false drop a GitHub Item', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setup(dir)
      const r = await applyBatch(store, input([good(A, { keep: false })]))
      assert.equal(r.accepted, 1)
      assert.deepEqual(r.results[0]!.warnings, ['keep is only read for X Items; ignored'])
      assert.deepEqual(await loadSkipped(store), {})
      assert.equal((await loadItems(store)).length, 2)
    })
  })

  it('a Locked X Item is skipped, not turned into a Skipped Item', async () => {
    await withDir(async (dir) => {
      const { store, input } = await setupX(dir)
      await overrideItem(store, 'x:2', { visibility: 'private' })
      const r = await applyBatch(store, input([{ id: 'x:2', keep: false }]))
      assert.deepEqual([r.skipped, r.skippedItems], [1, 0])
      assert.equal((await loadXItems(store)).length, 3)
    })
  })
})
