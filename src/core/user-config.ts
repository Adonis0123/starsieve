// The owner's machine settings, outside any store: ~/.config/starsieve/config.json.
// `storePath`: the Private Store the Panel shows and `run` uses. `portalCss`: the Portal's local-tools.css that `site build`
// inlines. `publicRepoPath`: the local clone of the public repository `run` publishes into; `publicRepo`: its `owner/name`
// for `gh`. `schedulePush`: whether the LaunchAgent's run pushes (false: `--no-push`). `scheduleMaxBatches`: the
// LaunchAgent's `--max-batches`. `mergeTimeoutMs`: how long `run` waits for the public PR to merge.
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readJson } from './json.ts'

export interface UserConfig {
  storePath?: string
  portalCss?: string
  publicRepoPath?: string
  publicRepo?: string
  schedulePush?: boolean
  scheduleMaxBatches?: number
  mergeTimeoutMs?: number
}

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
  if (doc.schedulePush !== undefined) {
    if (typeof doc.schedulePush !== 'boolean') throw new UserConfigError(`${path}: schedulePush must be true or false`)
    out.schedulePush = doc.schedulePush
  }
  for (const key of ['scheduleMaxBatches', 'mergeTimeoutMs'] as const) {
    const v = doc[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new UserConfigError(`${path}: ${key} must be a positive integer`)
    out[key] = v
  }
  return out
}
