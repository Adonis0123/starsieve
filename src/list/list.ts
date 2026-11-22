// `starsieve list`: read-only search over the Private Store, so an agent finds Items without reading store files.
// The word rule is the Panel's `matches` (client.js): lowercase, split on whitespace, every word a substring. That
// function runs in the browser over ViewItems, which carry no topics, so the rule is repeated here over Item fields.
import { loadClassifications, loadItems, loadSkipped, requireStore } from '../core/store.ts'
import type { Classification, Item, Source, Visibility } from '../core/types.ts'

export const EXCERPT_CHARS = 120

export interface ListFilter {
  q?: string
  category?: string
  source?: Source
  visibility?: Visibility
  needsReview?: boolean
  limit: number
}

export interface ListEntry {
  id: string
  source: Source
  /** GitHub repository full name. */
  name?: string
  /** X post link. */
  url?: string
  author?: string
  /** The first 120 characters of an X post's text; the full text is never listed. */
  excerpt?: string
  /** null: no Classification yet. */
  category: string | null
  tags: string[]
  summary: string
  visibility: Visibility | null
  needsReview: boolean
  locked: boolean
  stargazers?: number
  addedAt: string
}

export interface ListResult {
  /** Matches before --limit. */
  total: number
  items: ListEntry[]
}

function addedAt(item: Item): string {
  return item.source === 'github' ? item.starredAt : item.collectedAt
}

function haystack(item: Item, c: Classification | undefined): string {
  const own =
    item.source === 'github' ? [item.name, item.description, ...item.topics] : [item.author, item.text]
  return [...own, c?.summary, ...(c?.tags ?? [])].filter(Boolean).join('\n').toLowerCase()
}

export function words(q: string | undefined): string[] {
  return (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

function entry(item: Item, c: Classification | undefined): ListEntry {
  const base = {
    id: item.id,
    source: item.source,
    category: c ? c.category : null,
    tags: c?.tags ?? [],
    summary: c?.summary ?? '',
    visibility: c ? c.visibility : null,
    needsReview: c?.needsReview ?? false,
    locked: c?.locked ?? false,
    addedAt: addedAt(item),
  }
  if (item.source === 'github') return { ...base, name: item.name, stargazers: item.stargazers }
  return { ...base, url: item.url, author: item.author, excerpt: [...item.text].slice(0, EXCERPT_CHARS).join('') }
}

/** Items matching every filter, newest first; Skipped Items never appear. */
export async function listItems(storeDir: string, f: ListFilter): Promise<ListResult> {
  await requireStore(storeDir)
  const [items, classifications, skipped] = await Promise.all([
    loadItems(storeDir),
    loadClassifications(storeDir),
    loadSkipped(storeDir),
  ])
  const ws = words(f.q)
  const hits = items.filter((item) => {
    if (item.id in skipped) return false
    if (f.source && item.source !== f.source) return false
    const c = classifications[item.id]
    if (f.category !== undefined && c?.category !== f.category) return false
    if (f.visibility && c?.visibility !== f.visibility) return false
    if (f.needsReview && c?.needsReview !== true) return false
    if (ws.length) {
      const hay = haystack(item, c)
      if (!ws.every((w) => hay.includes(w))) return false
    }
    return true
  })
  hits.sort((a, b) => {
    const x = addedAt(a)
    const y = addedAt(b)
    return x < y ? 1 : x > y ? -1 : a.id < b.id ? -1 : 1
  })
  return { total: hits.length, items: hits.slice(0, f.limit).map((i) => entry(i, classifications[i.id])) }
}

export function listText(r: ListResult): string {
  const lines = r.items.map((e) => {
    const title = e.name ?? `@${e.author} ${e.url}`
    const cat = e.category ?? '(unclassified)'
    const flags = [e.visibility, e.needsReview ? 'needs review' : '', e.locked ? 'locked' : ''].filter(Boolean).join(', ')
    const what = e.summary || e.excerpt || ''
    return `${e.id}\t${title}\t${cat}${flags ? ` [${flags}]` : ''}${what ? `\t${what.replace(/\s+/g, ' ')}` : ''}`
  })
  lines.push(`${r.items.length} of ${r.total} shown`)
  return lines.join('\n')
}
