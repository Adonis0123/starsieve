// apply: the only write path for Classifications from a Batch (ADR 0001).
import { batchIdOf, inputHash } from './batch.ts'
import { cleanSummary, cleanTags } from './sanitize.ts'
import {
  loadClassifications,
  loadItems,
  loadOwnerKept,
  loadSkipped,
  loadXItems,
  requireCategories,
  requireStore,
  saveClassifications,
  withStoreLock,
  saveSkipped,
  saveXItems,
} from './store.ts'
import {
  type BatchEntry,
  type Classification,
  type SkippedItem,
  MAX_SUMMARY,
  MAX_TAGS,
  SCHEMA_VERSION,
  UNCATEGORIZED,
  type Visibility,
} from './types.ts'

/** A Batch (ids and inputHashes as `pending` printed them) plus the Classifier's answer for it. */
export interface ApplyInput {
  schemaVersion: unknown
  batchId: unknown
  items: unknown
  classifications: unknown
}

/** `skipped`: Locked, left as it is. `skippedItem`: an X post judged not technical, turned into a Skipped Item. */
export type EntryStatus = 'accepted' | 'rejected' | 'skipped' | 'skippedItem'

export interface EntryResult {
  id: string
  status: EntryStatus
  /** Why it was rejected or skipped. */
  reasons: string[]
  /** What apply changed on an accepted entry (category fallback, truncation, default visibility). */
  warnings: string[]
}

export interface ApplyResult {
  batchId: string
  accepted: number
  rejected: number
  skipped: number
  /** X posts the Classifier judged not technical (`keep: false`); their text is gone from the store. */
  skippedItems: number
  /** Batch ids the Classifier gave no answer for; they stay pending. */
  missing: string[]
  results: EntryResult[]
}

export class ApplyInputError extends Error {}

function parseBatchEntries(value: unknown): BatchEntry[] {
  if (!Array.isArray(value)) throw new ApplyInputError('items must be the Batch item list from "starsieve pending"')
  return value.map((e, i) => {
    const entry = e as Partial<BatchEntry> | null
    if (typeof entry?.id !== 'string' || typeof entry.inputHash !== 'string') {
      throw new ApplyInputError(`items[${i}] needs a string id and inputHash`)
    }
    return { id: entry.id, inputHash: entry.inputHash }
  })
}

/**
 * Validates the whole file first (schemaVersion, batchId matches its items, Category Table exists),
 * then each Classification on its own. Writes only accepted entries, in one write.
 */
export async function applyBatch(storeDir: string, input: ApplyInput, now: () => Date = () => new Date()): Promise<ApplyResult> {
  if (input === null || typeof input !== 'object') throw new ApplyInputError('apply input must be a JSON object')
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new ApplyInputError(`schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(input.schemaVersion)}`)
  }
  const entries = parseBatchEntries(input.items)
  if (typeof input.batchId !== 'string' || input.batchId !== batchIdOf(entries)) {
    throw new ApplyInputError(`batchId ${JSON.stringify(input.batchId)} does not match the Batch items`)
  }
  if (!Array.isArray(input.classifications)) throw new ApplyInputError('classifications must be an array')

  await requireStore(storeDir)
  // Read, decide and write under the store lock: a Panel edit made while the Classifier ran is read here, and a
  // Locked entry is never overwritten with an older copy of classifications.json.
  return withStoreLock(storeDir, () => applyLocked(storeDir, input.batchId as string, entries, input.classifications as unknown[], now))
}

async function applyLocked(storeDir: string, batchId: string, entries: BatchEntry[], answer: unknown[], now: () => Date): Promise<ApplyResult> {
  const table = await requireCategories(storeDir)
  const categoryNames = new Set(table.categories.map((c) => c.name))
  const items = new Map((await loadItems(storeDir)).map((i) => [i.id, i]))
  const existing = await loadClassifications(storeDir)
  const ownerKept = await loadOwnerKept(storeDir)
  const batchHash = new Map(entries.map((e) => [e.id, e.inputHash]))

  const next = { ...existing }
  const results: EntryResult[] = []
  const answered = new Set<string>()
  const toSkip: string[] = []

  for (const raw of answer) {
    const c = (raw ?? {}) as Record<string, unknown>
    const id = typeof c.id === 'string' ? c.id : ''
    const reasons: string[] = []
    const warnings: string[] = []
    const reject = (reason: string) => results.push({ id, status: 'rejected', reasons: [reason], warnings })

    if (!id) {
      reject('missing id')
      continue
    }
    if (answered.has(id)) {
      reject('duplicate id in this answer')
      continue
    }
    answered.add(id)
    const item = items.get(id)
    if (!item) {
      reject('no such Item in the store')
      continue
    }
    if (existing[id]?.locked) {
      results.push({ id, status: 'skipped', reasons: ['Locked: changed by the owner'], warnings })
      continue
    }
    const expected = batchHash.get(id)
    if (expected === undefined) {
      reject('Item is not in this Batch')
      continue
    }
    const current = inputHash(item)
    if (current !== expected) {
      reject('inputHash differs: the Item changed after the Batch was built')
      continue
    }

    if (item.source === 'x') {
      // keep is only read for X: post text is untrusted, and it must never be able to drop a GitHub star.
      if (typeof c.keep !== 'boolean') {
        reject('X Items need keep: true or false')
        continue
      }
      if (!c.keep && Object.hasOwn(ownerKept, id)) {
        // The owner took this post back from the Skipped Items: it stays, and waits for the owner to look at it.
        warnings.push('the owner kept this post; keep false ignored, set to Needs Review')
      } else if (!c.keep) {
        toSkip.push(id)
        delete next[id]
        results.push({ id, status: 'skippedItem', reasons: ['not technical: kept only as a Skipped Item id'], warnings })
        continue
      }
    } else if (c.keep === false) {
      warnings.push('keep is only read for X Items; ignored')
    }

    const keptByOwner = item.source === 'x' && c.keep === false
    let category = typeof c.category === 'string' ? c.category : ''
    let needsReview = c.needsReview === true || keptByOwner
    if (!categoryNames.has(category)) {
      warnings.push(`category ${JSON.stringify(category)} is not in the Category Table; set to ${UNCATEGORIZED}`)
      category = UNCATEGORIZED
      needsReview = true
    }

    let tags = cleanTags(c.tags)
    if (tags.length > MAX_TAGS) {
      warnings.push(`${tags.length} tags; kept the first ${MAX_TAGS}`)
      tags = tags.slice(0, MAX_TAGS)
    }

    const { summary, stripped, truncated } = cleanSummary(c.summary)
    if (stripped) warnings.push('removed links or HTML from the summary')
    if (truncated) warnings.push(`summary cut to ${MAX_SUMMARY} characters`)

    let visibility: Visibility = 'private'
    if (c.visibility === 'public' || c.visibility === 'private') visibility = c.visibility
    else warnings.push(`visibility ${JSON.stringify(c.visibility)} is not public/private; set to private`)

    // A post with no text could not be judged: it waits for the owner, and stays private until then.
    if (item.source === 'x' && item.textEmpty && (visibility !== 'private' || !needsReview)) {
      warnings.push('the post has no text; set to private and Needs Review')
      visibility = 'private'
      needsReview = true
    }

    const classification: Classification = {
      category,
      tags,
      summary,
      visibility,
      needsReview,
      locked: false,
      by: 'classifier',
      inputHash: current,
    }
    next[id] = classification
    results.push({ id, status: 'accepted', reasons, warnings })
  }

  const accepted = results.filter((r) => r.status === 'accepted').length
  if (toSkip.length > 0) {
    // Skipped ids first, then drop the text, then the Classifications: an interruption can leave a
    // post both skipped and still stored, never forgotten.
    const skipped: Record<string, SkippedItem> = await loadSkipped(storeDir)
    const skippedAt = now().toISOString()
    for (const id of toSkip) skipped[id] = { skippedAt }
    await saveSkipped(storeDir, skipped)
    const gone = new Set(toSkip)
    await saveXItems(storeDir, (await loadXItems(storeDir)).filter((i) => !gone.has(i.id)))
  }
  if (accepted > 0 || toSkip.some((id) => existing[id])) await saveClassifications(storeDir, next)
  return {
    batchId,
    accepted,
    rejected: results.filter((r) => r.status === 'rejected').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    skippedItems: toSkip.length,
    missing: entries.map((e) => e.id).filter((id) => !answered.has(id)),
    results,
  }
}
