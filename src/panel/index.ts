// starsieve Panel for the Local Tools Portal (`kind: "panel"`, docs/portal-architecture.md §4 in skills-manager).
// createPanelHandler({ basePath, allowedHosts, theme, readOnly, lang }) serves:
//   GET  /             the page (client.js renders it; the public site uses the same page with inline data)
//   GET  /api/health   { app: "starsieve", version }
//   GET  /api/token    the per-instance write token, for a page that outlived its handler
//   GET  /api/state    every Item with its Classification, the Skipped Items and the Backfill reach
//   POST /api/override { id, category?, tags?, summary?, visibility? } -> overrideItem, as `starsieve override`
//   POST /api/unskip   { id }                                       -> unskipItem, as `starsieve override --unskip`
// The Panel has no write the CLI lacks. Every request must carry an allowed Host; a POST also needs the same-origin
// Origin and the per-instance token the page got, and is refused (403) when readOnly. The store is read on each request.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { overrideItem, OverrideError, unskipItem } from '../core/override.ts'
import { defaultUserConfigPath, loadUserConfig, UserConfigError } from '../core/user-config.ts'
import type { Lang } from './i18n.ts'
import { renderPage } from './page.ts'
import { panelData } from './view.ts'

export const MAX_BODY_BYTES = 16 * 1024
const TOKEN_HEADER = 'x-starsieve-token'

export interface PanelTheme {
  colorScheme?: 'auto' | 'light' | 'dark'
  header?: 'plain' | 'bar'
  /** Token values; the page reads the Portal's /_shared/local-tools.css instead, so they are accepted and unused. */
  light?: Record<string, string>
  dark?: Record<string, string>
}

export interface PanelOptions {
  basePath?: string
  allowedHosts: string[]
  theme?: PanelTheme
  /** Hides editing and refuses every POST with 403. */
  readOnly?: boolean
  lang?: 'auto' | Lang
  version?: string
  /** Default ~/.config/starsieve/config.json; its `storePath` is the store shown. */
  configPath?: string
  /** Overrides the config file's storePath (tests). */
  storePath?: string
}

export type PanelHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & { readonly token: string }

export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

class HttpError extends Error {
  readonly status: number
  /** Machine-readable reason the page acts on: `bad-token` makes it fetch a fresh token and retry once. */
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

function normalizeBase(p: string | undefined): string {
  if (!p || p === '/') return ''
  return (p.startsWith('/') ? p : `/${p}`).replace(/\/+$/, '')
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function tildify(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function sendJson(res: ServerResponse, status: number, body: unknown, head = false): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(head ? undefined : text)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(c)
    })
    req.on('error', (e) => !failed && reject(e))
    req.on('end', () => {
      if (failed) return
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new HttpError(400, 'request body must be a JSON object'))
      }
    })
  })
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`)
  return v
}

function optStrings(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `"${key}" must be a list of strings`)
  return v as string[]
}

function checkTheme(theme: unknown): PanelTheme | undefined {
  if (theme === undefined) return undefined
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new TypeError('theme must be an object')
  const t = theme as PanelTheme
  if (t.colorScheme !== undefined && !['auto', 'light', 'dark'].includes(t.colorScheme)) {
    throw new TypeError(`theme.colorScheme must be auto, light or dark, not ${JSON.stringify(t.colorScheme)}`)
  }
  return t
}

export function createPanelHandler(options: PanelOptions): PanelHandler {
  if (!options || !Array.isArray(options.allowedHosts)) throw new TypeError('allowedHosts must be an array of host[:port] strings')
  const lang = options.lang ?? 'auto'
  if (!['auto', 'en', 'zh'].includes(lang)) throw new TypeError('lang must be "auto", "en" or "zh"')
  const theme = checkTheme(options.theme)
  const scheme = theme?.colorScheme ?? 'auto'
  const headerBar = theme?.header === 'bar'
  const base = normalizeBase(options.basePath)
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()))
  const readOnly = Boolean(options.readOnly)
  const version = options.version ?? packageVersion()
  const configPath = options.configPath ?? defaultUserConfigPath()
  const home = homedir()
  const token = randomBytes(32).toString('base64url')
  // One write at a time, so two quick edits never race on classifications.json.
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writes.then(fn, fn)
    writes = run.catch(() => undefined)
    return run
  }

  async function storeDir(): Promise<{ store?: string; error?: string }> {
    if (options.storePath) return { store: options.storePath }
    try {
      const config = await loadUserConfig(configPath)
      return config?.storePath ? { store: config.storePath } : {}
    } catch (e) {
      if (e instanceof UserConfigError) return { error: e.message }
      throw e
    }
  }

  async function state(): Promise<Record<string, unknown>> {
    const head = { schemaVersion: 1, app: 'starsieve', version, readOnly, configPath: tildify(configPath, home) }
    const { store, error } = await storeDir()
    if (error) return { ...head, status: 'error', storePath: null, error: { message: tildify(error, home) }, next: `fix ${tildify(configPath, home)}` }
    if (!store) return { ...head, status: 'unconfigured', storePath: null }
    const shown = tildify(store, home)
    try {
      return { ...head, status: 'ok', storePath: shown, data: await panelData(store) }
    } catch (e) {
      const message = tildify((e as Error).message, home)
      const next = /does not exist/.test(message)
        ? `pnpm starsieve collect github --store ${shown}`
        : `pnpm starsieve check --store ${shown}`
      return { ...head, status: 'error', storePath: shown, error: { message }, next }
    }
  }

  async function write(route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { store, error } = await storeDir()
    if (error || !store) throw new HttpError(409, error ?? `no storePath in ${tildify(configPath, home)}`)
    const id = optString(body, 'id')
    if (!id) throw new HttpError(400, '"id" is required')
    if (route === '/api/unskip') return { ok: true, ...(await serial(() => unskipItem(store, id))) }
    const change = {
      category: optString(body, 'category'),
      tags: optStrings(body, 'tags'),
      summary: optString(body, 'summary'),
      visibility: optString(body, 'visibility'),
    }
    const classification = await serial(() => overrideItem(store, id, change))
    return { ok: true, id, classification }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const raw = req.url ?? '/'
    if (base && !(raw === base || raw.startsWith(`${base}/`) || raw.startsWith(`${base}?`))) return false
    const method = req.method ?? 'GET'
    const head = method === 'HEAD'
    try {
      const host = String(req.headers.host ?? '').toLowerCase()
      if (!allowed.has(host)) throw new HttpError(403, 'host not allowed')
      let path: string
      try {
        path = new URL(raw.slice(base.length) || '/', 'http://localhost').pathname
      } catch {
        throw new HttpError(400, 'bad url')
      }
      const writeRoute = path === '/api/override' || path === '/api/unskip'
      if (writeRoute) {
        if (method !== 'POST') throw Object.assign(new HttpError(405, 'use POST'), { allow: 'POST' })
        const origin = req.headers.origin
        if (!origin || origin.toLowerCase() !== `http://${host}`) throw new HttpError(403, 'origin not allowed')
        const given = req.headers[TOKEN_HEADER]
        if (typeof given !== 'string' || !sameSecret(given, token)) {
          throw new HttpError(403, `missing or wrong ${TOKEN_HEADER}; reload the page`, 'bad-token')
        }
        if (readOnly) throw new HttpError(403, 'this Panel is read-only; use "starsieve override" instead')
        try {
          sendJson(res, 200, await write(path, await readBody(req)))
        } catch (e) {
          if (e instanceof OverrideError) throw new HttpError(400, e.message)
          throw e
        }
        return true
      }
      if (method !== 'GET' && !head) throw Object.assign(new HttpError(405, 'use GET'), { allow: 'GET, HEAD' })
      if (path === '/api/health') {
        sendJson(res, 200, { app: 'starsieve', version }, head)
        return true
      }
      if (path === '/api/token') {
        // A new handler (Portal restart, code reload) has a new token; the page fetches it here and retries once.
        // A cross-site page cannot read the answer, and the Host check above blocks DNS rebinding.
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'origin not allowed')
        if (readOnly) throw new HttpError(403, 'this Panel is read-only; use "starsieve override" instead')
        sendJson(res, 200, { token }, head)
        return true
      }
      if (path === '/api/state') {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'origin not allowed')
        sendJson(res, 200, await state(), head)
        return true
      }
      if (path === '/' || path === '/index.html') {
        const nonce = randomBytes(16).toString('base64')
        const html = renderPage({
          mode: 'panel',
          lang: lang === 'auto' ? (/^zh|,\s*zh/i.test(String(req.headers['accept-language'] ?? '')) ? 'zh' : 'en') : lang,
          scheme,
          headerBar,
          nonce,
          base,
          token: readOnly ? '' : token,
        })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'same-origin',
          'content-security-policy': [
            "default-src 'self'",
            `script-src 'self' 'nonce-${nonce}'`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'self'",
          ].join('; '),
          'content-length': String(Buffer.byteLength(html)),
        })
        res.end(head ? undefined : html)
        return true
      }
      throw new HttpError(404, 'not found')
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      const allow = (e as { allow?: string }).allow
      if (allow) res.setHeader('allow', allow)
      const code = e instanceof HttpError ? e.code : undefined
      sendJson(res, status, { ok: false, error: { message: tildify((e as Error).message, home), ...(code ? { code } : {}) } }, head)
      return true
    }
  }
  return Object.assign(handle, { token })
}
