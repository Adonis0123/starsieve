// The owner's machine settings, outside any store: ~/.config/starsieve/config.json.
// `storePath`: the Private Store the Panel shows and `run` uses. `portalCss` (optional): the Portal's local-tools.css that
// `site build` inlines instead of its default stylesheet. `publicRepoPath`: the local clone of the public repository
// `run` publishes into; `publicRepo`: its `owner/name` for `gh`. `schedulePush`: whether the LaunchAgent's run pushes (false: `--no-push`). `scheduleMaxBatches`: the
// LaunchAgent's `--max-batches`. `mergeTimeoutMs`: how long `run` waits for the public PR to merge. `readme.title`: the
// public READMEs' title, one line for both README.md (English) and README.zh-CN.md (Chinese), or `{ en, zh }` to title
// each (a missing one falls back to that language's default). `siteUrl`: the public site, linked from the README (never derived from `publicRepo`: the
// repository name does not prove Pages is on, nor give a custom domain). `collectX`: whether `run` collects X likes and
// bookmarks (default true; false skips the step, for a machine without ego-browser or an X login).
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readJson } from './json.ts'

export interface UserConfig {
  storePath?: string
  portalCss?: string
  publicRepoPath?: string
  publicRepo?: string
  schedulePush?: boolean
  collectX?: boolean
  scheduleMaxBatches?: number
  mergeTimeoutMs?: number
  readme?: { title?: ReadmeTitle }
  siteUrl?: string
}

/** One title for both public READMEs, or one per language. */
export type ReadmeTitle = string | { en?: string; zh?: string }

export function defaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'starsieve', 'config.json')
}

/** `~/…` and relative paths, made absolute (relative to the config file's folder). */
export function expandPath(value: string, relativeTo: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(relativeTo, value)
}

export class UserConfigError extends Error {}

const oneLine = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v)

function readmeTitle(v: unknown, path: string): ReadmeTitle {
  if (oneLine(v)) return v.trim()
  const fail = (): never => {
    throw new UserConfigError(`${path}: readme.title must be one non-empty line, or { "en": …, "zh": … } with one non-empty line each`)
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail()
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 0 || keys.some((k) => k !== 'en' && k !== 'zh')) return fail()
  const out: { en?: string; zh?: string } = {}
  for (const k of ['en', 'zh'] as const) {
    if (o[k] === undefined) continue
    if (!oneLine(o[k])) return fail()
    out[k] = o[k].trim()
  }
  return out
}

/** undefined when the file does not exist; throws UserConfigError when it is not valid. */
export async function loadUserConfig(path: string): Promise<UserConfig | undefined> {
  let doc: Record<string, unknown> | undefined
  try {
    doc = await readJson<Record<string, unknown>>(path)
  } catch (e) {
    throw new UserConfigError((e as Error).message)
  }
  if (doc === undefined) return undefined
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new UserConfigError(`${path} must be a JSON object`)
  const out: UserConfig = {}
  const dir = join(path, '..')
  for (const key of ['storePath', 'portalCss', 'publicRepoPath'] as const) {
    const v = doc[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || v === '') throw new UserConfigError(`${path}: ${key} must be a non-empty path`)
    out[key] = expandPath(v, dir)
  }
  if (doc.publicRepo !== undefined) {
    if (typeof doc.publicRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(doc.publicRepo)) {
      throw new UserConfigError(`${path}: publicRepo must be "owner/name"`)
    }
    out.publicRepo = doc.publicRepo
  }
  for (const key of ['schedulePush', 'collectX'] as const) {
    const v = doc[key]
    if (v === undefined) continue
    if (typeof v !== 'boolean') throw new UserConfigError(`${path}: ${key} must be true or false`)
    out[key] = v
  }
  for (const key of ['scheduleMaxBatches', 'mergeTimeoutMs'] as const) {
    const v = doc[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new UserConfigError(`${path}: ${key} must be a positive integer`)
    out[key] = v
  }
  if (doc.readme !== undefined) {
    const r = doc.readme as Record<string, unknown> | null
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new UserConfigError(`${path}: readme must be an object`)
    out.readme = r.title === undefined ? {} : { title: readmeTitle(r.title, path) }
  }
  if (doc.siteUrl !== undefined) {
    // It goes into a Markdown link as is, so no whitespace, parentheses or angle brackets.
    if (typeof doc.siteUrl !== 'string' || !/^https?:\/\/[^\s()<>]+$/.test(doc.siteUrl) || !URL.canParse(doc.siteUrl)) {
      throw new UserConfigError(`${path}: siteUrl must be an http(s) URL without spaces or parentheses`)
    }
    out.siteUrl = doc.siteUrl
  }
  return out
}
