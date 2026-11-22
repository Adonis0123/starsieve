// The one page for the Panel and the public site: header, mount point, boot data and the inlined client.js.
// Colors and components come from the Portal's /_shared/local-tools.css (--kit-*/--lt-* tokens, .lt-* classes); the site
// cannot reach the Portal, so `site build` passes that stylesheet's text to inline. This file holds layout only.
import { readFileSync } from 'node:fs'
import { dictFor, type Lang, translator, ZH } from './i18n.ts'
import type { SiteData } from './view.ts'

const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
if (/<\/script/i.test(CLIENT)) throw new Error('client.js must not contain "</script"; it is inlined into a page')

/** Layout rules only. Shared classes are placed (margin, flex, width), never restyled (DESIGN.md "Panel 复用共享组件"). */
export const PAGE_CSS = `
body { margin: 0; background: var(--lt-page); color: var(--lt-text); font-family: var(--lt-font); font-size: var(--kit-font-size); line-height: 1.5 }
/* The shared .app-header is width: 100% with padding; border-box keeps it inside a narrow window. */
.app-header { box-sizing: border-box }
.lt-tabs { padding: 0 var(--lt-shell-gutter); background: var(--lt-surface); }
.lt-tabs a { display: inline-flex; align-items: center; text-decoration: none; }
.lt-tab .lt-count { margin-left: 6px }
main { padding: 0 0 48px }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
#view-skipped { padding-top: 12px }

/* Items: a side column of filters, then one toolbar line and a dense list. */
.shell { display: grid; grid-template-columns: 216px minmax(0, 1fr); gap: 24px; align-items: start }
.side { position: sticky; top: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; max-height: 100vh; padding: 12px 0 24px; overflow-y: auto; scrollbar-width: thin }
.side-group[hidden], .list[hidden] { display: none }
.side-h { margin: 0 0 4px; padding: 0 12px; color: var(--lt-muted); font-size: var(--kit-small-size); font-weight: var(--lt-weight-medium); line-height: 1.4 }
.side-list { display: flex; flex-direction: column; gap: 1px }
.side-list .lt-count { flex: none; margin-left: 8px }
.side-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left }
.side-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px }
.side-reach p { margin: 0 0 8px; padding: 0 12px; color: var(--lt-muted); font-size: var(--kit-small-size); line-height: 1.5 }
.side-reach .lt-badge { vertical-align: 1px }
.content { min-width: 0 }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 12px 0 8px; background: var(--lt-page) }
.toolbar .lt-segmented, .toolbar select { flex: none }
.toolbar input[type="search"] { flex: 1 1 220px; min-width: 0 }
.list-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 24px; margin: 0 0 6px; color: var(--lt-muted); font-size: var(--kit-small-size) }
.list-head svg { margin-left: 2px }

.list { overflow: hidden; border: 1px solid var(--lt-line); border-radius: var(--lt-radius-panel); background: var(--lt-surface) }
/* Each row draws its top line; the list clips the first one under its own border, whichever row is first visible. */
.item { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "head meta" "text labels" "full full"; gap: 0 16px; align-items: center; margin-top: -1px; padding: 8px 16px; border-top: 1px solid var(--lt-line); cursor: pointer; transition: var(--lt-transition) }
.item:hover { background: var(--lt-hover-tint) }
.item[hidden] { display: none }
.item:has(> form) { display: block; cursor: auto; background: var(--lt-surface) }
.item-head { grid-area: head; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; min-width: 0 }
.item h3 { margin: 0; min-width: 0; font-size: 14px; font-weight: var(--lt-weight-strong); line-height: 1.4; overflow-wrap: anywhere }
.item h3 a { color: var(--lt-brand-ink); text-decoration: none; text-underline-offset: 2px }
.item h3 a:hover { text-decoration: underline }
.item h3 .ext { margin-left: 4px; vertical-align: -1px; color: var(--lt-muted) }
.item-head .src { flex: none; color: var(--lt-muted); font-size: var(--kit-small-size) }
.list[data-one-category] .item-cat { display: none }
.item-meta { grid-area: meta; display: flex; gap: 6px; align-items: center; justify-content: flex-end; color: var(--lt-muted); font-size: var(--kit-small-size); white-space: nowrap; font-variant-numeric: tabular-nums }
.item-meta .stars { display: inline-flex; gap: 4px; align-items: center }
.item-meta .lt-btn { margin: -4px 0 -4px 4px }
.item .summary { grid-area: text; display: -webkit-box; margin: 0; overflow: hidden; color: var(--lt-text); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2 }
.item .summary.is-fallback { color: var(--lt-muted); font-size: 13px; -webkit-line-clamp: 1 }
.item-labels { grid-area: labels; display: flex; gap: 4px; align-items: center; justify-content: flex-end }
.item-labels .more { padding: 0 2px; color: var(--lt-muted); font-size: var(--kit-small-size) }
.item .fulltext { grid-area: full; max-width: 75ch; margin: 6px 0 2px; color: var(--lt-text); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text }
.item .fulltext[hidden] { display: none }
.item-meta .lt-btn-link { margin-right: 6px }
/* Edit is a secondary action: shown on the row a pointer is over or focus is in, and always on touch screens. */
@media (hover: hover) {
  .item-meta [data-edit] { opacity: 0 }
  .item:hover [data-edit], .item:focus-within [data-edit] { opacity: 1 }
}

.edit { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; padding: 4px 0 }
.edit > :is(h3, .note, .item-actions), .edit label:has(textarea, [name="tags"]) { grid-column: 1 / -1 }
.edit label { display: flex; flex-direction: column; gap: 4px; color: var(--lt-muted); font-size: var(--kit-small-size) }
.edit label > :is(select, input, textarea) { box-sizing: border-box; width: 100% }
.edit .note { margin: 0; color: var(--lt-muted); font-size: var(--kit-small-size) }
.item-actions { display: flex; flex-wrap: wrap; gap: 6px }

.state { max-width: 560px; margin: 48px auto; padding: 0 16px; text-align: center; color: var(--lt-muted) }
.state h2 { margin: 0 0 8px; color: var(--lt-text); font-size: var(--kit-heading-size); font-weight: var(--lt-weight-strong) }
.state p { margin: 0 0 8px }
.state pre { margin: 8px 0 12px; padding: 10px 12px; overflow-x: auto; border: 1px solid var(--lt-line); border-radius: var(--lt-radius); background: var(--lt-surface-quiet); color: var(--lt-text); text-align: left; font-size: var(--kit-small-size) }
.state code, .view > .note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
.view > .note { margin: 0; color: var(--lt-muted); font-size: var(--kit-small-size); overflow-wrap: anywhere }
.rows { margin: 12px 0 0; padding: 0; list-style: none; border: 1px solid var(--lt-line); border-radius: var(--lt-radius-panel); background: var(--lt-surface) }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--lt-line) }
.row:first-child { border-top: 0 }
.row a { color: var(--lt-brand-ink); overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px }
.row .meta { color: var(--lt-muted); font-size: var(--kit-small-size) }
.row .lt-btn { margin-left: auto }
/* Medium widths: the row keeps one Tag (its kind) so the Summary keeps one line; the side column still lists them all. */
@media (max-width: 1080px) {
  .item-labels .lt-chip:nth-of-type(n + 2), .item-labels .more { display: none }
}
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 0 }
  .side { position: static; gap: 6px; max-height: none; padding: 12px 0 0; overflow: visible }
  .side-h, .side-tags, .side-reach { display: none }
  /* Categories become one row that scrolls sideways, so twelve long names never push the list down. */
  .side-list { flex-direction: row; gap: 4px; overflow-x: auto; scrollbar-width: none }
  .side-list .lt-list-item { flex: none; width: auto }
  .toolbar { position: static; flex-wrap: wrap; padding-top: 8px }
  .toolbar .lt-segmented { flex: 1 1 auto }
  .toolbar input[type="search"] { flex: 1 1 100%; order: 3 }
  .item { grid-template-areas: "head head" "text text" "labels meta" "full full"; gap: 4px 12px; padding: 10px 12px }
  .item-labels { justify-content: flex-start; min-width: 0 }
  .edit { grid-template-columns: minmax(0, 1fr) }
}
`

export interface PageOptions {
  mode: 'panel' | 'site'
  /** `auto` (site only): the browser language picks, at load time. */
  lang: Lang | 'auto'
  /** `data-lt-theme` on <html>. */
  scheme: 'auto' | 'light' | 'dark'
  /** Panel: the Portal draws the title bar (`theme.header: "bar"`), so the page drops its own. */
  headerBar?: boolean
  /** Panel: CSP nonce for the scripts. */
  nonce?: string
  /** Panel: the handler's basePath and per-instance token. */
  base?: string
  token?: string
  /** Site: the Portal stylesheet's text, inlined because the Portal is not there. */
  sharedCss?: string
  /** Site: the cards, from the Public Projection. */
  data?: SiteData
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** JSON inside <script type="application/json">: `<` escaped so no text can close the element. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function renderPage(o: PageOptions): string {
  const t = translator(o.lang === 'auto' ? 'en' : o.lang)
  const site = o.mode === 'site'
  const nonce = o.nonce ? ` nonce="${esc(o.nonce)}"` : ''
  const subtitle = site
    ? 'Repositories I starred on GitHub and posts I saved on X, sorted into Categories by starsieve.'
    : 'GitHub stars and X likes and bookmarks, sorted into Categories'
  const header = o.headerBar ? '' : `<header class="app-header"><div class="brand-copy"><h1 data-i18n="Stars">${esc(t('Stars'))}</h1><span class="subtitle" data-i18n="${esc(subtitle)}">${esc(t(subtitle))}</span></div></header>`
  const boot = {
    mode: o.mode,
    lang: o.lang,
    dict: o.lang === 'auto' ? {} : dictFor(o.lang),
    ...(o.lang === 'auto' ? { dicts: { zh: ZH } } : {}),
    base: o.base ?? '',
    token: o.token ?? '',
    ...(site ? { data: o.data } : {}),
  }
  const styles = site
    ? `<style>\n${(o.sharedCss ?? '').replace(/<\/style/gi, '<\\/style')}\n</style>`
    : '<link rel="stylesheet" href="/_shared/local-tools.css">'
  // In a same-origin iframe the Portal's nav script is out of reach, so the Panel loads the tooltip script itself.
  const tips = site ? '' : `<script${nonce} src="/_shared/local-tools.js"></script>`
  const htmlLang = o.lang === 'zh' ? 'zh-CN' : 'en'
  return `<!DOCTYPE html>
<html lang="${htmlLang}" data-lt-theme="${esc(o.scheme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="Stars">${esc(t('Stars'))}</title>
${styles}
<style>${PAGE_CSS}</style>
</head>
<body>
${header}
<div id="top"></div>
<main id="main"><noscript><p class="state">${esc(t('This page needs JavaScript.'))}</p></noscript></main>
<div class="lt-open-toast" id="toast" role="status" aria-live="polite" hidden></div>
<script type="application/json" id="starsieve-boot">${inlineJson(boot)}</script>
${tips}
<script type="module"${nonce}>
${CLIENT}
</script>
</body>
</html>
`
}
