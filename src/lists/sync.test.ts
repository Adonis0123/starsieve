// lists sync: only adds, keeps every list a repository is in, stops at 32 lists, and never writes from a partial read.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { overrideItem } from '../core/override.ts'
import { seedStore, star, withDir } from '../testing/fixtures.ts'
import { fakeGh, type FakeList } from '../testing/repos.ts'
import type { PublicDoc } from '../publish/projection.ts'
import { ListsError, listsSync, MAX_LISTS, planLists } from './sync.ts'

const doc = (...items: [string, string][]): PublicDoc => ({
  schemaVersion: 1,
  items: items.map(([id, category]) => ({ id, category }) as unknown as PublicDoc['items'][number]),
})

describe('planLists', () => {
  const repos = new Map([
    ['acme/a', { id: 'R_a', nameWithOwner: 'acme/a' }],
    ['acme/b', { id: 'R_b', nameWithOwner: 'acme/b' }],
  ])

  it('keeps every list a repository is in and adds only the missing Category list', () => {
    const lists = [
      { id: 'L_hand', name: 'My favourites', itemIds: ['R_a'] },
      { id: 'L_cli', name: 'CLI', itemIds: ['R_b'] },
    ]
    const plan = planLists(lists, [{ repo: 'acme/a', category: 'CLI' }, { repo: 'acme/b', category: 'CLI' }, { repo: 'acme/gone', category: 'CLI' }], repos, new Map())
    assert.deepEqual(plan.create, [])
    assert.deepEqual(plan.updates, [{ repo: 'acme/a', itemId: 'R_a', keep: ['My favourites'], add: 'CLI' }])
    assert.equal(plan.unchanged, 1)
    assert.deepEqual(plan.missing, ['acme/gone'])
  })

  it('creates only Categories with GitHub Items, and refuses to go past 32 lists', () => {
    const plan = planLists([], [{ repo: 'acme/a', category: 'Libs' }], repos, new Map([['Libs', 'starsieve: libraries']]))
    assert.deepEqual(plan.create, [{ name: 'Libs', description: 'starsieve: libraries' }])
    const full = Array.from({ length: MAX_LISTS }, (_, i) => ({ id: `L${i}`, name: `list ${i}`, itemIds: [] }))
    assert.throws(() => planLists(full, [{ repo: 'acme/a', category: 'Libs' }], repos, new Map()), ListsError)
    // Exactly 32 with the new one is fine.
    assert.doesNotThrow(() => planLists(full.slice(1), [{ repo: 'acme/a', category: 'Libs' }], repos, new Map()))
  })
})

describe('lists sync', () => {
  async function store(dir: string) {
    const s = await seedStore(dir, [star('acme/a'), star('acme/b'), star('acme/c'), star('corp/secret', { private: true })])
    for (const id of ['github:acme/a', 'github:acme/b', 'github:acme/c']) await overrideItem(s, id, { category: '库与框架', visibility: 'public' })
    await overrideItem(s, 'github:acme/c', { visibility: 'private' })
    await overrideItem(s, 'github:corp/secret', { category: '库与框架', visibility: 'public' })
    return s
  }
  const merged = doc(['github:acme/a', '库与框架'], ['github:acme/b', '库与框架'], ['github:acme/c', '库与框架'], ['github:corp/secret', '库与框架'])

  it('sends the lists a repository is already in plus its Category list, read across pages', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const lists: FakeList[] = [
        { id: 'L_hand', name: 'Hand-made', repos: [{ id: 'R_x/1', nameWithOwner: 'x/1' }, { id: 'R_acme/a', nameWithOwner: 'acme/a' }] },
      ]
      const gh = fakeGh(lists, { pageSize: 1 })
      const r = await listsSync({ storeDir: s, merged, dryRun: false, gh: gh.exec })
      assert.deepEqual(r.created, ['库与框架'])
      assert.deepEqual(r.notPublic.sort(), ['github:acme/c', 'github:corp/secret'])
      const update = gh.mutations.find((m) => m.query.includes('updateUserListsForItem'))!
      const inputs = Object.values(update.variables) as { itemId: string; listIds: string[] }[]
      const a = inputs.find((i) => i.itemId === 'R_acme/a')!
      assert.deepEqual(a.listIds.sort(), ['L_hand', 'L_库与框架'].sort())
      assert.deepEqual(inputs.find((i) => i.itemId === 'R_acme/b')!.listIds, ['L_库与框架'])
      assert.equal(inputs.length, 2)
      // Private: never sent.
      assert.ok(!JSON.stringify(gh.mutations).includes('secret') && !JSON.stringify(gh.mutations).includes('acme/c'))
    })
  })

  it('reads the lists again right before writing: a list the owner added a repository to meanwhile is kept', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const lists: FakeList[] = [
        { id: 'L_hand', name: 'Hand-made', repos: [{ id: 'R_x/1', nameWithOwner: 'x/1' }] },
        { id: 'L_库与框架', name: '库与框架', repos: [] },
      ]
      const gh = fakeGh(lists)
      let reads = 0
      const exec: typeof gh.exec = async (cmd, args, o) => {
        const r = await gh.exec(cmd, args, o)
        if (String(o?.input ?? '').includes('viewer { lists') && ++reads === 1) {
          // After the planning read: the owner puts acme/a in a hand-made list, and acme/b in its Category list.
          lists[0]!.repos.push({ id: 'R_acme/a', nameWithOwner: 'acme/a' })
          lists[1]!.repos.push({ id: 'R_acme/b', nameWithOwner: 'acme/b' })
        }
        return r
      }
      const r = await listsSync({ storeDir: s, merged, dryRun: false, gh: exec })
      assert.ok(reads >= 2, 'read again before the mutation')
      const update = gh.mutations.find((m) => m.query.includes('updateUserListsForItem'))!
      const inputs = Object.values(update.variables) as { itemId: string; listIds: string[] }[]
      assert.deepEqual(inputs, [{ itemId: 'R_acme/a', listIds: ['L_hand', 'L_库与框架'] }])
      assert.equal(r.updated, 1)
      assert.equal(r.unchanged, 1)
    })
  })

  it('--dry-run reads and plans, and writes nothing', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const gh = fakeGh([])
      const r = await listsSync({ storeDir: s, merged, dryRun: true, gh: gh.exec })
      assert.deepEqual([r.create.length, r.updates.length], [1, 2])
      assert.equal(gh.mutations.length, 0)
    })
  })

  it('a failed read of the lists stops before any write', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const gh = fakeGh([], { failListsRead: true })
      await assert.rejects(listsSync({ storeDir: s, merged, dryRun: false, gh: gh.exec }), ListsError)
      assert.equal(gh.mutations.length, 0)
    })
  })

  it('over 32 lists: an error and no write', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const lists = Array.from({ length: MAX_LISTS }, (_, i) => ({ id: `L${i}`, name: `list ${i}`, repos: [] }))
      const gh = fakeGh(lists)
      await assert.rejects(listsSync({ storeDir: s, merged, dryRun: false, gh: gh.exec }), /allows 32 lists/)
      assert.equal(gh.mutations.length, 0)
    })
  })
})
