#!/usr/bin/env node
// Entry point: parse, dispatch, print text or the --json envelope, map errors to exit codes.
import { realpathSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classify } from '../classify/runner.ts'
import { collectGithub, type FetchStars } from '../collect/github.ts'
import { backfillX, collectX, type ListResult, type OpenXBrowser, X_LISTS, type XList } from '../collect/x.ts'
import { openEgoBrowser } from '../collect/x-browser.ts'
import { type ApplyInput, ApplyInputError, applyBatch } from '../core/apply.ts'
import { buildBatch } from '../core/batch.ts'
import { CategoryTableError, initCategories, setCategories } from '../core/categories.ts'
import { overrideItem, unskipItem } from '../core/override.ts'
import { defaultUserConfigPath, loadUserConfig, type UserConfig } from '../core/user-config.ts'
import { githubCommands, initData } from '../init/init.ts'
import { listItems, listText } from '../list/list.ts'
import { listsSync } from '../lists/sync.ts'
import type { Exec } from '../run/exec.ts'
import { githubSlug, originUrl } from '../run/git.ts'
import { LockedError } from '../run/lock.ts'
import { defaultLogDir } from '../run/log.ts'
import { baseRef, readPublicDoc } from '../run/public-repo.ts'
import { type RunDeps, type RunReport, run } from '../run/run.ts'
import { install, status as scheduleStatus, uninstall } from '../schedule/launchd.ts'
import { loadClassifications, loadItems, requireStore } from '../core/store.ts'
import { SCHEMA_VERSION, type Source, type Visibility } from '../core/types.ts'
import { check, publish } from '../publish/projection.ts'
import { buildSite } from '../site/build.ts'
import { parseArgs, UsageError } from './args.ts'

const HELP = `starsieve — sort your GitHub stars and X likes and bookmarks into Categories with any agent CLI,
publish only what may be public

Usage:
  starsieve collect github --store <dir>         read every star with gh and merge them into the store
  starsieve collect x --store <dir> [--signal likes|bookmarks|all] [--known-stop 20] [--max-scrolls 40]
                                                 read new X posts from the top of each list in ego-browser
  starsieve backfill x --store <dir> [--signal likes|bookmarks|all] [--max-scrolls 400]
                                                 one long scroll for older X posts, saved every 10 scrolls
  starsieve categories init --store <dir>        write the default Category Table if there is none
  starsieve categories set --store <dir> --file <json> [--reclassify]
                                                 replace the Category Table; --reclassify makes every unlocked
                                                 Classifier Classification pending again
  starsieve pending --store <dir> [--limit 25] [--source github|x]
                                                 print the next Batch of unclassified Items
  starsieve classify --store <dir> [--limit 25] [--source github|x]
                                                 run the Classifier on one Batch and apply its answer
  starsieve apply --store <dir> --file <json>    validate and write Classifications for one Batch
  starsieve override <id> --store <dir> [--category X] [--tags a,b] [--summary S] [--visibility public|private]
                                                 change a Classification by hand and Lock it
  starsieve override <id> --store <dir> --unskip take a Skipped Item back; the next X collection stores it as pending
  starsieve publish --store <dir> --out <dir> [--dry-run]
                                                 build the Public Projection (items.json, README.md)
  starsieve check --store <dir>                  report what is left to classify or publish
  starsieve list --store <dir> [--q <words>] [--category <name>] [--source github|x] [--visibility public|private]
                 [--needs-review] [--limit 50]   find Items by words (every word must match), newest first; read-only
  starsieve site build --store <dir> --out <dir> [--css <local-tools.css>]
                                                 write index.html, the public site, from the Public Projection
  starsieve run [--store <dir>] [--public <clone>] [--no-push] [--pr-dry-run] [--dry-run] [--max-batches N]
                                                 the daily pipeline: collect, classify, publish, commit, push, PR,
                                                 wait for the merge, sync GitHub Lists; writes heartbeat.json
  starsieve lists sync [--store <dir>] [--public <clone>] [--dry-run]
                                                 add merged public GitHub Items to their Category's GitHub List
  starsieve init data --private <clone> --public <clone> [--store <dir>] [--force]
                                                 write the CI workflows and scripts of both data repositories
  starsieve init github --dry-run [--repo owner/name]
                                                 print the gh api commands that set up the public repository
  starsieve schedule install|uninstall|status    the LaunchAgent that runs "starsieve run" daily at 08:17

Options:
  --json        machine-readable output with schemaVersion
  -h, --help    show this help

Exit codes: 0 done, 1 failed, 2 usage error.`

interface Spec {
  flags?: string[]
  valued?: string[]
  required?: string[]
}

const COMMANDS: Record<string, Spec> = {
  'collect github': { required: ['store'] },
  'collect x': { valued: ['signal', 'known-stop', 'max-scrolls'], required: ['store'] },
  'backfill x': { valued: ['signal', 'max-scrolls'], required: ['store'] },
  'categories init': { required: ['store'] },
  'categories set': { flags: ['reclassify'], valued: ['file'], required: ['store', 'file'] },
  pending: { valued: ['limit', 'source'], required: ['store'] },
  classify: { valued: ['limit', 'source'], required: ['store'] },
  apply: { valued: ['file'], required: ['store', 'file'] },
  override: { flags: ['unskip'], valued: ['category', 'tags', 'summary', 'visibility'], required: ['store'] },
  publish: { flags: ['dry-run'], valued: ['out'], required: ['store', 'out'] },
  check: { required: ['store'] },
  list: { flags: ['needs-review'], valued: ['q', 'category', 'source', 'visibility', 'limit'], required: ['store'] },
  'site build': { valued: ['out', 'css'], required: ['store', 'out'] },
  run: { flags: ['no-push', 'pr-dry-run', 'dry-run'], valued: ['public', 'max-batches'] },
  'lists sync': { flags: ['dry-run'], valued: ['public'] },
  'init data': { flags: ['force'], valued: ['private', 'public'], required: ['private', 'public'] },
  'init github': { flags: ['dry-run'], valued: ['repo', 'public'] },
  'schedule install': {},
  'schedule uninstall': {},
  'schedule status': {},
}

export interface Io {
  out: (s: string) => void
  err: (s: string) => void
}

export interface MainOptions {
  io?: Io
  /** Fakes for tests; the CLI itself passes none. */
  fetchStars?: FetchStars
  openXBrowser?: OpenXBrowser
  /** ~/.config/starsieve/config.json by default. */
  configPath?: string
  /** run's collectors, Classifier, gh, clock; lists sync's gh. */
  runDeps?: Partial<RunDeps>
  logDir?: string
  /** schedule: the home directory (LaunchAgents) and launchctl. */
  home?: string
  launchctl?: Exec
  loginPath?: () => Promise<string>
}

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function runText(r: RunReport): string {
  const lines = r.steps.map((s) => `${s.name}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}${s.error ? ` — ${s.error}` : ''}`)
  for (const p of r.printed) lines.push(`would run: ${p}`)
  lines.push(r.ok ? (r.nothingNew ? 'nothing new: only the Heartbeat was written' : 'done') : 'failed', `log: ${r.logPath}`)
  return lines.join('\n')
}

const defaultIo: Io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }

function positiveInt(name: string, value: string | true | undefined, fallback: number, min = 1): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be ${min === 0 ? 'a whole number, 0 or more' : 'a positive integer'}`)
  return n
}

const limitOf = (value: string | true | undefined) => positiveInt('limit', value, 25)

function sourceOf(value: string | true | undefined): Source | undefined {
  if (value === undefined) return undefined
  if (value !== 'github' && value !== 'x') throw new UsageError('--source must be github or x')
  return value
}

function visibilityOf(value: string | true | undefined): Visibility | undefined {
  if (value === undefined) return undefined
  if (value !== 'public' && value !== 'private') throw new UsageError('--visibility must be public or private')
  return value
}

function listsOf(value: string | true | undefined): XList[] {
  if (value === undefined || value === 'all') return [...X_LISTS]
  if (value === 'likes' || value === 'bookmarks') return [value]
  throw new UsageError('--signal must be likes, bookmarks or all')
}

function listsText(lists: ListResult[]): string {
  return lists
    .map((l) => `${l.list}: ${l.added} added, ${l.signalAdded} gained ${l.signal}, ${l.seen} read in ${l.scrolls} scrolls (stopped: ${l.stoppedBy})`)
    .join('\n')
}

/** Ctrl-C between scrolls ends the scan normally, so what was read is saved and the browser task is finished. */
function interruptible(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const onInt = () => controller.abort()
  process.once('SIGINT', onInt)
  return { signal: controller.signal, done: () => process.off('SIGINT', onInt) }
}

/** The public README's display options; the config is read here so renderReadme stays pure. */
const readmeOf = (c: UserConfig) => ({ title: c.readme?.title, siteUrl: c.siteUrl })

function commandKey(positionals: string[]): { key: string; rest: string[] } | undefined {
  const two = positionals.slice(0, 2).join(' ')
  if (COMMANDS[two]) return { key: two, rest: positionals.slice(2) }
  const one = positionals[0]
  if (one && COMMANDS[one]) return { key: one, rest: positionals.slice(1) }
  return undefined
}

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const io = options.io ?? defaultIo
  const json = argv.includes('--json')
  const emit = (command: string, data: Record<string, unknown>, text: string) => {
    if (json) io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, command, ...data }, null, 2))
    else io.out(text)
  }
  const fail = (code: number, message: string) => {
    if (json) io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, error: { message } }, null, 2))
    io.err(`starsieve: ${message}`)
    return code
  }

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.out(HELP)
    return 0
  }
  // The command words come before the first option.
  const firstOption = argv.findIndex((a) => a.startsWith('-'))
  const leading = firstOption === -1 ? argv : argv.slice(0, firstOption)
  const found = commandKey(leading)
  if (!found) return fail(2, `unknown command "${leading.join(' ')}"; see starsieve --help`)
  const spec = COMMANDS[found.key]!

  try {
    const parsed = parseArgs(argv, ['json', ...(spec.flags ?? [])], ['store', ...(spec.valued ?? [])])
    for (const name of spec.required ?? []) {
      if (typeof parsed.flags.get(name) !== 'string') throw new UsageError(`${found.key} needs --${name} <value>`)
    }
    const flag = (name: string) => {
      const v = parsed.flags.get(name)
      return typeof v === 'string' ? v : undefined
    }
    const store = flag('store')!
    let userConfig: UserConfig | undefined
    const config = async () => (userConfig ??= (await loadUserConfig(options.configPath ?? defaultUserConfigPath())) ?? {})
    const storeOrConfig = async () => {
      const s = flag('store') ?? (await config()).storePath
      if (!s) throw new UsageError(`${found.key} needs --store <dir>, or "storePath" in ${options.configPath ?? defaultUserConfigPath()}`)
      return s
    }
    const publicOrConfig = async () => {
      const p = flag('public') ?? (await config()).publicRepoPath
      if (!p) throw new UsageError(`${found.key} needs --public <clone>, or "publicRepoPath" in ${options.configPath ?? defaultUserConfigPath()}`)
      return p
    }
    const rest = parsed.positionals.slice(found.key.split(' ').length)

    switch (found.key) {
      case 'collect github': {
        const r = await collectGithub(store, options.fetchStars)
        emit(found.key, { ...r }, `${r.total} Items (${r.added} added, ${r.updated} updated, ${r.notSeen} not seen)`)
        return 0
      }
      case 'collect x': {
        const lists = await collectX(store, {
          lists: listsOf(parsed.flags.get('signal')),
          knownStop: positiveInt('known-stop', parsed.flags.get('known-stop'), 20),
          maxScrolls: positiveInt('max-scrolls', parsed.flags.get('max-scrolls'), 40),
          openBrowser: options.openXBrowser ?? openEgoBrowser,
        })
        const added = lists.reduce((n, l) => n + l.added, 0)
        emit(found.key, { added, lists }, listsText(lists))
        return 0
      }
      case 'backfill x': {
        const stop = interruptible()
        try {
          const lists = await backfillX(store, {
            lists: listsOf(parsed.flags.get('signal')),
            maxScrolls: positiveInt('max-scrolls', parsed.flags.get('max-scrolls'), 400),
            openBrowser: options.openXBrowser ?? openEgoBrowser,
            signal: stop.signal,
          })
          const added = lists.reduce((n, l) => n + l.added, 0)
          emit(found.key, { added, lists }, listsText(lists))
        } finally {
          stop.done()
        }
        return 0
      }
      case 'categories init': {
        const r = await initCategories(store)
        const names = r.table.categories.map((c) => c.name)
        emit(found.key, { created: r.created, categories: names }, `${r.created ? 'created' : 'kept existing'}: ${names.join(', ')}`)
        return 0
      }
      case 'categories set': {
        let doc: unknown
        try {
          doc = JSON.parse(await readFileAsync(flag('file')!, 'utf8'))
        } catch (e) {
          throw new CategoryTableError(`cannot read ${flag('file')}: ${(e as Error).message}`)
        }
        const r = await setCategories(store, doc, { reclassify: parsed.flags.get('reclassify') === true })
        const lines = [`${r.categories.length} Categories: ${r.categories.join(', ')}`, `${r.removed} Classifications removed; those Items are pending again`]
        for (const s of r.staleLocked) lines.push(`  Locked ${s.id} is in ${s.category}, which is not in the table: override it`)
        emit(found.key, { ...r }, lines.join('\n'))
        return 0
      }
      case 'pending': {
        const limit = limitOf(parsed.flags.get('limit'))
        const source = sourceOf(parsed.flags.get('source'))
        await requireStore(store)
        const batch = buildBatch(await loadItems(store), await loadClassifications(store), limit, source)
        // pending is always the Batch document itself, so it can be handed to an agent or to apply.
        io.out(JSON.stringify(batch, null, 2))
        return 0
      }
      case 'classify': {
        const r = await classify(store, limitOf(parsed.flags.get('limit')), sourceOf(parsed.flags.get('source')))
        const a = r.apply
        const text = a
          ? `${r.batch.batchId} (${r.batch.source}): ${a.accepted} accepted, ${a.skippedItems} became Skipped Items, ${a.rejected} rejected, ${a.skipped} Locked, ${a.missing.length} missing (${Math.round(r.agentMs / 1000)} s)`
          : 'nothing to classify'
        emit(found.key, { ...r }, text)
        return 0
      }
      case 'apply': {
        let input: ApplyInput
        try {
          input = JSON.parse(await readFileAsync(flag('file')!, 'utf8')) as ApplyInput
        } catch (e) {
          throw new ApplyInputError(`cannot read ${flag('file')}: ${(e as Error).message}`)
        }
        const r = await applyBatch(store, input)
        const lines = [
          `${r.batchId}: ${r.accepted} accepted, ${r.skippedItems} became Skipped Items, ${r.rejected} rejected, ${r.skipped} Locked`,
        ]
        for (const x of r.results) if (x.status !== 'accepted') lines.push(`  ${x.status} ${x.id}: ${x.reasons.join('; ')}`)
        emit(found.key, { ...r }, lines.join('\n'))
        return 0
      }
      case 'override': {
        const id = rest[0]
        if (!id || rest.length > 1) throw new UsageError('override needs exactly one Item id')
        if (parsed.flags.get('unskip') === true) {
          if (['category', 'tags', 'summary', 'visibility'].some((n) => parsed.flags.has(n))) {
            throw new UsageError('--unskip takes no other change; a Skipped Item has no Classification')
          }
          const r = await unskipItem(store, id)
          emit(
            found.key,
            { ...r, unskipped: true },
            `${id}: no longer skipped; the next "collect x" or "backfill x" that reads it stores it as pending (${r.url})`,
          )
          return 0
        }
        const tags = flag('tags')
        const c = await overrideItem(store, id, {
          category: flag('category'),
          tags: tags === undefined ? undefined : tags.split(','),
          visibility: flag('visibility'),
          summary: flag('summary'),
        })
        emit(found.key, { id, classification: c }, `${id}: ${c.category}, ${c.visibility}, Locked`)
        return 0
      }
      case 'publish': {
        const c = await config()
        const r = await publish(store, flag('out')!, parsed.flags.get('dry-run') === true, { readme: readmeOf(c) })
        const diff = r.identical
          ? 'no difference'
          : `+${r.added.length} -${r.removed.length} ~${r.changed.length}${r.readmeChanged ? ', README changed' : ''}`
        emit(found.key, { ...r }, `${r.dryRun ? 'would publish' : 'published'} ${r.publicItems} Items to ${r.out}: ${diff}`)
        return 0
      }
      case 'site build': {
        const r = await buildSite(store, flag('out')!, { css: flag('css') })
        emit(found.key, { ...r }, `wrote ${r.path}: ${r.publicItems} public Items`)
        return 0
      }
      case 'run': {
        const c = await config()
        const maxBatches = parsed.flags.has('max-batches') ? positiveInt('max-batches', parsed.flags.get('max-batches'), 1, 0) : undefined
        let r: RunReport
        try {
          r = await run({
            store: await storeOrConfig(),
            publicRepo: await publicOrConfig(),
            slug: c.publicRepo,
            push: parsed.flags.get('no-push') !== true,
            prDryRun: parsed.flags.get('pr-dry-run') === true,
            dryRun: parsed.flags.get('dry-run') === true,
            maxBatches,
            collectX: c.collectX,
            css: c.portalCss,
            readme: readmeOf(c),
            mergeTimeoutMs: c.mergeTimeoutMs,
            logDir: options.logDir,
            echo: json ? undefined : (line) => io.err(line),
            deps: {
              ...(options.fetchStars ? { collectGithub: (s: string) => collectGithub(s, options.fetchStars) } : {}),
              ...options.runDeps,
            },
          })
        } catch (e) {
          if (e instanceof LockedError) return fail(1, e.message)
          throw e
        }
        if (json) {
          const { ok, ...rest } = r
          io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok, command: found.key, ...rest }, null, 2))
        }
        else io.out(runText(r))
        return r.ok ? 0 : 1
      }
      case 'lists sync': {
        const s = await storeOrConfig()
        const pub = await publicOrConfig()
        const ref = await baseRef(pub)
        const r = await listsSync({
          storeDir: s,
          merged: await readPublicDoc(pub, ref),
          dryRun: parsed.flags.get('dry-run') === true,
          gh: options.runDeps?.gh,
        })
        const lines = [
          `${r.dryRun ? 'plan' : 'done'} (from ${ref}): ${r.existingLists} lists exist, ${r.create.length} to create, ${r.updates.length} repositories to add, ${r.unchanged} already in place, ${r.missing.length} not found`,
          ...r.create.map((c) => `  ${r.dryRun ? 'create' : 'created'} list ${c.name}`),
          ...r.updates.map((u) => `  add ${u.repo} to ${u.add}${u.keep.length ? ` (keeps ${u.keep.join(', ')})` : ''}`),
          ...r.missing.map((m) => `  not found: ${m}`),
        ]
        emit(found.key, { ref, ...r }, lines.join('\n'))
        return 0
      }
      case 'init data': {
        const files = await initData({
          privateDir: flag('private')!,
          publicDir: flag('public')!,
          storeDir: flag('store'),
          force: parsed.flags.get('force') === true,
        })
        const text = files.map((f) => `${f.status.padEnd(9)} ${f.path}`)
        if (files.some((f) => f.status === 'kept')) text.push('kept: differs from the template; --force overwrites it')
        emit(found.key, { files }, text.join('\n'))
        return 0
      }
      case 'init github': {
        if (parsed.flags.get('dry-run') !== true) {
          throw new UsageError('init github only prints the commands for now: pass --dry-run, then run them yourself')
        }
        const c = await config()
        const pub = flag('public') ?? c.publicRepoPath
        const slug = flag('repo') ?? c.publicRepo ?? (pub ? githubSlug(await originUrl(pub)) : undefined)
        if (!slug) throw new UsageError('init github needs --repo owner/name, or "publicRepo" in the config')
        const commands = githubCommands(slug)
        emit(found.key, { repo: slug, dryRun: true, commands }, commands.map((c) => `# ${c.what}\n${c.command}`).join('\n\n'))
        return 0
      }
      case 'schedule install': {
        const c = await config()
        const push = c.schedulePush === true
        const r = await install({
          repoDir: REPO_DIR,
          logDir: options.logDir ?? defaultLogDir(),
          push,
          maxBatches: c.scheduleMaxBatches,
          home: options.home,
          launchctl: options.launchctl,
          loginPath: options.loginPath,
        })
        emit(found.key, { ...r }, `installed ${r.plist}: daily at 08:17, ${r.programArguments.slice(2).join(' ')}${push ? '' : ' (schedulePush is false)'}${r.legacyRemoved.length ? `; removed ${r.legacyRemoved.join(', ')}` : ''}`)
        return 0
      }
      case 'schedule uninstall': {
        const r = await uninstall({ home: options.home, launchctl: options.launchctl })
        emit(found.key, { ...r }, r.removed ? `removed ${[r.plist, ...r.legacyRemoved].join(', ')}` : `${r.plist} was not installed`)
        return 0
      }
      case 'schedule status': {
        const r = await scheduleStatus({ home: options.home, launchctl: options.launchctl })
        emit(
          found.key,
          { ...r },
          r.installed
            ? `${r.plist}: ${r.loaded ? `loaded (${r.state ?? 'unknown'}, ${r.runs ?? 0} runs, last exit ${r.lastExitCode ?? 'none'})` : 'not loaded'}${r.noPush ? ', --no-push' : ''}${r.legacy ? `; old label ${r.label}, "schedule install" replaces it` : ''}`
            : 'not installed',
        )
        return 0
      }
      case 'list': {
        const r = await listItems(store, {
          q: flag('q'),
          category: flag('category'),
          source: sourceOf(parsed.flags.get('source')),
          visibility: visibilityOf(parsed.flags.get('visibility')),
          needsReview: parsed.flags.get('needs-review') === true,
          limit: positiveInt('limit', parsed.flags.get('limit'), 50),
        })
        emit(found.key, { ...r }, listText(r))
        return 0
      }
      case 'check': {
        const r = await check(store)
        emit(
          found.key,
          { ...r },
          `${r.items} Items (${r.bySource.github.items} GitHub, ${r.bySource.x.items} X), ${r.pendingClassification} to classify ` +
            `(${r.bySource.github.pendingClassification} GitHub, ${r.bySource.x.pendingClassification} X), ${r.skippedItems} Skipped Items, ` +
            `${r.pendingPublish ? 'Public Projection changed' : 'nothing new to publish'}`,
        )
        return 0
      }
    }
    return fail(2, `unhandled command ${found.key}`)
  } catch (e) {
    if (e instanceof UsageError) return fail(2, e.message)
    return fail(1, (e as Error).message)
  }
}

function isEntryPoint(): boolean {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return pathToFileURL(realpathSync(arg)).href === import.meta.url || realpathSync(arg) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2))
}
