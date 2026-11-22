// X collector: raw rows from the browser -> Items, Signal merge, and when to stop scrolling.
// Everything here is free of I/O except collectX/backfillX, which take the browser as a parameter (ADR 0003).
import { mkdir } from 'node:fs/promises'
import { loadSkipped, loadXItems, saveBackfillReach, saveXItems, withStoreLock } from '../core/store.ts'
import type { BackfillReach, XItem, XSignal } from '../core/types.ts'

export type XList = 'likes' | 'bookmarks'
export const X_LISTS: readonly XList[] = ['likes', 'bookmarks']
export const LIST_SIGNAL: Record<XList, XSignal> = { likes: 'like', bookmarks: 'bookmark' }
/** `/i/bookmarks` redirects to `/i/history`, whose first tab is Bookmarks. */
export const LIST_URL: Record<XList, string> = {
  likes: 'https://x.com/i/history/likes',
  bookmarks: 'https://x.com/i/history',
}

/** What the browser reads from one `article`, unchecked. */
export interface RawRow {
  /** Every `a[href]` attribute value in the article, in document order. */
  hrefs: string[]
  /** The href of the link around the article's first `time`, the post's own link. */
  timeHref: string | null
  datetime: string | null
  /** innerText of `[data-testid="tweetText"]`; empty for a media-only post. */
  text: string
  /** A photo or video element was found. */
  hasMediaElement: boolean
  /**
   * An X Article card (`article-cover-image` and the card around it): its visible lines, title first, then the
   * summary. Absent or empty for an ordinary post.
   */
  article?: string[]
}

/** One post as read from a list, before it is merged into the store. */
export interface Row {
  id: string
  url: string
  author: string
  text: string
  postedAt: string | null
  hasMedia: boolean
  textEmpty: boolean
}

const STATUS_PATH = /^\/([^/]+)\/status\/(\d+)$/
const MEDIA_PATH = /^\/[^/]+\/status\/\d+\/(?:photo|video)\/\d+$/

/** The post link is the one around `time`; otherwise the first `/<handle>/status/<id>` link. No link: not a post. */
export function parseRow(raw: RawRow): Row | undefined {
  const hrefs = raw.hrefs.filter((h): h is string => typeof h === 'string')
  const own = raw.timeHref && STATUS_PATH.test(raw.timeHref) ? raw.timeHref : hrefs.find((h) => STATUS_PATH.test(h))
  const m = own ? STATUS_PATH.exec(own) : null
  if (!m) return undefined
  const [, author, statusId] = m as unknown as [string, string, string]
  const postText = typeof raw.text === 'string' ? raw.text.trim() : ''
  // An Article has no post text of its own; its card's title and summary stand in for it (after the post text, if any).
  const article = Array.isArray(raw.article)
    ? raw.article.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean)
    : []
  const text = [postText, ...article].filter(Boolean).join('\n\n')
  const postedAt = typeof raw.datetime === 'string' && !Number.isNaN(Date.parse(raw.datetime)) ? raw.datetime : null
  return {
    id: `x:${statusId}`,
    url: `https://x.com/${author}/status/${statusId}`,
    author,
    text,
    postedAt,
    hasMedia: raw.hasMediaElement === true || hrefs.some((h) => MEDIA_PATH.test(h)),
    textEmpty: text === '',
  }
}

/** X sends a logged-out profile to onboarding or login; collection must fail then, never report "nothing new". */
export function isLoggedOutUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url)
    if (!/(^|\.)(x|twitter)\.com$/.test(hostname)) return false
    return /^\/(i\/jf\/|i\/flow\/login|login|logout)/.test(pathname)
  } catch {
    return false
  }
}

export class LoggedOutError extends Error {}

export function assertLoggedIn(url: string): void {
  if (isLoggedOutUrl(url)) {
    throw new LoggedOutError(`X is logged out in the ego-browser Default profile (page went to ${url}); log in there and rerun`)
  }
}

/** Progress through one list in one run. */
export interface ScanState {
  /** ids seen in this run, in first-seen order */
  seen: string[]
  rows: Row[]
  /** Known posts in a row, counted over posts new to this run. */
  knownRun: number
  /** Scrolls in a row that showed no post new to this run. */
  emptySteps: number
  earliestPostedAt: string | null
  stopped: boolean
}

export const newScan = (): ScanState => ({
  seen: [],
  rows: [],
  knownRun: 0,
  emptySteps: 0,
  earliestPostedAt: null,
  stopped: false,
})

/**
 * Adds the rows of one extraction. Rows already seen in this run (the page shows overlapping windows)
 * are dropped and neither count as known nor reset the count. With `knownStop`, the scan stops at the
 * row that makes `knownStop` known posts in a row; rows after it are not taken.
 */
export function scanStep(
  state: ScanState,
  raw: readonly RawRow[],
  isKnown: (id: string) => boolean,
  knownStop?: number,
): { state: ScanState; fresh: Row[] } {
  const seen = new Set(state.seen)
  const fresh: Row[] = []
  let { knownRun, earliestPostedAt, stopped } = state
  for (const r of raw) {
    if (stopped) break
    const row = parseRow(r)
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    fresh.push(row)
    if (row.postedAt && (earliestPostedAt === null || row.postedAt < earliestPostedAt)) earliestPostedAt = row.postedAt
    knownRun = isKnown(row.id) ? knownRun + 1 : 0
    if (knownStop !== undefined && knownRun >= knownStop) stopped = true
  }
  return {
    fresh,
    state: {
      seen: [...state.seen, ...fresh.map((r) => r.id)],
      rows: [...state.rows, ...fresh],
      knownRun,
      emptySteps: fresh.length === 0 ? state.emptySteps + 1 : 0,
      earliestPostedAt,
      stopped,
    },
  }
}

/** Five scrolls in a row with nothing new: the list ended or stopped loading. */
export const END_AFTER_EMPTY_SCROLLS = 5

export interface MergeResult {
  items: XItem[]
  /** Posts new to the store. */
  added: string[]
  /** Posts already stored that gained this Signal. */
  signalAdded: string[]
}

/**
 * Merges rows read from one list into the stored X Items. A stored post only gains the Signal; its text,
 * postedAt and collectedAt stay, so its inputHash and Classification stay valid. Skipped Items are ignored.
 */
export function mergeRows(
  existing: readonly XItem[],
  rows: readonly Row[],
  signal: XSignal,
  collectedAt: string,
  skipped: ReadonlySet<string>,
): MergeResult {
  const byId = new Map(existing.map((i) => [i.id, i]))
  const added: string[] = []
  const signalAdded: string[] = []
  for (const row of rows) {
    if (skipped.has(row.id)) continue
    const before = byId.get(row.id)
    if (!before) {
      byId.set(row.id, { ...row, source: 'x', signals: [signal], collectedAt })
      added.push(row.id)
    } else if (!before.signals.includes(signal)) {
      byId.set(row.id, { ...before, signals: [...before.signals, signal].sort() as XSignal[] })
      signalAdded.push(row.id)
    }
  }
  return { items: [...byId.values()], added, signalAdded }
}

/** One logged-in browser session on one X list at a time. Each method is one browser call. */
export interface XBrowser {
  /** Opens the list at the top. `empty`: the page shows the list's empty state. Throws when logged out. */
  load(list: XList): Promise<{ rows: RawRow[]; empty: boolean }>
  /** Scrolls once, waits, and returns the posts now rendered. Throws when logged out. */
  scroll(): Promise<RawRow[]>
  /** Ends the browser task space. Always called. */
  close(): Promise<void>
}

export type OpenXBrowser = () => Promise<XBrowser>

export interface ListResult {
  list: XList
  signal: XSignal
  scrolls: number
  /** Posts read in this run. */
  seen: number
  added: number
  signalAdded: number
  /** Known posts in a row when the scan ended. */
  knownRun: number
  stoppedBy: 'known' | 'maxScrolls' | 'end' | 'empty' | 'interrupted'
}

export interface CollectOptions {
  lists: readonly XList[]
  maxScrolls: number
  /** Daily collection only: stop after this many known posts in a row. */
  knownStop?: number
  openBrowser: OpenXBrowser
  now?: () => Date
  /** Checked between scrolls; backfill then saves and ends normally. */
  signal?: AbortSignal
}

async function withBrowser<T>(open: OpenXBrowser, fn: (b: XBrowser) => Promise<T>): Promise<T> {
  const browser = await open()
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

/** Store writer for one list: merges the given rows and saves when anything changed. */
async function saveRows(storeDir: string, rows: Row[], signal: XSignal, collectedAt: string) {
  await mkdir(storeDir, { recursive: true })
  return withStoreLock(storeDir, async () => {
    const skipped = new Set(Object.keys(await loadSkipped(storeDir)))
    const merged = mergeRows(await loadXItems(storeDir), rows, signal, collectedAt, skipped)
    if (merged.added.length || merged.signalAdded.length) await saveXItems(storeDir, merged.items)
    return merged
  })
}

/**
 * Scans one list from the top. `isKnown` decides what counts toward the known-stop (see knownIds). Calls `flush` with the
 * rows not yet flushed every `flushEvery` scrolls and once at the end, even after an error.
 */
async function scanList(
  browser: XBrowser,
  list: XList,
  isKnown: (id: string) => boolean,
  options: CollectOptions,
  flush: (rows: Row[], state: ScanState, scrolls: number, done: ListResult['stoppedBy'] | null) => Promise<void>,
  flushEvery: number,
): Promise<{ state: ScanState; scrolls: number; stoppedBy: ListResult['stoppedBy'] }> {
  let state = newScan()
  let scrolls = 0
  let unflushed: Row[] = []
  let stoppedBy: ListResult['stoppedBy'] | null = null
  try {
    const first = await browser.load(list)
    ;({ state } = scanStep(state, first.rows, isKnown, options.knownStop))
    unflushed = [...state.rows]
    if (first.empty && state.rows.length === 0) stoppedBy = 'empty'
    while (stoppedBy === null) {
      if (state.stopped) stoppedBy = 'known'
      else if (state.emptySteps >= END_AFTER_EMPTY_SCROLLS) stoppedBy = 'end'
      else if (options.signal?.aborted) stoppedBy = 'interrupted'
      else if (scrolls >= options.maxScrolls) stoppedBy = 'maxScrolls'
      else {
        const step = scanStep(state, await browser.scroll(), isKnown, options.knownStop)
        scrolls++
        state = step.state
        unflushed.push(...step.fresh)
        if (scrolls % flushEvery === 0) {
          await flush(unflushed, state, scrolls, null)
          unflushed = []
        }
      }
    }
    await flush(unflushed, state, scrolls, stoppedBy)
    return { state, scrolls, stoppedBy }
  } catch (e) {
    // Keep whatever was read before the failure.
    await flush(unflushed, state, scrolls, null).catch(() => undefined)
    throw e
  }
}

/**
 * What counts as known on one list: a post stored with this list's Signal, or a Skipped Item. A post known as a like
 * is still new to the bookmarks list, since it has to gain the bookmark Signal there. Skipped Items carry no Signal and
 * need nothing from either list, so they are known on both.
 */
export function knownIds(items: readonly XItem[], skipped: Record<string, unknown>, signal: XSignal): Set<string> {
  return new Set([...items.filter((i) => i.signals.includes(signal)).map((i) => i.id), ...Object.keys(skipped)])
}

/** Daily collection: from the top of each list until `knownStop` known posts in a row, the end, or `maxScrolls`. */
export async function collectX(storeDir: string, options: CollectOptions): Promise<ListResult[]> {
  const now = options.now ?? (() => new Date())
  return withBrowser(options.openBrowser, async (browser) => {
    const results: ListResult[] = []
    for (const list of options.lists) {
      const signal = LIST_SIGNAL[list]
      const collectedAt = now().toISOString()
      const known = knownIds(await loadXItems(storeDir), await loadSkipped(storeDir), signal)
      let added = 0
      let signalAdded = 0
      const scan = await scanList(
        browser,
        list,
        (id) => known.has(id),
        options,
        async (rows) => {
          const m = await saveRows(storeDir, rows, signal, collectedAt)
          added += m.added.length
          signalAdded += m.signalAdded.length
        },
        Number.POSITIVE_INFINITY,
      )
      results.push({
        list,
        signal,
        scrolls: scan.scrolls,
        seen: scan.state.rows.length,
        added,
        signalAdded,
        knownRun: scan.state.knownRun,
        stoppedBy: scan.stoppedBy,
      })
    }
    return results
  })
}

export interface BackfillResult extends ListResult {
  reach: BackfillReach
}

export const BACKFILL_FLUSH_EVERY = 10

/** Backfill: one long scroll per list, saving every 10 scrolls and recording how far it got. */
export async function backfillX(storeDir: string, options: CollectOptions): Promise<BackfillResult[]> {
  const now = options.now ?? (() => new Date())
  return withBrowser(options.openBrowser, async (browser) => {
    const results: BackfillResult[] = []
    for (const list of options.lists) {
      const signal = LIST_SIGNAL[list]
      const startedAt = now().toISOString()
      let added = 0
      let signalAdded = 0
      let reach: BackfillReach | undefined
      const scan = await scanList(
        browser,
        list,
        () => false,
        { ...options, knownStop: undefined },
        async (rows, state, scrolls, done) => {
          const m = await saveRows(storeDir, rows, signal, startedAt)
          added += m.added.length
          signalAdded += m.signalAdded.length
          reach = {
            startedAt,
            updatedAt: now().toISOString(),
            scrolls,
            seen: state.rows.length,
            added,
            earliestPostedAt: state.earliestPostedAt,
            reachedEnd: done === 'end' || done === 'empty',
            finished: done !== null && done !== 'interrupted',
          }
          await mkdir(storeDir, { recursive: true })
          await saveBackfillReach(storeDir, signal, reach)
        },
        BACKFILL_FLUSH_EVERY,
      )
      results.push({
        list,
        signal,
        scrolls: scan.scrolls,
        seen: scan.state.rows.length,
        added,
        signalAdded,
        knownRun: scan.state.knownRun,
        stoppedBy: scan.stoppedBy,
        reach: reach!,
      })
    }
    return results
  })
}
