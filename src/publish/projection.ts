// Public Projection: the deterministic filter that runs before anything can be pushed (ADR 0002).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import GithubSlugger from 'github-slugger'
import { canonical, readJson, sha256, stableStringify, writeText } from '../core/json.ts'
import {
  loadCategories,
  loadClassifications,
  loadItems,
  loadPublishState,
  loadSkipped,
  requireStore,
  savePublishState,
} from '../core/store.ts'
import { pendingItems } from '../core/batch.ts'
import { translator } from '../panel/i18n.ts'
import { type Classification, type Item, SCHEMA_VERSION, type Source } from '../core/types.ts'

/** Allowlist of what a public GitHub Item carries. Nothing else from the store reaches the out directory. */
export interface PublicGithubItem {
  id: string
  url: string
  name: string
  description: string | null
  language: string | null
  topics: string[]
  archived: boolean
  /** Star count when published. It changes daily, so it alone never makes a publish (see contentHash). */
  stargazers: number
  starredAt: string
  /** When the owner saved it: the star time. */
  addedAt: string
  category: string
  tags: string[]
  summary: string
  needsReview: boolean
}

/** Allowlist for a public X Item: never the post text (ADR 0002). Keyed by url. */
export interface PublicXItem {
  url: string
  author: string
  postedAt: string | null
  /** When starsieve first saw it (X shows no like time). */
  addedAt: string
  category: string
  tags: string[]
  summary: string
  needsReview: boolean
}

export type PublicItem = PublicGithubItem | PublicXItem

/** The id of a public GitHub Item, the url of a public X Item. */
export function publicKey(item: PublicItem): string {
  return 'id' in item ? item.id : item.url
}

export function publicSource(item: PublicItem): Source {
  return 'id' in item ? 'github' : 'x'
}

function publicDate(item: PublicItem): string {
  return 'starredAt' in item ? item.starredAt : (item.postedAt ?? '')
}

export interface PublicDoc {
  schemaVersion: number
  items: PublicItem[]
}

/** Public only when a Classification exists and says public, and (for a star) the repository is public. */
export function isPublic(item: Item, c: Classification | undefined): c is Classification {
  if (c === undefined || c.visibility !== 'public') return false
  return item.source === 'x' || item.repoPrivate === false
}

/** Sorted by Category Table order, then newest first (star time, or post time for X), then id or url. */
export function sortPublic(items: PublicItem[], order: string[]): PublicItem[] {
  const rank = (cat: string) => {
    const i = order.indexOf(cat)
    return i === -1 ? order.length : i
  }
  return items.sort(
    (a, b) =>
      rank(a.category) - rank(b.category) ||
      a.category.localeCompare(b.category) ||
      (publicDate(a) < publicDate(b) ? 1 : publicDate(a) > publicDate(b) ? -1 : 0) ||
      (publicKey(a) < publicKey(b) ? -1 : 1),
  )
}

export function project(items: Item[], classifications: Record<string, Classification>, order: string[]): PublicDoc {
  const out: PublicItem[] = []
  for (const item of items) {
    const c = classifications[item.id]
    if (!isPublic(item, c)) continue
    if (item.source === 'x') {
      out.push({
        url: item.url,
        author: item.author,
        postedAt: item.postedAt,
        addedAt: item.collectedAt,
        category: c.category,
        tags: c.tags,
        summary: c.summary,
        needsReview: c.needsReview,
      })
      continue
    }
    out.push({
      id: item.id,
      url: item.url,
      name: item.name,
      description: item.description,
      language: item.language,
      topics: item.topics,
      archived: item.archived,
      stargazers: item.stargazers,
      starredAt: item.starredAt,
      addedAt: item.starredAt,
      category: c.category,
      tags: c.tags,
      summary: c.summary,
      needsReview: c.needsReview,
    })
  }
  return { schemaVersion: SCHEMA_VERSION, items: sortPublic(out, order) }
}

/**
 * Keeps the Items of `hold` Sources as `previous` has them (a Source whose collection failed is not published that day),
 * and takes every other Source from `doc`. `doc` is the store's Public Projection now, so a held Item stays only while
 * the store still has it as public (not removed, not made private, not skipped, not a private repository): holding a
 * Source freezes its fields, never what the owner took back.
 */
export function holdSources(doc: PublicDoc, previous: PublicDoc | undefined, hold: readonly Source[], order: string[]): PublicDoc {
  if (hold.length === 0) return doc
  const publicNow = new Set(doc.items.map(publicKey))
  const kept = (previous?.items ?? []).filter((i) => hold.includes(publicSource(i)) && publicNow.has(publicKey(i)))
  const fresh = doc.items.filter((i) => !hold.includes(publicSource(i)))
  return { schemaVersion: doc.schemaVersion, items: sortPublic([...fresh, ...kept], order) }
}

function md(text: string): string {
  return text.replace(/([\\`*_[\]<>|#])/g, '\\$1')
}

const code = (text: string) => `\`${text.replaceAll('`', '')}\``

/** What the README shows besides the Items; the caller reads it from the user config, so renderReadme stays pure. */
export interface ReadmeOptions {
  /** One line; default 技术收藏. */
  title?: string
  /** The public site; without it the README has no online-catalog link. */
  siteUrl?: string
  /** items.json relative to the README, following the layout. */
  dataPath?: string
}

/** The language once, then at most 3 Tags; the first Tag (what kind of thing it is) always stays. */
function itemMeta(item: PublicItem): string[] {
  const [first, ...rest] = item.tags
  const language = 'id' in item ? item.language : null
  const same = (t: string) => t.toLowerCase() === language?.toLowerCase()
  const showLanguage = language && !(first !== undefined && same(first))
  const tags = (first === undefined ? [] : [first, ...rest.filter((t) => !showLanguage || !same(t))]).slice(0, 3)
  return [showLanguage ? code(language) : '', tags.map(code).join(' ')].filter(Boolean)
}

/**
 * README catalog; only sanitized fields (name or author, url, Summary, Tags, language). No timestamps and no star
 * counts, so reruns match and a day where only stars moved leaves it unchanged.
 */
export function renderReadme(doc: PublicDoc, options: ReadmeOptions = {}): string {
  const t = translator('zh')
  const groups = new Map<string, PublicItem[]>()
  for (const item of doc.items) {
    const list = groups.get(item.category) ?? []
    list.push(item)
    groups.set(item.category, list)
  }
  const repos = doc.items.filter((i) => 'id' in i).length
  const posts = doc.items.length - repos
  const title = options.title ?? t('Tech collection')
  // GitHub's heading anchors, in document order: every heading takes its slug from the text it shows.
  const slugger = new GithubSlugger()
  slugger.slug(title)
  const lines = [`# ${md(title)}`, '']
  if (doc.items.length === 0) lines.push(t('Nothing published yet.'), '')
  else {
    const counts = (repos && posts ? t('{repos} GitHub repositories and {posts} X posts') : repos ? t('{repos} GitHub repositories') : t('{posts} X posts'))
      .replace('{repos}', String(repos))
      .replace('{posts}', String(posts))
    lines.push(t('Collects {items}, in {categories} Categories.').replace('{items}', counts).replace('{categories}', String(groups.size)), '')
  }
  if (options.siteUrl) lines.push(`**[${t('Open the online catalog →')}](${options.siteUrl})** ${t('Search, filter and sort by stars there.')}`, '')
  if (groups.size) {
    const contents = t('Contents')
    const top = slugger.slug(contents)
    const anchors = new Map([...groups.keys()].map((c) => [c, slugger.slug(c)]))
    lines.push(`## ${contents}`, '')
    for (const [category, list] of groups) lines.push(`- [${md(category)}](#${anchors.get(category)})（${list.length}）`)
    for (const [category, list] of groups) {
      lines.push('', `## ${md(category)}`, '')
      for (const item of list) {
        const link = 'id' in item ? `[${md(item.name)}](${item.url})` : `X · [@${md(item.author)}](${item.url})`
        const rest = [item.summary ? md(item.summary) : '', ...itemMeta(item)].filter(Boolean).join(' · ')
        lines.push(`- ${link}${rest ? ` — ${rest}` : ''}`)
      }
      lines.push('', `[${t('↑ Back to contents')}](#${top})`)
    }
    lines.push('')
  }
  const dataPath = options.dataPath ?? 'items.json'
  lines.push(
    '---',
    '',
    t('Data: {link}').replace('{link}', `[${dataPath}](${dataPath})`),
    '',
    options.siteUrl
      ? t('Categories and Summaries are sorted out with AI help; what still needs review is shown in the {catalog}.').replace(
          '{catalog}',
          `[${t('online catalog')}](${options.siteUrl})`,
        )
      : t('Categories and Summaries are sorted out with AI help.'),
    '',
    t('Generated by starsieve; do not edit by hand.'),
  )
  return `${lines.join('\n')}\n`
}

export interface PublishResult {
  dryRun: boolean
  out: string
  publicItems: number
  added: string[]
  removed: string[]
  changed: string[]
  readmeChanged: boolean
  identical: boolean
  /** Something other than star counts differs from what `out` holds. */
  contentChanged: boolean
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

export async function buildProjection(storeDir: string): Promise<PublicDoc> {
  await requireStore(storeDir)
  const table = await loadCategories(storeDir)
  return project(
    await loadItems(storeDir),
    await loadClassifications(storeDir),
    (table?.categories ?? []).map((c) => c.name),
  )
}

export function projectionHash(doc: PublicDoc): string {
  return sha256(canonical(doc))
}

/** The hash without star counts: a day where only star counts moved has nothing new to publish. */
export function contentHash(doc: PublicDoc | undefined): string {
  const items = (Array.isArray(doc?.items) ? doc.items : []).map((i) => {
    const { stargazers: _stars, ...rest } = i as PublicGithubItem
    return rest
  })
  return sha256(canonical({ schemaVersion: doc?.schemaVersion, items }))
}

export interface PublishOptions {
  /** `flat` (default): `out/items.json` and `out/README.md`. `repo`: the public repository's `data/items.json` and `README.md`. */
  layout?: 'flat' | 'repo'
  /** Sources whose collection failed: their Items stay as the public files have them now. */
  hold?: readonly Source[]
  /** The Public Projection to write, when the caller already built it (run). */
  doc?: PublicDoc
  /** README title and site link, from the user config. */
  readme?: Pick<ReadmeOptions, 'title' | 'siteUrl'>
  /** Called after each file is written, with what was written (run records it to undo it after a failure). */
  onWrite?: (path: string, text: string) => void
}

export function publicPaths(outDir: string, layout: 'flat' | 'repo' = 'flat'): { items: string; readme: string } {
  return {
    items: layout === 'repo' ? join(outDir, 'data', 'items.json') : join(outDir, 'items.json'),
    readme: join(outDir, 'README.md'),
  }
}

/** Writes items.json and README.md to `out` (unless dry run) and reports the difference from what is there now. */
export async function publish(storeDir: string, outDir: string, dryRun: boolean, options: PublishOptions = {}): Promise<PublishResult> {
  const { items: itemsPath, readme: readmePath } = publicPaths(outDir, options.layout)
  const old = await readJson<Partial<PublicDoc>>(itemsPath).catch(() => undefined)
  let doc = options.doc
  if (!doc) {
    doc = await buildProjection(storeDir)
    if (options.hold?.length) {
      const table = await loadCategories(storeDir)
      const order = (table?.categories ?? []).map((c) => c.name)
      doc = holdSources(doc, Array.isArray(old?.items) ? (old as PublicDoc) : undefined, options.hold, order)
    }
  }
  const itemsText = stableStringify(doc)
  const readme = renderReadme(doc, { ...options.readme, dataPath: options.layout === 'repo' ? 'data/items.json' : 'items.json' })

  const oldById = new Map((Array.isArray(old?.items) ? old.items : []).map((i) => [publicKey(i), canonical(i)]))
  const newById = new Map(doc.items.map((i) => [publicKey(i), canonical(i)]))
  const added = [...newById.keys()].filter((id) => !oldById.has(id))
  const removed = [...oldById.keys()].filter((id) => !newById.has(id))
  const changed = [...newById].filter(([id, v]) => oldById.has(id) && oldById.get(id) !== v).map(([id]) => id)
  const readmeChanged = (await readOptional(readmePath)) !== readme
  const itemsChanged = (await readOptional(itemsPath)) !== itemsText

  if (!dryRun) {
    await writeText(itemsPath, itemsText)
    options.onWrite?.(itemsPath, itemsText)
    await writeText(readmePath, readme)
    options.onWrite?.(readmePath, readme)
    await savePublishState(storeDir, {
      projectionHash: projectionHash(doc),
      contentHash: contentHash(doc),
      itemCount: doc.items.length,
    })
  }
  return {
    dryRun,
    out: outDir,
    publicItems: doc.items.length,
    added,
    removed,
    changed,
    readmeChanged,
    identical: !itemsChanged && !readmeChanged,
    contentChanged: contentHash(doc) !== contentHash(old as PublicDoc | undefined) || readmeChanged,
  }
}

export interface SourceCounts {
  items: number
  pendingClassification: number
}

export interface CheckResult {
  items: number
  classified: number
  /** Items the Classifier still has to see, from every Source; private repositories' stars are never counted. */
  pendingClassification: number
  bySource: { github: SourceCounts; x: SourceCounts }
  /** Non-technical X posts kept only by id. */
  skippedItems: number
  locked: number
  needsReview: number
  publicItems: number
  /** The Public Projection differs from the last `publish` (or nothing was published yet). */
  pendingPublish: boolean
  /** Something to classify or publish; when false a run only needs to update the Heartbeat. */
  hasWork: boolean
}

export async function check(storeDir: string): Promise<CheckResult> {
  await requireStore(storeDir)
  const items = await loadItems(storeDir)
  const classifications = await loadClassifications(storeDir)
  const ids = new Set(items.map((i) => i.id))
  const mine = Object.entries(classifications).filter(([id]) => ids.has(id))
  const pending = pendingItems(items, classifications)
  const counts = (source: Item['source']): SourceCounts => ({
    items: items.filter((i) => i.source === source).length,
    pendingClassification: pending.filter((i) => i.source === source).length,
  })
  const doc = await buildProjection(storeDir)
  const state = await loadPublishState(storeDir)
  // Star counts alone never make a publish; an old state without contentHash counts as changed.
  const pendingPublish = state ? state.contentHash !== contentHash(doc) : doc.items.length > 0
  return {
    items: items.length,
    classified: mine.length,
    pendingClassification: pending.length,
    bySource: { github: counts('github'), x: counts('x') },
    skippedItems: Object.keys(await loadSkipped(storeDir)).length,
    locked: mine.filter(([, c]) => c.locked).length,
    needsReview: mine.filter(([, c]) => c.needsReview).length,
    publicItems: doc.items.length,
    pendingPublish,
    hasWork: pending.length > 0 || pendingPublish,
  }
}
