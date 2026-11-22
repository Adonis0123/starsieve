// The one data shape the page renders, built two ways: from the whole Private Store for the Panel, and from the Public
// Projection alone for the public site. The site path never sees a store Item, only what project() let through.
import { skippedUrl } from '../core/override.ts'
import {
  type BackfillDoc,
  loadBackfill,
  loadCategories,
  loadClassifications,
  loadItems,
  loadSkipped,
  requireStore,
} from '../core/store.ts'
import type { Source, Visibility } from '../core/types.ts'
import { type PublicDoc, publicKey } from '../publish/projection.ts'

/** One card. Optional fields exist only in the Panel; the site leaves them out. */
export interface ViewItem {
  /** Item id in the Panel (what override takes); the public key (id or url) on the site. */
  key: string
  source: Source
  /** Repository full name, or `@handle` for an X post. */
  title: string
  url: string
  summary: string
  /** GitHub description. */
  description: string | null
  /** null: no Classification yet. */
  category: string | null
  tags: string[]
  language: string | null
  /** When it was saved, for "Recently added": star time; for X, when starsieve first saw it. */
  addedAt: string
  /** `star`, `like`, `bookmark`. Panel only. */
  signals?: string[]
  /** Star count of a GitHub Item. */
  stars?: number
  /** X post text, Panel only, shown while there is no Summary. */
  text?: string
  visibility?: Visibility
  /** Also on the site: a public Item the Classifier was not sure about is shown as "Needs review". */
  needsReview?: boolean
  locked?: boolean
  repoPrivate?: boolean
  archived?: boolean
}

export interface SkippedView {
  id: string
  url: string
  skippedAt: string
}

export interface ReachView {
  signal: 'like' | 'bookmark'
  seen: number
  added: number
  earliestPostedAt: string | null
  reachedEnd: boolean
  finished: boolean
  updatedAt: string
}

export interface PanelData {
  categories: string[]
  items: ViewItem[]
  skipped: SkippedView[]
  reach: ReachView[]
}

export interface SiteData {
  categories: string[]
  items: ViewItem[]
}

/** Every Item with its Classification, newest first. */
export async function panelData(storeDir: string): Promise<PanelData> {
  await requireStore(storeDir)
  const [items, classifications, skipped, backfill, table] = await Promise.all([
    loadItems(storeDir),
    loadClassifications(storeDir),
    loadSkipped(storeDir),
    loadBackfill(storeDir),
    loadCategories(storeDir),
  ])
  const views: ViewItem[] = items.map((item) => {
    const c = classifications[item.id]
    const base = {
      key: item.id,
      source: item.source,
      summary: c?.summary ?? '',
      category: c ? c.category : null,
      tags: c?.tags ?? [],
      ...(c ? { visibility: c.visibility, needsReview: c.needsReview, locked: c.locked } : {}),
    }
    if (item.source === 'github') {
      return {
        ...base,
        title: item.name,
        url: item.url,
        description: item.description,
        language: item.language,
        addedAt: item.starredAt,
        signals: ['star'],
        stars: item.stargazers,
        repoPrivate: item.repoPrivate,
        archived: item.archived,
      }
    }
    return {
      ...base,
      title: item.author ? `@${item.author}` : item.id,
      url: item.url,
      description: null,
      language: null,
      addedAt: item.collectedAt,
      signals: [...item.signals],
      text: item.text,
    }
  })
  return {
    categories: (table?.categories ?? []).map((x) => x.name),
    items: sortNewest(views),
    skipped: Object.entries(skipped)
      .map(([id, s]) => ({ id, url: skippedUrl(id), skippedAt: s.skippedAt }))
      .sort((a, b) => (a.skippedAt < b.skippedAt ? 1 : a.skippedAt > b.skippedAt ? -1 : a.id < b.id ? -1 : 1)),
    reach: reachViews(backfill),
  }
}

function reachViews(doc: BackfillDoc): ReachView[] {
  const out: ReachView[] = []
  for (const signal of ['like', 'bookmark'] as const) {
    const r = doc.x[signal]
    if (!r) continue
    out.push({
      signal,
      seen: r.seen,
      added: r.added,
      earliestPostedAt: r.earliestPostedAt,
      reachedEnd: r.reachedEnd,
      finished: r.finished,
      updatedAt: r.updatedAt,
    })
  }
  return out
}

/** The site's cards, from the Public Projection only: nothing project() did not let through can appear. */
export function siteData(doc: PublicDoc, categories: string[]): SiteData {
  const items: ViewItem[] = doc.items.map((p) => {
    if ('id' in p) {
      return {
        key: publicKey(p),
        source: 'github',
        title: p.name,
        url: p.url,
        summary: p.summary,
        description: p.description,
        category: p.category,
        tags: p.tags,
        language: p.language,
        addedAt: p.addedAt,
        stars: p.stargazers,
        needsReview: p.needsReview,
        archived: p.archived,
      }
    }
    return {
      key: publicKey(p),
      source: 'x',
      title: `@${p.author}`,
      url: p.url,
      summary: p.summary,
      description: null,
      category: p.category,
      tags: p.tags,
      language: null,
      addedAt: p.addedAt,
      needsReview: p.needsReview,
    }
  })
  return { categories, items: sortNewest(items) }
}

function sortNewest(items: ViewItem[]): ViewItem[] {
  return items.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.key < b.key ? -1 : 1))
}
