// The Private Store on disk. Layout is documented in README.md ("Store layout").
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '../run/lock.ts'
import { readJson, writeJson } from './json.ts'
import {
  type BackfillReach,
  type CategoryTable,
  type Classification,
  type Config,
  type GithubItem,
  type Item,
  SCHEMA_VERSION,
  type SkippedItem,
  type XItem,
  type XSignal,
} from './types.ts'

export const DEFAULT_CLASSIFIER_COMMAND = [
  'cursor-agent',
  '-p',
  '--model',
  'grok-4.7-medium',
  '--mode',
  'ask',
  '--sandbox',
  'enabled',
  '--trust',
  '--workspace',
  '{workspace}',
  '--output-format',
  'text',
  '{prompt}',
]
/** ADR 0001 measured 166 s for 10 Items; a Batch of 25 needs headroom. */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export const paths = {
  items: (dir: string) => join(dir, 'items', 'github.json'),
  xItems: (dir: string) => join(dir, 'items', 'x.json'),
  skipped: (dir: string) => join(dir, 'skipped.json'),
  backfill: (dir: string) => join(dir, 'backfill.json'),
  classifications: (dir: string) => join(dir, 'classifications.json'),
  categories: (dir: string) => join(dir, 'categories.json'),
  config: (dir: string) => join(dir, 'config.json'),
  publishState: (dir: string) => join(dir, 'publish-state.json'),
  ownerKept: (dir: string) => join(dir, 'owner-kept.json'),
  heartbeat: (dir: string) => join(dir, 'heartbeat.json'),
  /** Exists only while a writer holds it; `run` leaves it (and its temporary files) out of every store commit. */
  writeLock: (dir: string) => join(dir, STORE_LOCK),
}

export const STORE_LOCK = '.starsieve-write.lock'

/**
 * Every read-modify-write of the store (apply, override, unskip, collect) runs inside this lock, so a Panel edit and a
 * run in another process never overwrite each other with an older read. Hold it only around reading and saving files,
 * never around the Classifier or the browser, and never nest it.
 */
export async function withStoreLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withLock(paths.writeLock(dir), fn)
}

function checkVersion(path: string, doc: { schemaVersion?: unknown }): void {
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${path}: schemaVersion ${String(doc.schemaVersion)} is not supported (expected ${SCHEMA_VERSION})`)
  }
}

export async function requireStore(dir: string): Promise<void> {
  const s = await stat(dir).catch(() => undefined)
  if (!s?.isDirectory()) throw new Error(`store ${dir} does not exist; run "starsieve collect github --store ${dir}" first`)
}

function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

async function loadList<T>(path: string): Promise<T[]> {
  const doc = await readJson<{ schemaVersion: number; items: T[] }>(path)
  if (!doc) return []
  checkVersion(path, doc)
  return doc.items
}

export async function loadGithubItems(dir: string): Promise<GithubItem[]> {
  return loadList<GithubItem>(paths.items(dir))
}

export async function saveGithubItems(dir: string, items: GithubItem[]): Promise<void> {
  await writeJson(paths.items(dir), { schemaVersion: SCHEMA_VERSION, items: byId(items) })
}

export async function loadXItems(dir: string): Promise<XItem[]> {
  return loadList<XItem>(paths.xItems(dir))
}

export async function saveXItems(dir: string, items: XItem[]): Promise<void> {
  await writeJson(paths.xItems(dir), { schemaVersion: SCHEMA_VERSION, items: byId(items) })
}

/** Every Item of every Source. */
export async function loadItems(dir: string): Promise<Item[]> {
  return [...(await loadGithubItems(dir)), ...(await loadXItems(dir))]
}

/** Skipped Items by id. */
export async function loadSkipped(dir: string): Promise<Record<string, SkippedItem>> {
  const path = paths.skipped(dir)
  const doc = await readJson<{ schemaVersion: number; skipped: Record<string, SkippedItem> }>(path)
  if (!doc) return {}
  checkVersion(path, doc)
  return doc.skipped
}

export async function saveSkipped(dir: string, skipped: Record<string, SkippedItem>): Promise<void> {
  await writeJson(paths.skipped(dir), { schemaVersion: SCHEMA_VERSION, skipped })
}

export type BackfillDoc = { schemaVersion: number; x: Partial<Record<XSignal, BackfillReach>> }

export async function loadBackfill(dir: string): Promise<BackfillDoc> {
  const path = paths.backfill(dir)
  const doc = await readJson<BackfillDoc>(path)
  if (!doc) return { schemaVersion: SCHEMA_VERSION, x: {} }
  checkVersion(path, doc)
  return doc
}

export async function saveBackfillReach(dir: string, signal: XSignal, reach: BackfillReach): Promise<void> {
  const doc = await loadBackfill(dir)
  doc.x[signal] = reach
  await writeJson(paths.backfill(dir), doc)
}

export async function loadClassifications(dir: string): Promise<Record<string, Classification>> {
  const path = paths.classifications(dir)
  const doc = await readJson<{ schemaVersion: number; classifications: Record<string, Classification> }>(path)
  if (!doc) return {}
  checkVersion(path, doc)
  return doc.classifications
}

export async function saveClassifications(dir: string, map: Record<string, Classification>): Promise<void> {
  await writeJson(paths.classifications(dir), { schemaVersion: SCHEMA_VERSION, classifications: map })
}

export async function loadCategories(dir: string): Promise<CategoryTable | undefined> {
  const path = paths.categories(dir)
  const doc = await readJson<CategoryTable>(path)
  if (doc) checkVersion(path, doc)
  return doc
}

export async function saveCategoriesTable(dir: string, table: CategoryTable): Promise<void> {
  await writeJson(paths.categories(dir), table)
}

export async function requireCategories(dir: string): Promise<CategoryTable> {
  const table = await loadCategories(dir)
  if (!table) throw new Error(`no Category Table in ${dir}; run "starsieve categories init --store ${dir}" first`)
  return table
}

export async function loadConfig(dir: string): Promise<Config> {
  const path = paths.config(dir)
  const doc = await readJson<{ schemaVersion: number; classifier?: Partial<Config['classifier']> }>(path)
  if (doc) checkVersion(path, doc)
  const command = doc?.classifier?.command ?? DEFAULT_CLASSIFIER_COMMAND
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string')) {
    throw new Error(`${path}: classifier.command must be a non-empty array of strings`)
  }
  const timeoutMs = doc?.classifier?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
    throw new Error(`${path}: classifier.timeoutMs must be a positive number`)
  }
  return { classifier: { command, timeoutMs } }
}

/** X posts the owner took back from the Skipped Items (`override --unskip`): the Classifier can never skip them again. */
export async function loadOwnerKept(dir: string): Promise<Record<string, { keptAt: string }>> {
  const path = paths.ownerKept(dir)
  const doc = await readJson<{ schemaVersion: number; kept: Record<string, { keptAt: string }> }>(path)
  if (!doc) return {}
  checkVersion(path, doc)
  return doc.kept
}

export async function saveOwnerKept(dir: string, kept: Record<string, { keptAt: string }>): Promise<void> {
  await writeJson(paths.ownerKept(dir), { schemaVersion: SCHEMA_VERSION, kept })
}

export interface PublishState {
  schemaVersion: number
  projectionHash: string
  /** The hash without star counts, which change every day and alone never make a publish. Missing in old files. */
  contentHash?: string
  itemCount: number
}

export async function loadPublishState(dir: string): Promise<PublishState | undefined> {
  return readJson<PublishState>(paths.publishState(dir))
}

export async function savePublishState(dir: string, state: Omit<PublishState, 'schemaVersion'>): Promise<void> {
  await writeJson(paths.publishState(dir), { schemaVersion: SCHEMA_VERSION, ...state })
}
