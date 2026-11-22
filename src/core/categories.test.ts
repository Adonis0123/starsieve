// categories set: table validation, and --reclassify deleting only the Classifier's unlocked Classifications.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { seedStore, snapshot, star, withDir } from '../testing/fixtures.ts'
import { buildBatch } from './batch.ts'
import { DEFAULT_CATEGORIES, MAX_CATEGORIES, setCategories, validateCategoryTable } from './categories.ts'
import {
  loadCategories,
  loadClassifications,
  loadItems,
  loadSkipped,
  saveClassifications,
  saveSkipped,
} from './store.ts'
import type { Classification } from './types.ts'

const table = (names: string[]) => ({ schemaVersion: 1, categories: names.map((name) => ({ name, description: `${name} things` })) })

const classification = (over: Partial<Classification>): Classification => ({
  category: '库与框架',
  tags: ['库'],
  summary: 's',
  visibility: 'public',
  needsReview: false,
  locked: false,
  by: 'classifier',
  inputHash: 'h',
  ...over,
})

describe('validateCategoryTable', () => {
  for (const [why, value, error] of [
    ['not an object', [], /not a JSON object/],
    ['wrong schemaVersion', { ...table(['未分类']), schemaVersion: 2 }, /schemaVersion must be 1/],
    ['no categories', { schemaVersion: 1, categories: [] }, /non-empty array/],
    ['an empty name', table(['  ', '未分类']), /name must be a non-empty string/],
    ['a padded name', table([' 工具', '未分类']), /leading or trailing spaces/],
    ['a duplicate name', table(['工具', '工具', '未分类']), /"工具" appears twice/],
    ['no 未分类', table(['工具']), /must contain "未分类"/],
    ['too many', table([...Array.from({ length: MAX_CATEGORIES }, (_, i) => `c${i}`), '未分类']), /at most 32 Categories/],
    ['a missing description', { schemaVersion: 1, categories: [{ name: '未分类' }] }, /description must be a string/],
    ['an empty nameEn', { schemaVersion: 1, categories: [{ name: '未分类', description: '', nameEn: ' ' }] }, /nameEn must be one non-empty line/],
    ['a multi-line nameEn', { schemaVersion: 1, categories: [{ name: '未分类', description: '', nameEn: 'a\nb' }] }, /nameEn must be one non-empty line/],
    ['a non-string nameEn', { schemaVersion: 1, categories: [{ name: '未分类', description: '', nameEn: 1 }] }, /nameEn must be one non-empty line/],
  ] as const) {
    it(`rejects ${why}`, () => {
      assert.throws(() => validateCategoryTable(value), error)
    })
  }

  it('accepts the default table, which fits GitHub Lists and has 未分类', () => {
    assert.deepEqual(validateCategoryTable(DEFAULT_CATEGORIES), DEFAULT_CATEGORIES)
    assert.equal(DEFAULT_CATEGORIES.categories.length, 12)
  })

  it('keeps a trimmed nameEn when given and adds none when not', () => {
    const doc = {
      schemaVersion: 1,
      categories: [
        { name: '工具', description: 'd', nameEn: ' Tools ' },
        { name: '未分类', description: 'd' },
      ],
    }
    assert.deepEqual(validateCategoryTable(doc).categories, [
      { name: '工具', description: 'd', nameEn: 'Tools' },
      { name: '未分类', description: 'd' },
    ])
    assert.ok(DEFAULT_CATEGORIES.categories.every((c) => c.nameEn), 'every default Category has an English name')
    assert.equal(DEFAULT_CATEGORIES.categories.find((c) => c.name === '未分类')?.nameEn, 'Uncategorized')
  })
})

describe('setCategories', () => {
  async function store(dir: string) {
    const s = await seedStore(dir, [
      star('acme/auto'),
      star('acme/flagged'),
      star('acme/mine'),
      star('acme/old-mine'),
      star('corp/secret', { private: true }),
    ])
    const all = await loadClassifications(s)
    all['github:acme/auto'] = classification({})
    all['github:acme/flagged'] = classification({ needsReview: true, category: '未分类' })
    all['github:acme/mine'] = classification({ locked: true, by: 'owner', category: '资料合集' })
    all['github:acme/old-mine'] = classification({ locked: true, by: 'owner', category: '库与框架' })
    await saveClassifications(s, all)
    await saveSkipped(s, { 'x:9': { skippedAt: '2026-11-01T00:00:00Z' } })
    return s
  }

  it('--reclassify deletes only unlocked Classifier Classifications and reports stale Locked ones', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      assert.equal((await loadClassifications(s))['github:corp/secret']?.by, 'collector')
      const r = await setCategories(s, DEFAULT_CATEGORIES, { reclassify: true })
      assert.equal(r.removed, 2)
      assert.deepEqual(r.staleLocked, [{ id: 'github:acme/old-mine', category: '库与框架' }])
      assert.deepEqual(r.categories, DEFAULT_CATEGORIES.categories.map((c) => c.name))
      const after = await loadClassifications(s)
      assert.deepEqual(Object.keys(after).sort(), ['github:acme/mine', 'github:acme/old-mine', 'github:corp/secret'])
      // The stale Locked one is reported, never changed.
      assert.equal(after['github:acme/old-mine']?.category, '库与框架')
      assert.deepEqual(await loadSkipped(s), { 'x:9': { skippedAt: '2026-11-01T00:00:00Z' } })
      assert.deepEqual(await loadCategories(s), DEFAULT_CATEGORIES)
      // The removed Items are pending again; the private star never is.
      const pending = buildBatch(await loadItems(s), after, 25).items.map((e) => e.id)
      assert.deepEqual(pending.sort(), ['github:acme/auto', 'github:acme/flagged'])
    })
  })

  it('stores nameEn, and a table with and without it loads back', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const doc = { schemaVersion: 1, categories: [{ name: '工具', description: 'd', nameEn: 'Tools' }, { name: '未分类', description: 'd' }] }
      await setCategories(s, doc)
      assert.deepEqual(await loadCategories(s), doc)
    })
  })

  it('without --reclassify only replaces the table', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const before = await loadClassifications(s)
      const r = await setCategories(s, DEFAULT_CATEGORIES)
      assert.equal(r.removed, 0)
      assert.deepEqual(r.staleLocked, [{ id: 'github:acme/old-mine', category: '库与框架' }])
      assert.deepEqual(await loadClassifications(s), before)
      assert.deepEqual(await loadCategories(s), DEFAULT_CATEGORIES)
    })
  })

  it('an invalid table writes nothing', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const before = await snapshot(s)
      await assert.rejects(setCategories(s, table(['工具']), { reclassify: true }), /must contain "未分类"/)
      assert.deepEqual(await snapshot(s), before)
    })
  })
})
