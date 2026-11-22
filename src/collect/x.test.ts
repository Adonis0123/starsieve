// collect x: row parsing, Signal merge and stop rules are pure; the scan loop runs against a fake browser.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadBackfill, loadXItems, saveSkipped } from '../core/store.ts'
import type { XItem } from '../core/types.ts'
import { fakeXBrowser, withDir, xRaw } from '../testing/fixtures.ts'
import {
  backfillX,
  collectX,
  isLoggedOutUrl,
  knownIds,
  LoggedOutError,
  mergeRows,
  newScan,
  parseRow,
  type RawRow,
  scanStep,
} from './x.ts'

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => xRaw(String(from + i)))

describe('parseRow', () => {
  it('takes the link around time, not analytics or photo links', () => {
    const row = parseRow({
      hrefs: ['/alice', '/alice/status/123/photo/1', '/alice/status/123/analytics', '/alice/status/123'],
      timeHref: '/alice/status/123',
      datetime: '2026-11-18T21:00:54.000Z',
      text: '  Hello  \n',
      hasMediaElement: false,
    })
    assert.deepEqual(row, {
      id: 'x:123',
      url: 'https://x.com/alice/status/123',
      author: 'alice',
      text: 'Hello',
      postedAt: '2026-11-18T21:00:54.000Z',
      // the /photo/ link counts as media even when no media element was found
      hasMedia: true,
      textEmpty: false,
    })
  })

  it('falls back to the first status link, and keeps a quoted post out of it', () => {
    const row = parseRow({
      hrefs: ['/bob/status/9/analytics', '/bob/status/9', '/carol/status/5'],
      timeHref: null,
      datetime: null,
      text: '',
      hasMediaElement: true,
    })
    assert.equal(row?.id, 'x:9')
    assert.equal(row?.author, 'bob')
    assert.equal(row?.postedAt, null)
    assert.equal(row?.textEmpty, true)
    assert.equal(row?.hasMedia, true)
  })

  it('returns nothing for an article without a post link, and ignores a bad datetime', () => {
    assert.equal(parseRow({ hrefs: ['/home', '/alice'], timeHref: null, datetime: null, text: 'x', hasMediaElement: false }), undefined)
    assert.equal(parseRow(xRaw('1', { datetime: 'yesterday' }))?.postedAt, null)
    assert.equal(parseRow(xRaw('1', { timeHref: '/i/web/status/1' }))?.id, 'x:1')
  })
})

describe('parseRow on X Article cards', () => {
  const card = ['Your coding agents made you a manager', 'The skills for managing agents are the skills for managing a team.']

  it('takes the card title and summary as the text of an Article with no post text', () => {
    const row = parseRow(xRaw('7', { text: '', article: card }))
    assert.equal(row?.text, `${card[0]}\n\n${card[1]}`)
    assert.equal(row?.textEmpty, false)
  })

  it('keeps the post text first when the post has both', () => {
    const row = parseRow(xRaw('8', { text: 'I wrote this post', article: ['  Automate Anything  ', ''] }))
    assert.equal(row?.text, 'I wrote this post\n\nAutomate Anything')
  })

  it('still marks a post with neither as textEmpty', () => {
    assert.equal(parseRow(xRaw('9', { text: '', article: [] }))?.textEmpty, true)
    assert.equal(parseRow(xRaw('9', { text: '' }))?.textEmpty, true)
  })
})

describe('isLoggedOutUrl', () => {
  it('flags onboarding and login, not the lists', () => {
    assert.equal(isLoggedOutUrl('https://x.com/i/jf/onboarding/start?x=1'), true)
    assert.equal(isLoggedOutUrl('https://x.com/i/flow/login'), true)
    assert.equal(isLoggedOutUrl('https://x.com/login'), true)
    assert.equal(isLoggedOutUrl('https://x.com/i/history/likes'), false)
    assert.equal(isLoggedOutUrl('https://x.com/i/history'), false)
  })
})

describe('scanStep', () => {
  it('drops rows already seen in this run without touching the known count', () => {
    const known = new Set(['x:1', 'x:2'])
    let { state, fresh } = scanStep(newScan(), rows(1, 3), (id) => known.has(id), 5)
    assert.deepEqual(fresh.map((r) => r.id), ['x:1', 'x:2', 'x:3'])
    assert.equal(state.knownRun, 0)
    // The next window overlaps: 2 and 3 again, then 4 (known).
    known.add('x:4')
    ;({ state, fresh } = scanStep(state, rows(2, 4), (id) => known.has(id), 5))
    assert.deepEqual(fresh.map((r) => r.id), ['x:4'])
    assert.equal(state.knownRun, 1)
    assert.equal(state.emptySteps, 0)
    ;({ state } = scanStep(state, rows(2, 4), (id) => known.has(id), 5))
    assert.equal(state.emptySteps, 1)
  })

  it('stops at the known-stop-th known post in a row and takes nothing after it', () => {
    const known = (id: string) => id !== 'x:3'
    const { state } = scanStep(newScan(), rows(1, 10), known, 3)
    // 1, 2 known; 3 unknown resets; 4, 5, 6 known -> stop at 6.
    assert.equal(state.stopped, true)
    assert.equal(state.knownRun, 3)
    assert.deepEqual(state.seen, ['x:1', 'x:2', 'x:3', 'x:4', 'x:5', 'x:6'])
  })

  it('tracks the earliest postedAt', () => {
    const raw: RawRow[] = [
      xRaw('1', { datetime: '2026-11-10T00:00:00.000Z' }),
      xRaw('2', { datetime: '2025-01-01T00:00:00.000Z' }),
      xRaw('3', { datetime: null }),
    ]
    assert.equal(scanStep(newScan(), raw, () => false).state.earliestPostedAt, '2025-01-01T00:00:00.000Z')
  })
})

describe('mergeRows', () => {
  const at = '2026-11-20T00:00:00.000Z'
  const parsed = (id: string, text?: string) => parseRow(xRaw(id, text === undefined ? {} : { text }))!

  it('adds new posts with the Signal and merges a second Signal into one Item', () => {
    const first = mergeRows([], [parsed('1'), parsed('2')], 'like', at, new Set())
    assert.deepEqual(first.added, ['x:1', 'x:2'])
    const item = first.items[0]!
    assert.deepEqual(
      { ...item },
      {
        id: 'x:1',
        source: 'x',
        signals: ['like'],
        url: 'https://x.com/dev/status/1',
        author: 'dev',
        text: 'post 1 about TypeScript',
        postedAt: '2026-11-10T00:00:00.000Z',
        collectedAt: at,
        hasMedia: false,
        textEmpty: false,
      } satisfies XItem,
    )
    const second = mergeRows(first.items, [parsed('2', 'edited'), parsed('3')], 'bookmark', '2026-11-21T00:00:00.000Z', new Set())
    assert.deepEqual([second.added, second.signalAdded], [['x:3'], ['x:2']])
    const two = second.items.find((i) => i.id === 'x:2')!
    assert.deepEqual(two.signals, ['bookmark', 'like'])
    // A stored post keeps its text and collectedAt, so its inputHash does not change.
    assert.deepEqual([two.text, two.collectedAt], ['post 2 about TypeScript', at])
    // Seeing the same Signal again changes nothing.
    assert.deepEqual(mergeRows(second.items, [parsed('2')], 'like', at, new Set()).signalAdded, [])
  })

  it('never brings back a Skipped Item', () => {
    const r = mergeRows([], [parsed('1'), parsed('2')], 'like', at, new Set(['x:1']))
    assert.deepEqual(r.items.map((i) => i.id), ['x:2'])
  })
})

describe('collectX', () => {
  it('collects from the top, then stops after known-stop known posts on the next run', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const likes = [rows(1, 5), rows(4, 9), rows(8, 12)]
      const first = fakeXBrowser({ likes })
      const r1 = await collectX(store, { lists: ['likes'], maxScrolls: 2, knownStop: 20, openBrowser: first.open })
      assert.deepEqual([r1[0]!.added, r1[0]!.scrolls, r1[0]!.stoppedBy], [12, 2, 'maxScrolls'])
      assert.deepEqual(first.calls, ['open', 'load likes', 'scroll', 'scroll', 'close'])

      // Two new likes on top; 5 known in a row stops it inside the first screen.
      const second = fakeXBrowser({ likes: [[xRaw('100'), xRaw('101'), ...rows(1, 7)]] })
      const r2 = await collectX(store, { lists: ['likes'], maxScrolls: 40, knownStop: 5, openBrowser: second.open })
      assert.deepEqual([r2[0]!.added, r2[0]!.scrolls, r2[0]!.knownRun, r2[0]!.stoppedBy], [2, 0, 5, 'known'])
      assert.equal((await loadXItems(store)).length, 14)
    })
  })

  it('reports an empty list as done with nothing, and merges likes and bookmarks', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const empty = fakeXBrowser({ likes: [rows(1, 2)], bookmarks: [[]] })
      const r = await collectX(store, { lists: ['likes', 'bookmarks'], maxScrolls: 40, knownStop: 20, openBrowser: empty.open })
      assert.deepEqual(
        r.map((l) => [l.list, l.added, l.stoppedBy]),
        [
          ['likes', 2, 'end'],
          ['bookmarks', 0, 'empty'],
        ],
      )
      const both = fakeXBrowser({ bookmarks: [rows(2, 3)] })
      const b = await collectX(store, { lists: ['bookmarks'], maxScrolls: 1, knownStop: 20, openBrowser: both.open })
      assert.deepEqual([b[0]!.added, b[0]!.signalAdded], [1, 1])
      const items = await loadXItems(store)
      assert.deepEqual(
        items.map((i) => [i.id, i.signals]),
        [
          ['x:1', ['like']],
          ['x:2', ['bookmark', 'like']],
          ['x:3', ['bookmark']],
        ],
      )
    })
  })

  it('treats Skipped Items as known', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await saveSkipped(store, { 'x:1': { skippedAt: 'then' }, 'x:2': { skippedAt: 'then' } })
      const b = fakeXBrowser({ likes: [rows(1, 4)] })
      const r = await collectX(store, { lists: ['likes'], maxScrolls: 40, knownStop: 2, openBrowser: b.open })
      assert.deepEqual([r[0]!.added, r[0]!.stoppedBy], [0, 'known'])
      assert.deepEqual(await loadXItems(store), [])
    })
  })

  it('counts known posts per Signal: a like is still new on the bookmarks list', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await collectX(store, { lists: ['likes'], maxScrolls: 0, knownStop: 20, openBrowser: fakeXBrowser({ likes: [rows(1, 6)] }).open })
      // The same six posts on top of the bookmarks list, then an older bookmark: none of the six is known there.
      const b = fakeXBrowser({ bookmarks: [[...rows(1, 6), xRaw('50')]] })
      const r = await collectX(store, { lists: ['bookmarks'], maxScrolls: 0, knownStop: 3, openBrowser: b.open })
      assert.deepEqual([r[0]!.added, r[0]!.signalAdded, r[0]!.knownRun, r[0]!.stoppedBy], [1, 6, 0, 'maxScrolls'])
      const items = await loadXItems(store)
      assert.deepEqual(items.find((i) => i.id === 'x:6')?.signals, ['bookmark', 'like'])

      // Now they are bookmarks too, so a second bookmarks run stops on them.
      const again = await collectX(store, {
        lists: ['bookmarks'],
        maxScrolls: 40,
        knownStop: 3,
        openBrowser: fakeXBrowser({ bookmarks: [rows(1, 6)] }).open,
      })
      assert.deepEqual([again[0]!.added, again[0]!.stoppedBy], [0, 'known'])
    })
  })

  it('knownIds: stored with this Signal, or Skipped', () => {
    const item = (id: string, signals: XItem['signals']) => ({ id, signals }) as XItem
    const known = knownIds([item('x:1', ['like']), item('x:2', ['bookmark']), item('x:3', ['bookmark', 'like'])], { 'x:9': {} }, 'bookmark')
    assert.deepEqual([...known].sort(), ['x:2', 'x:3', 'x:9'])
  })

  it('fails loudly when logged out and still closes the browser', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const b = fakeXBrowser({ likes: [rows(1, 2)] }, { failOnScroll: 1, error: new LoggedOutError('logged out') })
      await assert.rejects(
        collectX(store, { lists: ['likes'], maxScrolls: 40, knownStop: 20, openBrowser: b.open }),
        LoggedOutError,
      )
      assert.equal(b.calls.at(-1), 'close')
    })
  })
})

describe('backfillX', () => {
  it('saves every 10 scrolls and records reach, ending after 5 scrolls with nothing new', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      // 12 scrolls each bring 2 new posts, then the list stops growing.
      const likes = [rows(1, 2), ...Array.from({ length: 12 }, (_, i) => rows(3 + 2 * i, 4 + 2 * i))]
      const b = fakeXBrowser({ likes })
      let n = 0
      const now = () => new Date(Date.UTC(2026, 10, 20, 0, 0, n++))
      const r = await backfillX(store, { lists: ['likes'], maxScrolls: 400, openBrowser: b.open, now })
      assert.deepEqual([r[0]!.scrolls, r[0]!.seen, r[0]!.added, r[0]!.stoppedBy], [17, 26, 26, 'end'])
      const reach = (await loadBackfill(store)).x.like!
      assert.equal(reach.scrolls, 17)
      assert.equal(reach.reachedEnd, true)
      assert.equal(reach.finished, true)
      assert.equal(reach.earliestPostedAt, '2026-11-10T00:00:00.000Z')
      assert.equal((await loadXItems(store)).length, 26)
    })
  })

  it('has the first 10 scrolls on disk while the 11th runs', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const likes = [rows(1, 1), ...Array.from({ length: 12 }, (_, i) => rows(2 + i, 2 + i))]
      const b = fakeXBrowser({ likes })
      let duringEleventh: { items: number; scrolls?: number; finished?: boolean } | undefined
      const open = async () => {
        const browser = await b.open()
        let n = 0
        return {
          ...browser,
          scroll: async () => {
            if (++n === 11) {
              const reach = (await loadBackfill(store)).x.like
              duringEleventh = { items: (await loadXItems(store)).length, scrolls: reach?.scrolls, finished: reach?.finished }
            }
            return browser.scroll()
          },
        }
      }
      await backfillX(store, { lists: ['likes'], maxScrolls: 12, openBrowser: open })
      assert.deepEqual(duringEleventh, { items: 11, scrolls: 10, finished: false })
    })
  })

  it('keeps what it read when the browser fails part way, and marks the reach unfinished', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const likes = [rows(1, 2), ...Array.from({ length: 20 }, (_, i) => rows(3 + i, 3 + i))]
      const b = fakeXBrowser({ likes }, { failOnScroll: 13 })
      await assert.rejects(backfillX(store, { lists: ['likes'], maxScrolls: 400, openBrowser: b.open }), /NETWORK_CHANGED/)
      // 2 on load + 12 scrolls of 1 each.
      assert.equal((await loadXItems(store)).length, 14)
      const reach = (await loadBackfill(store)).x.like!
      assert.deepEqual([reach.scrolls, reach.finished, reach.reachedEnd], [12, false, false])
      assert.equal(b.calls.at(-1), 'close')
    })
  })

  it('stops between scrolls when interrupted and saves', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const controller = new AbortController()
      const likes = [rows(1, 2), rows(3, 4), rows(5, 6)]
      const b = fakeXBrowser({ likes })
      const open = async () => {
        const browser = await b.open()
        return {
          ...browser,
          scroll: async () => {
            const r = await browser.scroll()
            controller.abort()
            return r
          },
        }
      }
      const r = await backfillX(store, { lists: ['likes'], maxScrolls: 400, openBrowser: open, signal: controller.signal })
      assert.deepEqual([r[0]!.scrolls, r[0]!.stoppedBy, r[0]!.reach.finished], [1, 'interrupted', false])
      assert.equal((await loadXItems(store)).length, 4)
    })
  })
})
