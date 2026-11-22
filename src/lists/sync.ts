// lists sync: mirror the Categories of merged public GitHub Items into the owner's GitHub Lists (ADR 0003).
// It only adds: `updateUserListsForItem` replaces an Item's whole membership, so every write sends the lists the
// repository is in now plus the target list. The lists are read in full to plan, and read again right before each
// mutation request, so a list the owner added a repository to meanwhile is kept. A failed or partial read stops before
// any write. The window between that read and the mutation is one request long; it is narrowed, not closed.
import { loadCategories, loadClassifications, loadGithubItems, requireStore } from '../core/store.ts'
import { isPublic, type PublicDoc, type PublicGithubItem } from '../publish/projection.ts'
import { type Exec, exec as realExec, tail } from '../run/exec.ts'

/** GitHub's limit on lists per user. */
export const MAX_LISTS = 32
const UPDATE_BATCH = 20
const LOOKUP_BATCH = 50

export class ListsError extends Error {}

export interface ExistingList {
  id: string
  name: string
  /** Repository node ids in the list. */
  itemIds: string[]
}

export interface RepoRef {
  id: string
  nameWithOwner: string
}

export interface ListsTarget {
  /** `owner/name` */
  repo: string
  category: string
}

export interface ListUpdate {
  repo: string
  itemId: string
  /** List names the repository is in now; all of them are kept. */
  keep: string[]
  /** The Category's list it is added to. */
  add: string
}

export interface ListsPlan {
  existingLists: number
  create: { name: string; description: string }[]
  updates: ListUpdate[]
  /** Repositories already in their Category's list. */
  unchanged: number
  /** Repositories GitHub did not find (renamed away or deleted); left alone. */
  missing: string[]
}

/** Pure: the lists to create and the membership to write. Throws when the lists would exceed MAX_LISTS. */
export function planLists(
  lists: ExistingList[],
  targets: ListsTarget[],
  repos: Map<string, RepoRef>,
  descriptions: Map<string, string>,
): ListsPlan {
  const byName = new Map(lists.map((l) => [l.name, l]))
  const categories = [...new Set(targets.map((t) => t.category))]
  const create = categories
    .filter((c) => !byName.has(c))
    .map((name) => ({ name, description: descriptions.get(name) ?? '' }))
  if (lists.length + create.length > MAX_LISTS) {
    throw new ListsError(
      `GitHub allows ${MAX_LISTS} lists; you have ${lists.length} and ${create.length} Categories have no list yet ` +
        `(${create.map((c) => c.name).join(', ')}). Nothing was changed. Merge Categories or delete unused lists, then run again.`,
    )
  }
  const updates: ListUpdate[] = []
  const missing: string[] = []
  let unchanged = 0
  for (const t of targets) {
    const ref = repos.get(t.repo.toLowerCase())
    if (!ref) {
      missing.push(t.repo)
      continue
    }
    const keep = lists.filter((l) => l.itemIds.includes(ref.id)).map((l) => l.name)
    if (keep.includes(t.category)) {
      unchanged++
      continue
    }
    updates.push({ repo: t.repo, itemId: ref.id, keep, add: t.category })
  }
  return { existingLists: lists.length, create, updates, unchanged, missing }
}

type GraphqlResult = { data?: Record<string, unknown> | null; errors?: { type?: string; message?: string; path?: unknown[] }[] }

async function graphql(gh: Exec, query: string, variables: Record<string, unknown> = {}, allowNotFound = false): Promise<Record<string, unknown>> {
  const r = await gh('gh', ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }) })
  let body: GraphqlResult | undefined
  try {
    body = JSON.parse(r.stdout) as GraphqlResult
  } catch {
    body = undefined
  }
  if (!body?.data) throw new ListsError(`gh api graphql failed: ${tail(r)}`)
  const errors = (body.errors ?? []).filter((e) => !(allowNotFound && e.type === 'NOT_FOUND'))
  if (errors.length > 0) throw new ListsError(`gh api graphql: ${errors.map((e) => e.message).join('; ')}`)
  if (r.code !== 0 && !allowNotFound) throw new ListsError(`gh api graphql exited ${r.code}: ${tail(r)}`)
  return body.data
}

const ITEMS = 'pageInfo { hasNextPage endCursor } nodes { __typename ... on Repository { id nameWithOwner } }'

/** Every list with every item, all pages. Any failure throws, so a write never works from half the membership. */
export async function readLists(gh: Exec): Promise<{ lists: ExistingList[]; repos: RepoRef[] }> {
  const lists: ExistingList[] = []
  const repos: RepoRef[] = []
  type Page = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { __typename: string; id?: string; nameWithOwner?: string }[] }
  const take = (list: ExistingList, page: Page) => {
    for (const n of page.nodes) {
      if (n.__typename !== 'Repository' || !n.id) continue
      list.itemIds.push(n.id)
      repos.push({ id: n.id, nameWithOwner: n.nameWithOwner ?? '' })
    }
  }
  let after: string | null = null
  do {
    const data = await graphql(
      gh,
      `query($after: String) { viewer { lists(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name items(first: 100) { ${ITEMS} } } } } }`,
      { after },
    )
    const page = (data.viewer as { lists: { pageInfo: Page['pageInfo']; nodes: { id: string; name: string; items: Page }[] } }).lists
    for (const node of page.nodes) {
      const list: ExistingList = { id: node.id, name: node.name, itemIds: [] }
      take(list, node.items)
      let items = node.items
      while (items.pageInfo.hasNextPage) {
        const more = await graphql(gh, `query($id: ID!, $after: String) { node(id: $id) { ... on UserList { items(first: 100, after: $after) { ${ITEMS} } } } }`, {
          id: node.id,
          after: items.pageInfo.endCursor,
        })
        items = (more.node as { items: Page }).items
        take(list, items)
      }
      lists.push(list)
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return { lists, repos }
}

/**
 * Repository node ids by the `owner/name` asked for (lower case), in batches; ones GitHub cannot find are left out.
 * A renamed repository answers under its new name, so the key is the name asked for.
 */
export async function lookupRepos(gh: Exec, names: string[]): Promise<Map<string, RepoRef>> {
  const out = new Map<string, RepoRef>()
  for (let i = 0; i < names.length; i += LOOKUP_BATCH) {
    const chunk = names.slice(i, i + LOOKUP_BATCH)
    const fields = chunk.map((full, j) => {
      const [owner, name] = full.split('/')
      return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { id nameWithOwner }`
    })
    const data = await graphql(gh, `query { ${fields.join(' ')} }`, {}, true)
    chunk.forEach((full, j) => {
      const ref = data[`r${j}`] as RepoRef | null | undefined
      if (ref?.id) out.set(full.toLowerCase(), ref)
    })
  }
  return out
}

/** The merged public GitHub Items that are still public in the store, as Category targets. */
export async function listsTargets(storeDir: string, merged: PublicDoc | undefined): Promise<{ targets: ListsTarget[]; notPublic: string[] }> {
  await requireStore(storeDir)
  const items = new Map((await loadGithubItems(storeDir)).map((i) => [i.id, i]))
  const classifications = await loadClassifications(storeDir)
  const targets: ListsTarget[] = []
  const notPublic: string[] = []
  for (const p of merged?.items ?? []) {
    if (!('id' in p)) continue
    const item = items.get(p.id)
    // Only public Items of public repositories, checked against the store again, not just the public file.
    if (!item || !isPublic(item, classifications[p.id])) {
      notPublic.push(p.id)
      continue
    }
    targets.push({ repo: (p as PublicGithubItem).id.replace(/^github:/, ''), category: p.category })
  }
  return { targets, notPublic }
}

export interface ListsSyncOptions {
  storeDir: string
  /** The merged Public Projection (the public repository's main). */
  merged: PublicDoc | undefined
  dryRun: boolean
  gh?: Exec
  log?: (s: string) => void
}

export interface ListsSyncResult extends ListsPlan {
  dryRun: boolean
  /** Items in the merged file that the store no longer says are public; never synced. */
  notPublic: string[]
  created: string[]
  updated: number
}

export async function listsSync(options: ListsSyncOptions): Promise<ListsSyncResult> {
  const gh = options.gh ?? realExec
  const log = options.log ?? (() => {})
  const { targets, notPublic } = await listsTargets(options.storeDir, options.merged)
  const table = await loadCategories(options.storeDir)
  const descriptions = new Map((table?.categories ?? []).map((c) => [c.name, `starsieve: ${c.description}`]))
  const { lists, repos } = await readLists(gh)
  const known = new Map(repos.map((r) => [r.nameWithOwner.toLowerCase(), r]))
  const unknown = targets.map((t) => t.repo).filter((r) => !known.has(r.toLowerCase()))
  for (const [asked, ref] of await lookupRepos(gh, unknown)) known.set(asked, ref)
  const plan = planLists(lists, targets, known, descriptions)
  log(`lists: ${lists.length} existing, ${plan.create.length} to create, ${plan.updates.length} repositories to add, ${plan.unchanged} already in place, ${plan.missing.length} not found`)
  const result: ListsSyncResult = { ...plan, dryRun: options.dryRun, notPublic, created: [], updated: 0 }
  if (options.dryRun || (plan.create.length === 0 && plan.updates.length === 0)) return result

  const ids = new Map(lists.map((l) => [l.name, l.id]))
  for (const c of plan.create) {
    const data = await graphql(
      gh,
      'mutation($name: String!, $description: String) { createUserList(input: { name: $name, description: $description, isPrivate: false }) { list { id name } } }',
      { name: c.name, description: c.description },
    )
    const list = (data.createUserList as { list: { id: string } }).list
    ids.set(c.name, list.id)
    result.created.push(c.name)
    log(`lists: created ${c.name}`)
  }
  for (let i = 0; i < plan.updates.length; i += UPDATE_BATCH) {
    // The membership as it is now, not as it was when planning: the owner may have changed a list meanwhile.
    const fresh = (await readLists(gh)).lists
    for (const l of fresh) ids.set(l.name, l.id)
    const variables: Record<string, unknown> = {}
    const fields: string[] = []
    for (const u of plan.updates.slice(i, i + UPDATE_BATCH)) {
      const target = ids.get(u.add)
      if (!target) throw new ListsError(`no list id for ${u.add}`)
      const now = fresh.filter((l) => l.itemIds.includes(u.itemId)).map((l) => l.id)
      if (now.includes(target)) {
        result.unchanged++
        continue
      }
      const listIds = [...now, target]
      // Never send fewer lists than the repository is in now.
      if (!now.every((id) => listIds.includes(id))) throw new ListsError(`refusing to remove ${u.repo} from a list`)
      const j = fields.length
      variables[`i${j}`] = { itemId: u.itemId, listIds }
      fields.push(`u${j}: updateUserListsForItem(input: $i${j}) { clientMutationId }`)
    }
    if (fields.length === 0) continue
    const decl = fields.map((_, j) => `$i${j}: UpdateUserListsForItemInput!`).join(', ')
    await graphql(gh, `mutation(${decl}) { ${fields.join(' ')} }`, variables)
    result.updated += fields.length
  }
  log(`lists: created ${result.created.length}, updated ${result.updated} repositories`)
  return result
}
