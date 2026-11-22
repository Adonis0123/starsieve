// Cleaning text that may be published: Summaries and Tags come from the agent and go public automatically.
import { MAX_SUMMARY } from './types.ts'

const HTML_TAG = /<\/?[a-zA-Z!][^>]*>/g
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g
// ASCII only, so Chinese text right after a link survives.
const LINK = /\b(?:https?:\/\/|www\.)[\x21-\x7e]+/gi

/** Removes HTML tags and links, collapses whitespace. */
export function stripLinksAndHtml(text: string): string {
  return text.replace(HTML_TAG, ' ').replace(MD_LINK, '$1').replace(LINK, ' ').replace(/\s+/g, ' ').trim()
}

/** Code points, not UTF-16 units, so a Chinese Summary gets the full 80. */
export function capLength(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`
}

export function cleanSummary(value: unknown): { summary: string; stripped: boolean; truncated: boolean } {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  const clean = stripLinksAndHtml(raw)
  const summary = capLength(clean, MAX_SUMMARY)
  return { summary, stripped: clean !== raw, truncated: summary !== clean }
}

/** Trims, strips links and HTML, drops empties and case-insensitive duplicates. Does not cap the count. */
export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = capLength(stripLinksAndHtml(raw), 40)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}
