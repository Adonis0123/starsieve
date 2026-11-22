// override: the owner changes a Classification by hand and it becomes Locked.
import { inputHash } from './batch.ts'
import { cleanSummary, cleanTags } from './sanitize.ts'
import {
  loadClassifications,
  loadItems,
  loadSkipped,
  requireCategories,
  loadOwnerKept,
  requireStore,
  saveClassifications,
  saveOwnerKept,
  saveSkipped,
  withStoreLock,
} from './store.ts'
import { type Classification, MAX_TAGS, UNCATEGORIZED, type Visibility } from './types.ts'

export interface OverrideChange {
  category?: string
  tags?: string[]
  visibility?: string
  /** Cleaned like the Classifier's: links and HTML removed, capped at MAX_SUMMARY code points. */
  summary?: string
}

export class OverrideError extends Error {}

export async function overrideItem(storeDir: string, id: string, change: OverrideChange): Promise<Classification> {
  await requireStore(storeDir)
  const table = await requireCategories(storeDir)
  const item = (await loadItems(storeDir)).find((i) => i.id === id)
  if (!item) throw new OverrideError(`no Item ${id} in the store`)

  if (change.category !== undefined && !table.categories.some((c) => c.name === change.category)) {
    const names = table.categories.map((c) => c.name).join(', ')
    throw new OverrideError(`category ${JSON.stringify(change.category)} is not in the Category Table (${names})`)
  }
  let tags: string[] | undefined
  if (change.tags !== undefined) {
    tags = cleanTags(change.tags)
    if (tags.length > MAX_TAGS) throw new OverrideError(`at most ${MAX_TAGS} tags, got ${tags.length}`)
  }
  let visibility: Visibility | undefined
  if (change.visibility !== undefined) {
    if (change.visibility !== 'public' && change.visibility !== 'private') {
      throw new OverrideError(`visibility must be public or private, got ${JSON.stringify(change.visibility)}`)
    }
    visibility = change.visibility
  }

  const summary = change.summary === undefined ? undefined : cleanSummary(change.summary).summary

  return withStoreLock(storeDir, async () => {
    const all = await loadClassifications(storeDir)
    const before = all[id]
    const next: Classification = {
      category: change.category ?? before?.category ?? UNCATEGORIZED,
      tags: tags ?? before?.tags ?? [],
      summary: summary ?? before?.summary ?? '',
      visibility: visibility ?? before?.visibility ?? 'private',
      needsReview: false,
      locked: true,
      by: 'owner',
      inputHash: inputHash(item),
    }
    all[id] = next
    await saveClassifications(storeDir, all)
    return next
  })
}

export interface UnskipResult {
  id: string
  /** Where the post can be seen; the Skipped Item kept no author, so this is X's handle-free status link. */
  url: string
}

/** `x:<status id>` -> the status link X redirects to the post. */
export function skippedUrl(id: string): string {
  return `https://x.com/i/status/${id.replace(/^x:/, '')}`
}

/**
 * Takes a post back out of the Skipped Items. Its text was deleted when it was skipped, so there is nothing to restore
 * here: the id is no longer known, and the next `collect x` or `backfill x` that reads the post stores it again as a new,
 * pending Item for the Classifier. The id is recorded as owner-kept, so `apply` never skips it again.
 */
export async function unskipItem(storeDir: string, id: string, now: () => Date = () => new Date()): Promise<UnskipResult> {
  await requireStore(storeDir)
  return withStoreLock(storeDir, async () => {
    const skipped = await loadSkipped(storeDir)
    if (!Object.hasOwn(skipped, id)) throw new OverrideError(`${id} is not a Skipped Item`)
    // Owner-kept first: an interruption can leave the id both kept and skipped, never unskipped but skippable again.
    const kept = await loadOwnerKept(storeDir)
    kept[id] = { keptAt: now().toISOString() }
    await saveOwnerKept(storeDir, kept)
    delete skipped[id]
    await saveSkipped(storeDir, skipped)
    return { id, url: skippedUrl(id) }
  })
}
