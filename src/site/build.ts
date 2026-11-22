// site build: the public site, one index.html that opens offline (file://) as well as on GitHub Pages.
// Its cards come only from buildProjection(), the same filter `publish` runs (ADR 0002); it renders with the Panel's
// page and client code, read-only. A stylesheet with the Portal's tokens and .lt-* components is inlined, since the
// Portal is not there: the Portal's local-tools.css when one is given, else default.css, a trimmed copy shipped here.
// The page uses the light values. No timestamps, so the same store gives the same file.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeText } from '../core/json.ts'
import { loadCategories } from '../core/store.ts'
import { defaultUserConfigPath, loadUserConfig } from '../core/user-config.ts'
import { renderPage } from '../panel/page.ts'
import { siteData } from '../panel/view.ts'
import { buildProjection, type PublicDoc } from '../publish/projection.ts'

export interface SiteOptions {
  /** The Portal's local-tools.css; else `portalCss` in ~/.config/starsieve/config.json; else DEFAULT_CSS. */
  css?: string
  configPath?: string
  /** The Public Projection to render, when the caller already built it (run, with a held Source); else built here. */
  doc?: PublicDoc
  /** Called after index.html is written, with what was written. */
  onWrite?: (path: string, text: string) => void
}

export interface SiteResult {
  out: string
  path: string
  publicItems: number
  css: string
}

export class SiteError extends Error {}

/** The stylesheet the site uses when neither `--css` nor `portalCss` names one. */
export const DEFAULT_CSS = fileURLToPath(new URL('./default.css', import.meta.url))

async function cssPath(options: SiteOptions): Promise<string> {
  if (options.css) return options.css
  const config = await loadUserConfig(options.configPath ?? defaultUserConfigPath())
  return config?.portalCss ?? DEFAULT_CSS
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
  options.onWrite?.(path, html)
  return { out: outDir, path, publicItems: doc.items.length, css }
}
