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
import { type Lang, translator } from '../panel/i18n.ts'
import type { ReadmeTitle } from '../core/user-config.ts'
import { type Classification, type CategoryTable, type Item, SCHEMA_VERSION, type Source, UNCATEGORIZED } from '../core/types.ts'

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

/** What the README shows besides the Items; the caller reads it from the user config and the store, so renderReadme stays pure. */
export interface ReadmeOptions {
  /** One line; default Tech collection (English) or 技术收藏 (Chinese). */
  title?: string
  /** The public site; without it the README has no online-catalog link. */
  siteUrl?: string
  /** items.json relative to the README, following the layout. */
  dataPath?: string
  /** English display names by Category name (the Category Table's `nameEn`); only the English README uses them. */
  categoryLabels?: Record<string, string>
}

/** The public READMEs: English is the one GitHub shows, Chinese sits next to it. */
export const README_FILES: Record<Lang, string> = { en: 'README.md', zh: 'README.zh-CN.md' }

const LANGUAGE_SWITCH: Record<Lang, string> = {
  en: `English | [简体中文](${README_FILES.zh})`,
  zh: `[English](${README_FILES.en}) | 简体中文`,
}

/** `nameEn` by Category name, kept only when it is one non-empty line (categories.json is read without validation). */
export function categoryLabels(table: CategoryTable | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of table?.categories ?? []) {
    const en = (c as { nameEn?: unknown }).nameEn
    if (typeof en === 'string' && en.trim() !== '' && !/[\r\n]/.test(en)) out[c.name] = en.trim()
  }
  return out
}

/** The language once, then at most 3 Tags; the first Tag (what kind of thing it is) always stays. */
function itemMeta(item: PublicItem): string[] {
  const [first, ...rest] = item.tags
  const language = 'id' in item ? item.language : null
  const same = (t: string) => t.toLowerCase() === language?.toLowerCase()
  const showLanguage = language && !(first !== undefined && same(first))
  const tags = (first === undefined ? [] : [first, ...rest.filter((t) => !showLanguage || !same(t))]).slice(0, 3)
  return [showLanguage ? language : '', ...tags].filter(Boolean).map(md)
}

/**
 * README catalog; only sanitized fields (name or author, url, Summary, Tags, language). No timestamps and no star
 * counts, so reruns match and a day where only stars moved leaves it unchanged. The English one shows Categories by
 * their English names; Summaries and Tags stay as the Classifier wrote them (Chinese).
 */
export function renderReadme(doc: PublicDoc, lang: Lang, options: ReadmeOptions = {}): string {
  const t = translator(lang)
  const label = (category: string) =>
    lang === 'zh' ? category : (options.categoryLabels?.[category] ?? (category === UNCATEGORIZED ? 'Uncategorized' : category))
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
  const lines = [`# ${md(title)}`, '', LANGUAGE_SWITCH[lang], '']
  if (doc.items.length === 0) lines.push(t('Nothing published yet.'), '')
  else {
    const counts = (repos && posts ? t('{repos} GitHub repositories and {posts} X posts') : repos ? t('{repos} GitHub repositories') : t('{posts} X posts'))
      .replace('{repos}', String(repos))
      .replace('{posts}', String(posts))
    const total = t('Collects {items}, in {categories} Categories.').replace('{items}', counts).replace('{categories}', String(groups.size))
    // English only, so not through t(): the Chinese README needs no such note.
    lines.push(lang === 'en' ? `${total} Summaries and Tags are in Chinese.` : total, '')
  }
  if (options.siteUrl) lines.push(`**[${t('Open the online catalog →')}](${options.siteUrl})** ${t('Search, filter and sort by stars there.')}`, '')
  if (groups.size) {
    const contents = t('Contents')
    const top = slugger.slug(contents)
    const anchors = new Map([...groups.keys()].map((c) => [c, slugger.slug(label(c))]))
    lines.push(`## ${contents}`, '')
    for (const [category, list] of groups) {
      const count = lang === 'zh' ? `（${list.length}）` : ` (${list.length})`
      lines.push(`- [${md(label(category))}](#${anchors.get(category)})${count}`)
    }
    for (const [category, list] of groups) {
      lines.push('', `## ${md(label(category))}`, '')
      for (const item of list) {
        const link = 'id' in item ? `[${md(item.name)}](${item.url})` : `X · [@${md(item.author)}](${item.url})`
        // The Summary reads as a phrase after the dash; language and Tags go on a smaller second line.
        const summary = item.summary ? md(item.summary.replace(/[。.]$/u, '')) : ''
        const meta = itemMeta(item)
        lines.push(`- ${link}${summary ? ` — ${summary}` : ''}${meta.length ? `<br><sub>${meta.join(' · ')}</sub>` : ''}`)
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
    t('Generated by {tool}; do not edit by hand.').replace('{tool}', '[starsieve](https://github.com/Adonis0123/starsieve)'),
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
  /** README.md or README.zh-CN.md differs from what `out` holds. */
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
  /**
   * `flat` (default): `out/items.json`, `out/README.md` and `out/README.zh-CN.md`. `repo`: the public repository's
   * `data/items.json` and the two READMEs at its root.
   */
  layout?: 'flat' | 'repo'
  /** Sources whose collection failed: their Items stay as the public files have them now. */
  hold?: readonly Source[]
  /** The Public Projection to write, when the caller already built it (run). */
  doc?: PublicDoc
  /** README title (one for both languages, or one each) and site link, from the user config. */
  readme?: { title?: ReadmeTitle; siteUrl?: string }
  /** Called after each file is written, with what was written (run records it to undo it after a failure). */
  onWrite?: (path: string, text: string) => void
}

export function publicPaths(outDir: string, layout: 'flat' | 'repo' = 'flat'): { items: string; readmes: Record<Lang, string> } {
  return {
    items: layout === 'repo' ? join(outDir, 'data', 'items.json') : join(outDir, 'items.json'),
    readmes: { en: join(outDir, README_FILES.en), zh: join(outDir, README_FILES.zh) },
  }
}

function titleFor(title: ReadmeTitle | undefined, lang: Lang): string | undefined {
  return typeof title === 'string' ? title : title?.[lang]
}

/** Writes items.json and both READMEs to `out` (unless dry run) and reports the difference from what is there now. */
export async function publish(storeDir: string, outDir: string, dryRun: boolean, options: PublishOptions = {}): Promise<PublishResult> {
  const { items: itemsPath, readmes: readmePaths } = publicPaths(outDir, options.layout)
  const old = await readJson<Partial<PublicDoc>>(itemsPath).catch(() => undefined)
  const table = await loadCategories(storeDir)
  let doc = options.doc
  if (!doc) {
    doc = await buildProjection(storeDir)
    if (options.hold?.length) {
      const order = (table?.categories ?? []).map((c) => c.name)
      doc = holdSources(doc, Array.isArray(old?.items) ? (old as PublicDoc) : undefined, options.hold, order)
    }
  }
  const itemsText = stableStringify(doc)
  const shared = {
    siteUrl: options.readme?.siteUrl,
    dataPath: options.layout === 'repo' ? 'data/items.json' : 'items.json',
    categoryLabels: categoryLabels(table),
  }
  const readmes: { path: string; text: string }[] = []
  for (const lang of ['en', 'zh'] as const) {
    readmes.push({ path: readmePaths[lang], text: renderReadme(doc, lang, { ...shared, title: titleFor(options.readme?.title, lang) }) })
  }

  const oldById = new Map((Array.isArray(old?.items) ? old.items : []).map((i) => [publicKey(i), canonical(i)]))
  const newById = new Map(doc.items.map((i) => [publicKey(i), canonical(i)]))
  const added = [...newById.keys()].filter((id) => !oldById.has(id))
  const removed = [...oldById.keys()].filter((id) => !newById.has(id))
  const changed = [...newById].filter(([id, v]) => oldById.has(id) && oldById.get(id) !== v).map(([id]) => id)
  let readmeChanged = false
  for (const r of readmes) if ((await readOptional(r.path)) !== r.text) readmeChanged = true
  const itemsChanged = (await readOptional(itemsPath)) !== itemsText

  if (!dryRun) {
    await writeText(itemsPath, itemsText)
    options.onWrite?.(itemsPath, itemsText)
    for (const r of readmes) {
      await writeText(r.path, r.text)
      options.onWrite?.(r.path, r.text)
    }
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
