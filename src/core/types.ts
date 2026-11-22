// Domain types. Names follow GLOSSARY.md.

export const SCHEMA_VERSION = 1

export type Source = 'github' | 'x'
export type Signal = 'star' | 'like' | 'bookmark'
export type XSignal = 'like' | 'bookmark'
export type Visibility = 'public' | 'private'

/** A repository the owner starred on GitHub. */
export interface GithubItem {
  id: string
  source: 'github'
  signal: 'star'
  url: string
  name: string
  description: string | null
  language: string | null
  topics: string[]
  stargazers: number
  starredAt: string
  /** The starred repository itself is private; such an Item is never published. */
  repoPrivate: boolean
  archived: boolean
}

/** An X post the owner liked or bookmarked. One post carries every Signal it was seen with. */
export interface XItem {
  /** `x:<status id>` */
  id: string
  source: 'x'
  signals: XSignal[]
  url: string
  /** The handle in the post link, without `@`. */
  author: string
  /** The visible post text; X shows long posts truncated, so this can be a preview. */
  text: string
  /** When the post was written (not when it was liked); null when the page showed no time. */
  postedAt: string | null
  /** When starsieve first saw it. */
  collectedAt: string
  hasMedia: boolean
  /** No text at all (only media); the Classifier cannot judge it. */
  textEmpty: boolean
}

/** One saved thing from one Source. */
export type Item = GithubItem | XItem

/** A non-technical X post: only its id is kept, so it is never judged, shown or published again. */
export interface SkippedItem {
  skippedAt: string
}

/** How far one Backfill of one X list got. Completeness stays unknown. */
export interface BackfillReach {
  startedAt: string
  updatedAt: string
  scrolls: number
  /** Posts seen in this Backfill, and how many of them were new to the store. */
  seen: number
  added: number
  /** The oldest postedAt seen; the list is not ordered by post time, so this is a lower bound at best. */
  earliestPostedAt: string | null
  /** Five scrolls in a row showed nothing new: the list ended or stopped loading. */
  reachedEnd: boolean
  /** The run ended normally (not interrupted or failed). */
  finished: boolean
}

/** The Category, Tags, Summary and Visibility the agent or the owner gave one Item. */
export interface Classification {
  category: string
  tags: string[]
  summary: string
  visibility: Visibility
  needsReview: boolean
  /** The owner changed it by hand; the agent never overwrites it. */
  locked: boolean
  /** `collector`: written by `collect` for a private repository's star, which is never sent to the Classifier. */
  by: 'classifier' | 'owner' | 'collector'
  /** Hash of the Item's classification input when this Classification was made. */
  inputHash: string
}

export interface Category {
  name: string
  description: string
}

export interface CategoryTable {
  schemaVersion: number
  categories: Category[]
}

export interface ClassifierConfig {
  /** argv; `{prompt}`, `{workspace}` and `{store}` are replaced. Without `{prompt}` the prompt goes to stdin. */
  command: string[]
  timeoutMs: number
}

export interface Config {
  classifier: ClassifierConfig
}

export interface BatchEntry {
  id: string
  inputHash: string
}

/** A group of Items handed to the agent for Classification in one go. All from one Source, so one prompt fits. */
export interface Batch {
  schemaVersion: number
  batchId: string
  /** null when there is nothing to classify. */
  source: Source | null
  items: (BatchEntry & { input: ClassificationInput })[]
}

/** The Item fields the Classifier sees; `inputHash` covers exactly these. Unchanged since phase 1, so old hashes hold. */
export interface GithubInput {
  id: string
  name: string
  url: string
  description: string | null
  language: string | null
  topics: string[]
}

/** Signals and collectedAt are left out, so a later bookmark of a liked post never stales its Classification. */
export interface XInput {
  id: string
  source: 'x'
  url: string
  author: string
  text: string
  textEmpty: boolean
  hasMedia: boolean
  postedAt: string | null
}

export type ClassificationInput = GithubInput | XInput

export const UNCATEGORIZED = '未分类'
export const MAX_TAGS = 6
export const MAX_SUMMARY = 80
