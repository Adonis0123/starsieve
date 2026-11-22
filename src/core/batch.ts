// Batch building: which Items still need a Classification, and the hash of what the Classifier sees.
import { canonical, sha256 } from './json.ts'
import {
  type Batch,
  type BatchEntry,
  type ClassificationInput,
  type Classification,
  type Item,
  SCHEMA_VERSION,
  type Source,
} from './types.ts'

export function classificationInput(item: Item): ClassificationInput {
  if (item.source === 'x') {
    return {
      id: item.id,
      source: 'x',
      url: item.url,
      author: item.author,
      text: item.text,
      textEmpty: item.textEmpty,
      hasMedia: item.hasMedia,
      postedAt: item.postedAt,
    }
  }
  return {
    id: item.id,
    name: item.name,
    url: item.url,
    description: item.description,
    language: item.language,
    topics: item.topics,
  }
}

/** sha256 over the classification input fields only, so volatile fields (stargazers, Signals) never stale a Batch. */
export function inputHash(item: Item): string {
  return sha256(canonical(classificationInput(item)))
}

/** Derived from the (id, inputHash) pairs, so the same pending set always gives the same batchId. */
export function batchIdOf(entries: readonly BatchEntry[]): string {
  const pairs = entries.map((e) => [e.id, e.inputHash]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
  return `batch-${sha256(canonical(pairs)).slice(0, 16)}`
}

/** A star of a private repository is never sent to the Classifier; `collect` classifies it as private itself. */
export function neverSentToClassifier(item: Item): boolean {
  return item.source === 'github' && item.repoPrivate
}

/** When the owner saved it: the star time, or when starsieve first saw the X post (X shows no like time). */
function savedAt(item: Item): string {
  return item.source === 'github' ? item.starredAt : item.collectedAt
}

function postedAt(item: Item): string {
  return item.source === 'x' ? (item.postedAt ?? '') : ''
}

/**
 * Items with no Classification (a Locked Item always has one), newest saved first, never a private repository's star.
 * A `collector` Classification of a repository that has since turned public counts as none.
 */
export function pendingItems(items: Item[], classifications: Record<string, Classification>, source?: Source): Item[] {
  return items
    .filter((item) => !neverSentToClassifier(item) && (source === undefined || item.source === source))
    .filter((item) => {
      const c = classifications[item.id]
      return !c || c.by === 'collector'
    })
    .sort(
      (a, b) =>
        (savedAt(a) < savedAt(b) ? 1 : savedAt(a) > savedAt(b) ? -1 : 0) ||
        (postedAt(a) < postedAt(b) ? 1 : postedAt(a) > postedAt(b) ? -1 : 0) ||
        (a.id < b.id ? -1 : 1),
    )
}

/** One Source per Batch: the given one, or else the Source of the newest pending Item. */
export function buildBatch(
  items: Item[],
  classifications: Record<string, Classification>,
  limit: number,
  source?: Source,
): Batch {
  const pending = pendingItems(items, classifications, source)
  const chosen = source ?? pending[0]?.source ?? null
  const picked = pending.filter((item) => item.source === chosen).slice(0, limit)
  const entries = picked.map((item) => ({ id: item.id, inputHash: inputHash(item), input: classificationInput(item) }))
  return { schemaVersion: SCHEMA_VERSION, batchId: batchIdOf(entries), source: picked.length ? chosen : null, items: entries }
}
