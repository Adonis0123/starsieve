// run: the daily pipeline on the owner's Mac (ADR 0003).
// check → collect github → collect x → classify until nothing is pending (or --max-batches) → publish → site build →
// commit and push the Private Store → commit and push the public branch → PR with auto-merge → wait for the merge →
// lists sync. Every step's result goes into the Heartbeat; any failure makes the run fail (exit 1). A failed
// collection does not stop the run, but that Source is not published that day (its public Items stay as they are).
// Writes that change GitHub (push, PR, merge, Lists) happen only when `push` is on and neither dry-run flag is.
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { classify as realClassify, type ClassifyResult } from '../classify/runner.ts'
import { type CollectResult as GithubCollectResult, collectGithub as realCollectGithub } from '../collect/github.ts'
import { collectX as realCollectX, type ListResult, X_LISTS } from '../collect/x.ts'
import { openEgoBrowser } from '../collect/x-browser.ts'
import { loadCategories, requireStore, STORE_LOCK, withStoreLock } from '../core/store.ts'
import type { Source } from '../core/types.ts'
import { type ListsSyncResult, listsSync } from '../lists/sync.ts'
import { buildProjection, check, contentHash, holdSources, publish, type PublishOptions } from '../publish/projection.ts'
import { buildSite } from '../site/build.ts'
import { type Exec, exec as realExec, tail } from './exec.ts'
import { commitPaths, currentBranch, git, githubSlug, originUrls, revParse, topLevel } from './git.ts'
import { type Heartbeat, loadHeartbeat, saveHeartbeat, type StepResult, type StepStatus } from './heartbeat.ts'
import { acquireLock } from './lock.ts'
import { defaultLogDir, localDay, openRunLog } from './log.ts'
import {
  assertClean,
  BRANCH_PREFIX,
  baseRef,
  type BranchChoice,
  differsFromBase,
  hashFiles,
  ITEMS_FILE,
  needsPush,
  PUBLIC_PATHS,
  pushedBefore,
  pickBranch,
  readPublicDoc,
  rollbackWrites,
  squashUnpushed,
} from './public-repo.ts'

export const BATCH_SIZE = 25
/** The page site build writes into the public clone. */
const SITE_FILE = 'docs/index.html'

export interface RunDeps {
  collectGithub: (store: string) => Promise<GithubCollectResult>
  collectX: (store: string) => Promise<ListResult[]>
  classify: (store: string, limit: number) => Promise<ClassifyResult>
  /** Runs `gh`; tests pass a fake that records calls. */
  gh: Exec
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export interface RunOptions {
  store: string
  /** The public repository's local clone. */
  publicRepo: string
  /** `owner/name` of the public repository, for `gh`. */
  slug?: string
  /** false: commit locally only; nothing is pushed, no PR, Lists only planned. */
  push: boolean
  /** Push both repositories, but only print the PR and merge commands and plan the Lists. */
  prDryRun?: boolean
  /** Print what would run; write nothing. */
  dryRun?: boolean
  maxBatches?: number
  /** The Portal's local-tools.css, inlined by site build. */
  css?: string
  /** README title and site link, from the user config. */
  readme?: PublishOptions['readme']
  mergeTimeoutMs?: number
  pollMs?: number
  logDir?: string
  /** Each log line is also passed here (stderr in the CLI). */
  echo?: (s: string) => void
  deps?: Partial<RunDeps>
}

export interface RunReport {
  ok: boolean
  dryRun: boolean
  /** Nothing new was collected, classified or published: only the Heartbeat was written. */
  nothingNew: boolean
  mode: 'push' | 'pr-dry-run' | 'no-push' | 'dry-run'
  logPath: string
  steps: StepResult[]
  collected: { github: number | null; x: number | null }
  classified: number
  batches: number
  pendingClassification: number | null
  held: Source[]
  private: { commits: string[]; pushed: boolean }
  public: { branch: string | null; commit: string | null; pushed: boolean; pr: string | null; merged: boolean | null }
  lists: Pick<ListsSyncResult, 'dryRun' | 'existingLists' | 'create' | 'updates' | 'unchanged' | 'missing' | 'created' | 'updated'> | null
  /** Commands that were printed instead of run (--pr-dry-run). */
  printed: string[]
}

const DEFAULT_MERGE_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_POLL_MS = 30 * 1000

function defaultDeps(logDir: string): RunDeps {
  return {
    collectGithub: (store) => realCollectGithub(store),
    collectX: (store) => realCollectX(store, { lists: [...X_LISTS], knownStop: 20, maxScrolls: 40, openBrowser: openEgoBrowser }),
    classify: (store, limit) => realClassify(store, limit, undefined, { logDir }),
    gh: realExec,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/** The real path, so a path relative to git's top level never crosses a symlink (/var is /private/var on macOS). */
function real(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const sameRemote = (a: string, b: string) => {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * What run may do with the store's repository. `commit`: it is a repository of its own, separate from the public one.
 * `local`: it could not be verified, or the check step failed (the store's JSON included); the Heartbeat is written to
 * the store but nothing is committed or pushed.
 * `none`: the store is inside the public clone (or missing); nothing is written there at all, not even the Heartbeat,
 * since any file there could be committed into the public repository.
 */
type StoreWrites = 'commit' | 'local' | 'none'

/** The store's repository must not be the public repository, by place or by remote; an error says which. */
export async function checkSeparateRepos(store: string, pub: string, slug: string | undefined): Promise<{ top?: string; error?: string; writes: StoreWrites }> {
  if (inside(store, pub)) return { error: `the store ${store} is inside the public clone ${pub}; move it to the private repository`, writes: 'none' }
  let top: string
  let pubTop: string
  try {
    top = await topLevel(store)
    pubTop = await topLevel(pub)
  } catch (e) {
    return { error: (e as Error).message, writes: 'local' }
  }
  if (real(top) === real(pubTop) || inside(real(store), real(pubTop))) {
    return { error: `the store ${store} is in the same git repository as the public clone (${pubTop})`, writes: 'none' }
  }
  // Every address the store's repository fetches from or pushes to; any one of them being the public repository is enough.
  const privateUrls = await originUrls(top)
  const publicUrls = await originUrls(pubTop)
  const publicSlugs = [slug, ...publicUrls.map(githubSlug)].filter(Boolean).map((x) => x!.toLowerCase())
  const bad = privateUrls.find((u) => publicUrls.some((p) => sameRemote(u, p)) || publicSlugs.includes(githubSlug(u)?.toLowerCase() ?? ''))
  if (bad) {
    return { top, error: `the store's repository ${top} fetches from or pushes to the public repository (${bad}); its origin must be the private repository`, writes: 'local' }
  }
  return { top, writes: 'commit' }
}

/** Store commits leave out the store write lock (held by a Panel edit, or by run itself while committing). */
const storeLockExclude = (spec: string) => `:(exclude)${join(spec, STORE_LOCK)}*`

const shell = (args: readonly string[]) => args.map((a) => (/^[\w./:@=-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(' ')

class Abort extends Error {}

export async function run(options: RunOptions): Promise<RunReport> {
  const logDir = options.logDir ?? defaultLogDir()
  const deps: RunDeps = { ...defaultDeps(logDir), ...options.deps }
  const store = real(options.store)
  const pub = real(options.publicRepo)
  const log = openRunLog(logDir, deps.now, options.echo)
  const push = options.push && !options.dryRun
  /** Whether this run may change anything on GitHub. */
  const external = push && !options.prDryRun
  const mode: RunReport['mode'] = options.dryRun ? 'dry-run' : !options.push ? 'no-push' : options.prDryRun ? 'pr-dry-run' : 'push'
  const day = localDay(deps.now())
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`

  const report: RunReport = {
    ok: false,
    dryRun: options.dryRun === true,
    nothingNew: false,
    mode,
    logPath: log.path,
    steps: [],
    collected: { github: null, x: null },
    classified: 0,
    batches: 0,
    pendingClassification: null,
    held: [],
    private: { commits: [], pushed: false },
    public: { branch: null, commit: null, pushed: false, pr: null, merged: null },
    lists: null,
    printed: [],
  }
  log.line(`run start: mode ${mode}, store ${store}, public clone ${pub}${options.maxBatches !== undefined ? `, max ${options.maxBatches} Batches` : ''}`)

  if (options.dryRun) {
    await requireStore(store)
    const k = await check(store)
    report.pendingClassification = k.pendingClassification
    const planned = (name: string, detail: string) => report.steps.push({ name, status: 'dry-run', ms: 0, detail })
    planned('check', `${k.items} Items, ${k.pendingClassification} to classify, ${k.pendingPublish ? 'Public Projection changed' : 'nothing new to publish'}`)
    planned('collect-github', 'gh api user/starred')
    planned('collect-x', 'ego-browser, profile Default: likes and bookmarks')
    const batches = Math.ceil(k.pendingClassification / BATCH_SIZE)
    planned('classify', `${options.maxBatches !== undefined ? Math.min(batches, options.maxBatches) : batches} Batches of ${BATCH_SIZE} (plus whatever collection adds)`)
    planned('publish', `data/items.json and README.md into ${pub}, on branch ${BRANCH_PREFIX}${day}`)
    planned('site', `docs/index.html into ${pub}`)
    planned('private', options.push ? 'commit and push the Private Store' : 'commit the Private Store (--no-push)')
    planned('public', options.push ? 'commit and push the public branch' : 'commit the public branch (--no-push)')
    planned('pr', external ? 'gh pr create, gh pr merge --auto --squash' : 'print only')
    planned('wait-merge', external ? `up to ${Math.round((options.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS) / 60000)} min` : 'skipped')
    planned('lists-sync', external ? 'add merged GitHub Items to their Category lists' : 'plan only')
    report.ok = true
    log.line('dry run: nothing written')
    return report
  }

  const release = await acquireLock(join(logDir, 'run.lock'))
  let failed = false
  let aborted: string | null = null
  const t0 = Date.now()
  let previousHb: Heartbeat | undefined
  // Until the check step has passed (the store's repository is separate from the public one, the store's JSON is
  // valid), nothing is committed or pushed from it.
  let storeWrites: StoreWrites = 'none'
  try {
    await requireStore(store)
    const repos = await checkSeparateRepos(store, pub, options.slug)
    // Only the Heartbeat, locally, until the whole check step has passed: a store that fails it is never committed.
    storeWrites = repos.writes === 'none' ? 'none' : 'local'
    if (storeWrites !== 'none') {
      previousHb = await loadHeartbeat(store)
      await saveHeartbeat(store, {
        lastAttemptAt: deps.now().toISOString(),
        lastSuccessAt: previousHb?.lastSuccessAt ?? null,
        result: 'running',
        nothingNew: false,
        steps: [],
      })
    }

    /** Runs one step. A throw marks the run failed; `fatal` steps also skip everything after them. */
    const step = async (
      name: string,
      fn: () => Promise<string | { status: StepStatus; detail: string }>,
      fatal = true,
    ): Promise<boolean> => {
      if (aborted) {
        report.steps.push({ name, status: 'skipped', ms: 0, detail: `not run: ${aborted} failed` })
        return false
      }
      const started = Date.now()
      log.line(`${name}: start`)
      try {
        const r = await fn()
        const { status, detail } = typeof r === 'string' ? { status: 'ok' as const, detail: r } : r
        report.steps.push({ name, status, ms: Date.now() - started, detail })
        log.line(`${name}: ${status}: ${detail}`)
        return true
      } catch (e) {
        const error = (e as Error).message
        failed = true
        if (fatal) aborted = name
        report.steps.push({ name, status: 'failed', ms: Date.now() - started, error })
        log.line(`${name}: FAILED: ${error}`)
        return false
      }
    }

    let privateTop = ''
    let storeSpec = '.'
    const checked = await step('check', async () => {
      if (repos.error || !repos.top) throw new Error(`${repos.error ?? 'the private repository is unknown'}; nothing is committed or pushed from the store`)
      const k = await check(store)
      privateTop = repos.top
      storeSpec = relative(privateTop, store) || '.'
      if (!options.css) throw new Error('no stylesheet for the site: set "portalCss" in ~/.config/starsieve/config.json')
      report.pendingClassification = k.pendingClassification
      return `${k.items} Items, ${k.pendingClassification} to classify; private repository ${privateTop}`
    })
    if (checked && repos.writes === 'commit') storeWrites = 'commit'

    await step(
      'collect-github',
      async () => {
        try {
          const r = await deps.collectGithub(store)
          report.collected.github = r.added
          return `${r.total} stars, ${r.added} new, ${r.updated} updated`
        } catch (e) {
          report.held.push('github')
          throw e
        }
      },
      false,
    )
    await step(
      'collect-x',
      async () => {
        try {
          const lists = await deps.collectX(store)
          const added = lists.reduce((n, l) => n + l.added, 0)
          report.collected.x = added
          return lists.map((l) => `${l.list}: ${l.added} new (stopped: ${l.stoppedBy})`).join('; ')
        } catch (e) {
          report.held.push('x')
          throw new Error(`${(e as Error).message} (X is not published this run)`)
        }
      },
      false,
    )

    await step('classify', async () => {
      while (options.maxBatches === undefined || report.batches < options.maxBatches) {
        const r = await deps.classify(store, BATCH_SIZE)
        if (!r.apply) break
        report.batches++
        const progress = r.apply.accepted + r.apply.skippedItems
        report.classified += progress
        log.line(
          `classify: ${r.batch.batchId} (${r.batch.source}, ${r.batch.size} Items): ${r.apply.accepted} accepted, ${r.apply.skippedItems} skipped as not technical, ${r.apply.rejected} rejected in ${Math.round(r.agentMs / 1000)} s`,
        )
        if (progress === 0) throw new Error(`Batch ${r.batch.batchId} classified nothing; stopping so the loop cannot repeat it`)
      }
      // A store that no longer passes the check after classifying is kept local, never committed or pushed.
      const k = await check(store).catch((e: unknown) => {
        if (storeWrites === 'commit') storeWrites = 'local'
        throw e
      })
      report.pendingClassification = k.pendingClassification
      return `${report.batches} Batches, ${report.classified} Items classified, ${k.pendingClassification} still pending`
    })

    // Public clone: from here on, a failure undoes the uncommitted files this run wrote there (only while they still
    // hold what it wrote; any other change is kept and reported).
    let choice: BranchChoice | undefined
    let base = ''
    let origBranch: string | undefined
    let publicTouched = false
    let changed = false
    let openPr: { url: string; branch: string } | undefined
    let doc: Awaited<ReturnType<typeof buildProjection>> | undefined
    /** Each file this run wrote into the public clone → the git blob hash of what it wrote. */
    const written = new Map<string, string>()
    const recordWritten = async (paths: readonly string[]) => {
      for (const [p, h] of await hashFiles(pub, paths)) written.set(p, h)
    }
    try {
      await step('publish', async () => {
        await assertClean(pub)
        origBranch = await currentBranch(pub)
        if (push) await git(pub, ['fetch', '--quiet', '--prune', 'origin'])
        base = await baseRef(pub)
        if (external) openPr = await findOpenPr(deps.gh, options.slug, pub)
        choice = await pickBranch(pub, day, base, openPr?.branch)
        report.public.branch = choice.branch
        const previous = await readPublicDoc(pub, choice.from)
        const order = ((await loadCategories(store))?.categories ?? []).map((c) => c.name)
        doc = holdSources(await buildProjection(store), previous, report.held, order)
        publicTouched = true
        await git(pub, ['checkout', '--quiet', '--no-track', '-B', choice.branch, choice.from])
        changed = contentHash(doc) !== contentHash(previous)
        if (!changed) {
          return `${doc.items.length} public Items; nothing new beyond star counts on ${choice.branch}${choice.reused ? ' (reused)' : ''}`
        }
        const r = await publish(store, pub, false, { layout: 'repo', doc, readme: options.readme }).finally(() => recordWritten([ITEMS_FILE, 'README.md']))
        const held = report.held.length ? `; held as before: ${report.held.join(', ')}` : ''
        return `${r.publicItems} public Items on ${choice.branch} (+${r.added.length} -${r.removed.length} ~${r.changed.length})${held}`
      })

      await step('site', async () => {
        if (!changed || !doc) return { status: 'skipped', detail: 'nothing new to publish' }
        const r = await buildSite(store, join(pub, 'docs'), { css: options.css, doc }).finally(() => recordWritten([SITE_FILE]))
        return `${r.path}: ${r.publicItems} public Items`
      })

      await step('private', async () => {
        const message = `starsieve: ${date} run (+${(report.collected.github ?? 0) + (report.collected.x ?? 0)} Items, ${report.classified} classified)`
        // Under the store lock: a Panel edit is never committed half-written.
        const sha = await withStoreLock(store, () =>
          commitPaths(privateTop, [storeSpec, `:(exclude)${join(storeSpec, 'heartbeat.json')}`, storeLockExclude(storeSpec)], message),
        )
        if (sha) report.private.commits.push(sha)
        if (!push) return `${sha ? `committed ${sha.slice(0, 7)}` : 'nothing to commit'}; not pushed (--no-push)`
        await pushPrivate(privateTop)
        report.private.pushed = true
        return `${sha ? `committed ${sha.slice(0, 7)}` : 'nothing to commit'}; pushed`
      })

      await step('public', async () => {
        if (!choice) throw new Error('no branch')
        let sha: string | undefined
        if (changed) {
          sha = await commitPaths(pub, PUBLIC_PATHS, `starsieve: publish ${date} (${doc?.items.length ?? 0} public Items)`)
          report.public.commit = sha ?? null
        }
        if (!push) return `${sha ? `committed ${sha.slice(0, 7)} on ${choice.branch}` : 'nothing to commit'}; not pushed (--no-push)`
        // Local commits no remote has seen become one commit of the current projection, so nothing taken back since leaks.
        const squashed = await squashUnpushed(pub, choice.branch, base, `starsieve: publish ${date} (${doc?.items.length ?? 0} public Items)`)
        if (squashed) {
          sha = squashed
          report.public.commit = squashed
        }
        if (!(await needsPush(pub, choice.branch, base))) return `${sha ? `committed ${sha.slice(0, 7)}` : 'nothing to commit'}; nothing to push`
        await git(pub, ['push', '--quiet', '-u', 'origin', `${choice.branch}:${choice.branch}`])
        report.public.pushed = true
        return `${sha ? `committed ${sha.slice(0, 7)}${squashed ? ' (unpushed commits squashed into one)' : ''}; ` : ''}pushed ${choice.branch}`
      })

      await step('pr', async () => {
        if (!push) return { status: 'skipped', detail: '--no-push' }
        if (!choice || !(await differsFromBase(pub, choice.branch, base))) return { status: 'skipped', detail: `${choice?.branch} has nothing main lacks` }
        const slug = options.slug ?? '<owner/name>'
        const create = ['pr', 'create', '--repo', slug, '--base', 'main', '--head', choice.branch, '--title', `starsieve: ${date}`, '--body', prBody(report, doc?.items.length ?? 0)]
        // The commit this run pushed (or found pushed): the only head the PR may be merged at.
        const head = (await revParse(pub, choice.branch)) ?? ''
        if (!external) {
          for (const args of [create, ['pr', 'merge', '<url>', '--repo', slug, '--match-head-commit', head, '--auto', '--squash']]) {
            const line = shell(['gh', ...args])
            report.printed.push(line)
            log.line(`pr: would run: ${line}`)
          }
          return { status: 'dry-run', detail: 'printed gh pr create and gh pr merge --auto --squash; nothing sent' }
        }
        if (!options.slug) throw new Error('set "publicRepo": "owner/name" in ~/.config/starsieve/config.json, so gh knows the public repository')
        let url = openPr?.url
        if (!url) {
          const r = await deps.gh('gh', create, { cwd: pub })
          if (r.code !== 0) throw new Error(`gh pr create failed: ${tail(r)}`)
          url = r.stdout.trim().split('\n').pop()!
        }
        report.public.pr = url
        await confirmPrHead(deps, options.slug, url, head, pub)
        const m = await deps.gh('gh', ['pr', 'merge', url, '--repo', options.slug, '--match-head-commit', head, '--auto', '--squash'], { cwd: pub })
        if (m.code !== 0) throw new Error(`gh pr merge --auto failed for ${url}: ${tail(m)}`)
        return `${openPr ? 'updated' : 'opened'} ${url}; auto-merge (squash) on`
      })

      await step('wait-merge', async () => {
        if (!report.public.pr || !external) return { status: external ? 'skipped' : 'dry-run', detail: 'no PR to wait for' }
        const timeout = options.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS
        const until = Date.now() + timeout
        for (;;) {
          const r = await deps.gh('gh', ['pr', 'view', report.public.pr, '--repo', options.slug!, '--json', 'state'], { cwd: pub })
          const state = r.code === 0 ? (JSON.parse(r.stdout) as { state?: string }).state : undefined
          if (state === 'MERGED') {
            report.public.merged = true
            return `${report.public.pr} merged`
          }
          if (state === 'CLOSED') throw new Error(`${report.public.pr} was closed without merging`)
          if (Date.now() >= until) {
            report.public.merged = false
            // Not a failure: the next run syncs the Lists from whatever has merged by then.
            return { status: 'timeout', detail: `${report.public.pr} not merged after ${Math.round(timeout / 60000)} min; the next run syncs the Lists` }
          }
          await deps.sleep(options.pollMs ?? DEFAULT_POLL_MS)
        }
      })
    } finally {
      if (publicTouched) {
        const started = Date.now()
        const left = await restorePublic(pub, origBranch, choice, base, failed, written, log.line)
        if (failed && left) report.steps.push({ name: 'restore-public', status: 'failed', ms: Date.now() - started, error: left })
      }
    }

    await step('lists-sync', async () => {
      if (external) await git(pub, ['fetch', '--quiet', '--prune', 'origin'])
      const ref = await baseRef(pub)
      const merged = await readPublicDoc(pub, ref)
      const r = await listsSync({ storeDir: store, merged, dryRun: !external, gh: deps.gh, log: log.line })
      report.lists = {
        dryRun: r.dryRun,
        existingLists: r.existingLists,
        create: r.create,
        updates: r.updates,
        unchanged: r.unchanged,
        missing: r.missing,
        created: r.created,
        updated: r.updated,
      }
      for (const c of r.create) log.line(`lists-sync: ${r.dryRun ? 'would create' : 'created'} list ${c.name}`)
      for (const u of r.updates) log.line(`lists-sync: ${r.dryRun ? 'would add' : 'added'} ${u.repo} to ${u.add}${u.keep.length ? ` (keeps ${u.keep.join(', ')})` : ''}`)
      const what = `${r.create.length} lists to create, ${r.updates.length} repositories to add, ${r.unchanged} already in place, ${r.missing.length} not found (from ${ref})`
      return r.dryRun ? { status: 'dry-run', detail: `plan only: ${what}` } : what
    })

    report.nothingNew =
      !failed &&
      (report.collected.github ?? 0) + (report.collected.x ?? 0) === 0 &&
      report.classified === 0 &&
      report.pendingClassification === 0 &&
      !changed &&
      !report.public.pushed &&
      !report.public.pr
  } catch (e) {
    failed = true
    log.line(`run FAILED: ${(e as Error).message}`)
    report.steps.push({ name: 'run', status: 'failed', ms: Date.now() - t0, error: (e as Error).message })
  } finally {
    try {
      await finishHeartbeat(store, report, failed, previousHb, push, storeWrites, deps.now, date, log.line)
    } finally {
      await release()
    }
  }
  log.line(report.ok ? (report.nothingNew ? 'run done: nothing new, only the Heartbeat was written' : 'run done') : 'run done with failures')
  return report
}

/**
 * Writes the final Heartbeat, commits it (and anything else left in the store) and pushes. Only when the check step
 * passed, which includes the store's repository being separate from the public one (`writes` is `commit`): otherwise
 * the Heartbeat is only written locally (`local`), or not at all when the store sits in the public clone (`none`).
 */
async function finishHeartbeat(
  store: string,
  report: RunReport,
  failedSoFar: boolean,
  previous: Heartbeat | undefined,
  push: boolean,
  writes: StoreWrites,
  now: () => Date,
  date: string,
  line: (s: string) => void,
): Promise<void> {
  let failed = failedSoFar
  const attemptAt = now().toISOString()
  const write = async (ok: boolean) =>
    saveHeartbeat(store, {
      lastAttemptAt: attemptAt,
      lastSuccessAt: ok ? attemptAt : (previous?.lastSuccessAt ?? null),
      result: ok ? 'success' : 'failed',
      nothingNew: ok && report.nothingNew,
      steps: report.steps,
    })
  const started = Date.now()
  if (writes !== 'commit') {
    failed = true
    const why = writes === 'local' ? 'written to the store only; not committed or pushed' : 'not written: the store is in the public clone'
    if (writes === 'local') await requireStore(store).then(() => write(false)).catch(() => {})
    report.steps.push({ name: 'heartbeat', status: 'skipped', ms: Date.now() - started, detail: why })
    line(`heartbeat: ${why}`)
    report.ok = false
    return
  }
  try {
    await requireStore(store)
    await write(!failed)
    const top = await topLevel(store)
    const spec = relative(top, store) || '.'
    const message = `starsieve: heartbeat ${date} (${failed ? 'failed' : report.nothingNew ? 'nothing new' : 'success'})`
    const sha = await withStoreLock(store, () => commitPaths(top, [spec, storeLockExclude(spec)], message))
    if (sha) report.private.commits.push(sha)
    if (push) {
      await pushPrivate(top)
      report.private.pushed = true
    }
    report.steps.push({ name: 'heartbeat', status: 'ok', ms: Date.now() - started, detail: `${sha ? `committed ${sha.slice(0, 7)}` : 'nothing to commit'}${push ? ', pushed' : ', not pushed (--no-push)'}` })
    line(`heartbeat: ${failed ? 'failed' : 'success'} recorded${push ? ' and pushed' : ''}`)
  } catch (e) {
    failed = true
    report.steps.push({ name: 'heartbeat', status: 'failed', ms: Date.now() - started, error: (e as Error).message })
    line(`heartbeat: FAILED: ${(e as Error).message}`)
    // The committed file may say success; the local one must not, so the next run commits the truth.
    await write(false).catch(() => {})
  }
  report.ok = !failed
}

async function pushPrivate(top: string): Promise<void> {
  const branch = await currentBranch(top)
  if (!branch) throw new Error(`${top} is not on a branch`)
  await git(top, ['push', '--quiet', '-u', 'origin', `${branch}:${branch}`])
}

interface PrHead {
  url?: string
  headRefName?: string
  headRefOid?: string
  isCrossRepository?: boolean
  headRepositoryOwner?: { login?: string } | null
}

/** The PR's head branch lives in the public repository itself, not in a fork. */
function sameRepoHead(pr: PrHead, slug: string): boolean {
  const owner = slug.split('/')[0]!.toLowerCase()
  return pr.isCrossRepository === false && pr.headRepositoryOwner?.login?.toLowerCase() === owner
}

const PR_FIELDS = 'url,headRefName,headRefOid,isCrossRepository,headRepositoryOwner'

/**
 * The open starsieve PR, if there is one: its branch is reused instead of opening a second PR. Only a PR the owner
 * opened, from a branch of the public repository itself: a fork's PR with a `starsieve/` branch is never picked up.
 */
async function findOpenPr(gh: Exec, slug: string | undefined, cwd: string): Promise<{ url: string; branch: string } | undefined> {
  if (!slug) return undefined
  const r = await gh('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--author', '@me', '--json', PR_FIELDS, '--limit', '50'], { cwd })
  if (r.code !== 0) throw new Error(`gh pr list failed: ${tail(r)}`)
  const prs = JSON.parse(r.stdout) as PrHead[]
  const pr = prs.find((p) => p.headRefName?.startsWith(BRANCH_PREFIX) && sameRepoHead(p, slug))
  return pr?.url && pr.headRefName ? { url: pr.url, branch: pr.headRefName } : undefined
}

/**
 * Before auto-merge: the PR's head must be the commit this run pushed, from the public repository's own branch.
 * GitHub can take a moment to see a push, so it asks a few times.
 */
async function confirmPrHead(deps: RunDeps, slug: string, url: string, head: string, cwd: string): Promise<void> {
  let seen: PrHead = {}
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await deps.sleep(2000)
    const r = await deps.gh('gh', ['pr', 'view', url, '--repo', slug, '--json', PR_FIELDS], { cwd })
    if (r.code !== 0) throw new Error(`gh pr view failed for ${url}: ${tail(r)}`)
    seen = JSON.parse(r.stdout) as PrHead
    if (!sameRepoHead(seen, slug)) throw new Error(`${url} comes from another repository (${seen.headRepositoryOwner?.login ?? 'unknown owner'}); not merging it`)
    if (head && seen.headRefOid === head) return
  }
  throw new Error(`${url} is at ${seen.headRefOid ?? 'an unknown commit'}, not ${head || 'the pushed commit'}; not merging it`)
}

/**
 * Back to the branch the owner had; drop a new branch that got no commit. After a failure, first undo the uncommitted
 * files this run wrote, but only those still holding exactly what it wrote: a change the run did not make (the owner's)
 * is never overwritten or removed, and commits are never undone. Returns what was left as it is (changes kept, a branch
 * not switched back, an error), for the report; undefined when the clone was fully restored.
 */
async function restorePublic(
  pub: string,
  orig: string | undefined,
  choice: BranchChoice | undefined,
  base: string,
  failed: boolean,
  written: ReadonlyMap<string, string>,
  line: (s: string) => void,
): Promise<string | undefined> {
  const left: string[] = []
  try {
    if (failed) {
      const { kept } = await rollbackWrites(pub, written)
      if (kept.length) {
        const msg = `not rolled back, changes this run did not make are kept in ${pub}: ${kept.join(', ')}`
        left.push(msg)
        line(`public clone: ${msg}`)
      }
    }
    const current = await currentBranch(pub)
    if (orig && current !== orig) {
      try {
        await git(pub, ['checkout', '--quiet', orig])
      } catch (e) {
        // git refuses when a kept change would be overwritten; the clone stays where it is.
        const msg = `stayed on ${current ?? 'a detached HEAD'} instead of going back to ${orig}: ${(e as Error).message}`
        left.push(msg)
        line(`public clone: ${msg}`)
        return left.join('; ')
      }
    }
    if (choice && !choice.reused && (await revParse(pub, choice.branch)) === (await revParse(pub, base))) {
      if (!(await pushedBefore(pub, choice.branch))) await git(pub, ['branch', '--quiet', '-D', choice.branch])
    }
  } catch (e) {
    const msg = `could not restore ${orig ?? 'the original branch'}: ${(e as Error).message}`
    left.push(msg)
    line(`public clone: ${msg}`)
  }
  return left.length ? left.join('; ') : undefined
}

function prBody(report: RunReport, publicItems: number): string {
  return [
    `Daily publish by \`starsieve run\`: ${publicItems} public Items.`,
    '',
    `- New: ${report.collected.github ?? 'not collected'} GitHub, ${report.collected.x ?? 'not collected'} X`,
    `- Classified this run: ${report.classified}`,
    report.held.length ? `- Not updated this run (collection failed): ${report.held.join(', ')}` : '',
    '',
    'Merges itself once the required check passes.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}
