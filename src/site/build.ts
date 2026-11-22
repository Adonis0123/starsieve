// site build: the public site, one index.html that opens offline (file://) as well as on GitHub Pages.
// Its cards come only from buildProjection(), the same filter `publish` runs (ADR 0002); it renders with the Panel's
// page and client code, read-only. The Portal's local-tools.css (tokens and .lt-* components) is inlined, since the
// Portal is not there; the page uses its default light values. No timestamps, so the same store gives the same file.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeText } from '../core/json.ts'
import { loadCategories } from '../core/store.ts'
import { defaultUserConfigPath, loadUserConfig } from '../core/user-config.ts'
import { renderPage } from '../panel/page.ts'
import { siteData } from '../panel/view.ts'
import { buildProjection, type PublicDoc } from '../publish/projection.ts'

export interface SiteOptions {
  /** The Portal's local-tools.css; else `portalCss` in ~/.config/starsieve/config.json. */
  css?: string
  configPath?: string
  /** The Public Projection to render, when the caller already built it (run, with a held Source); else built here. */
  doc?: PublicDoc
}

export interface SiteResult {
  out: string
  path: string
  publicItems: number
  css: string
}

export class SiteError extends Error {}

async function cssPath(options: SiteOptions): Promise<string> {
  if (options.css) return options.css
  const configPath = options.configPath ?? defaultUserConfigPath()
  const config = await loadUserConfig(configPath)
  if (config?.portalCss) return config.portalCss
  throw new SiteError(
    `no stylesheet: pass --css <path to the Portal's web/shared/local-tools.css>, or set "portalCss" in ${configPath}`,
  )
}

export async function buildSite(storeDir: string, outDir: string, options: SiteOptions = {}): Promise<SiteResult> {
  const doc = options.doc ?? (await buildProjection(storeDir))
  const table = await loadCategories(storeDir)
  const css = await cssPath(options)
  let sharedCss: string
  try {
    sharedCss = await readFile(css, 'utf8')
  } catch (e) {
    throw new SiteError(`cannot read ${css}: ${(e as Error).message}`)
  }
  if (!/--kit-bg\s*:/.test(sharedCss)) throw new SiteError(`${css} has no --kit-* tokens; is it the Portal's local-tools.css?`)
  const html = renderPage({
    mode: 'site',
    lang: 'zh', // the catalog's Summaries are Chinese, so the site chrome is too
    scheme: 'light',
    sharedCss,
    data: siteData(doc, (table?.categories ?? []).map((c) => c.name)),
  })
  const path = join(outDir, 'index.html')
  await writeText(path, html)
  return { out: outDir, path, publicItems: doc.items.length, css }
}
