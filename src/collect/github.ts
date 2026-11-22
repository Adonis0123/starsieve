// GitHub collector: every starred repository via the owner's `gh` login, as Items.
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { inputHash } from '../core/batch.ts'
import { canonical } from '../core/json.ts'
import { loadClassifications, loadGithubItems, saveClassifications, saveGithubItems, withStoreLock } from '../core/store.ts'
import { type Classification, type GithubItem, UNCATEGORIZED } from '../core/types.ts'

const run = promisify(execFile)

/** One element of `GET /user/starred` with `Accept: application/vnd.github.star+json`. */
export interface RawStar {
  starred_at?: unknown
  repo?: {
    full_name?: unknown
    html_url?: unknown
    description?: unknown
    language?: unknown
    topics?: unknown
    stargazers_count?: unknown
    private?: unknown
    archived?: unknown
  }
}

export type FetchStars = () => Promise<RawStar[]>

/** `--slurp` wraps every page into one outer array, so the output is always one JSON document. */
export const fetchStarsWithGh: FetchStars = async () => {
  const { stdout } = await run(
    'gh',
    [
      'api',
      'user/starred?per_page=100',
      '--paginate',
      '--slurp',
      '-H',
      'Accept: application/vnd.github.star+json',
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  )
  const pages = JSON.parse(stdout) as unknown
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('gh api user/starred: unexpected output')
  return pages.flat() as RawStar[]
}

export function toItem(raw: RawStar, index: number): GithubItem {
  const repo = raw.repo
  const name = repo?.full_name
  if (typeof name !== 'string' || typeof raw.starred_at !== 'string' || typeof repo?.html_url !== 'string') {
    throw new Error(`star #${index} has no repo.full_name, repo.html_url or starred_at`)
  }
  return {
    id: `github:${name}`,
    source: 'github',
    signal: 'star',
    url: repo.html_url,
    name,
    description: typeof repo.description === 'string' ? repo.description : null,
    language: typeof repo.language === 'string' ? repo.language : null,
    topics: Array.isArray(repo.topics) ? repo.topics.filter((t): t is string => typeof t === 'string') : [],
    stargazers: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
    starredAt: raw.starred_at,
    // Unknown means private: never publish a star we cannot prove is of a public repository.
    repoPrivate: repo.private !== false,
    archived: repo.archived === true,
  }
}

export interface CollectResult {
  source: 'github'
  fetched: number
  total: number
  added: number
  updated: number
  unchanged: number
  /** Items already in the store that this fetch did not return (unstarred); kept as they are. */
  notSeen: number
  /** Stars of private repositories given a private Classification here, so they never reach the Classifier. */
  privateClassified: number
}

/** What a private repository's star gets instead of a Classifier run. */
export function privateRepoClassification(item: GithubItem): Classification {
  return {
    category: UNCATEGORIZED,
    tags: [],
    summary: '',
    visibility: 'private',
    needsReview: false,
    locked: false,
    by: 'collector',
    inputHash: inputHash(item),
  }
}

/**
 * Fetches all stars, then merges them into the store in one write. Item fields are refreshed;
 * Classifications are never touched. A failed fetch writes nothing.
 */
export async function collectGithub(storeDir: string, fetch: FetchStars = fetchStarsWithGh): Promise<CollectResult> {
  const raw = await fetch()
  const fetched = raw.map(toItem)
  await mkdir(storeDir, { recursive: true })
  // The fetch above can take a while; the merge and both writes run under the store lock, from a fresh read.
  return withStoreLock(storeDir, async () => {
    const byId = new Map((await loadGithubItems(storeDir)).map((i) => [i.id, i]))
    const seen = new Set<string>()
    let added = 0
    let updated = 0
    let unchanged = 0
    for (const item of fetched) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const before = byId.get(item.id)
      if (!before) added++
      else if (canonical(before) === canonical(item)) unchanged++
      else updated++
      byId.set(item.id, item)
    }
    if (added > 0 || updated > 0 || !byId.size) {
      await mkdir(storeDir, { recursive: true })
      await saveGithubItems(storeDir, [...byId.values()])
    }
    // Any star of a private repository with no Classification yet: an existing one (even the agent's) is kept.
    const classifications = await loadClassifications(storeDir)
    let privateClassified = 0
    for (const item of byId.values()) {
      if (!item.repoPrivate || classifications[item.id]) continue
      classifications[item.id] = privateRepoClassification(item)
      privateClassified++
    }
    if (privateClassified > 0) await saveClassifications(storeDir, classifications)
    return {
      source: 'github' as const,
      fetched: seen.size,
      total: byId.size,
      added,
      updated,
      unchanged,
      notSeen: [...byId.keys()].filter((id) => !seen.has(id)).length,
      privateClassified,
    }
  })
}
