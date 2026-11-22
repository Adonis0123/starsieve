// Browser code shared by the Portal Panel and the public site; page.ts inlines this file as one module script, so the
// functions tested in Node are the ones that run. Boot data comes from <script type="application/json" id="starsieve-boot">:
// { mode: "panel" | "site", lang: "en" | "zh" | "auto", dict, base, token, readOnly, data? }.
// The Panel fetches its data from `${base}/api/state` and writes through `${base}/api/override` and `/api/unskip`
// (the same core functions as `starsieve override`); the site has its data inline and never writes.
// Styling comes only from /_shared/local-tools.css classes (.lt-*) and tokens; every string is escaped before use.

export const NONE = 'starsieve:not-classified'

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** English is the key; `dict` holds the Chinese. `{name}` placeholders are filled from `vars`. */
export function makeT(dict) {
  return (s, vars) => {
    let out = (dict && dict[s]) || s
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
    return out
  }
}

/** Where an Item may link: its GitHub repository or its post on X. Anything else is shown as plain text. */
const LINK_HOSTS = new Set(['github.com', 'x.com', 'twitter.com'])

/** The Item's url when it is an https link to github.com, x.com or twitter.com; otherwise null (rendered without a link). */
export function safeUrl(url) {
  let u
  try {
    u = new URL(String(url ?? ''))
  } catch {
    return null
  }
  // `host` keeps the port, so https://github.com:8443/ is refused too.
  if (u.protocol !== 'https:' || !LINK_HOSTS.has(u.host) || u.username || u.password) return null
  return u.href
}

export function compact(n) {
  if (typeof n !== 'number') return ''
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(n)
}

/** The filters: source `all|github|x`, category (NONE = not classified), status (`review`, or absent for any), tag,
 * search text. */
export function matches(item, f) {
  if (f.source !== 'all' && item.source !== f.source) return false
  if (f.category !== null) {
    if (f.category === NONE ? item.category !== null : item.category !== f.category) return false
  }
  if (f.status === 'review' && !item.needsReview) return false
  if (f.tag !== null && !item.tags.includes(f.tag)) return false
  if (f.q) {
    const hay = [item.title, item.summary, item.description, item.category, item.text, item.language, ...item.tags]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false
  }
  return true
}

/** `recent`: newest saved first. `stars`: most stars first; Items without a star count last, newest first. */
export function sortItems(items, sort) {
  const recent = (a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.key < b.key ? -1 : 1)
  const list = [...items]
  if (sort === 'stars') {
    return list.sort((a, b) => {
      const sa = typeof a.stars === 'number' ? a.stars : -1
      const sb = typeof b.stars === 'number' ? b.stars : -1
      return sb - sa || recent(a, b)
    })
  }
  return list.sort(recent)
}

/** Category chips: the Category Table's order, then Categories only found on Items, then "not classified". */
export function categoryCounts(items, order) {
  const counts = new Map()
  for (const item of items) {
    const key = item.category === null ? NONE : item.category
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out = []
  for (const name of order) if (counts.has(name)) out.push([name, counts.get(name)])
  const extra = [...counts.keys()].filter((k) => k !== NONE && !order.includes(k)).sort()
  for (const name of extra) out.push([name, counts.get(name)])
  if (counts.has(NONE)) out.push([NONE, counts.get(NONE)])
  return out
}

/** The most used Tags, most first, then by name. */
export function tagCounts(items, limit) {
  const counts = new Map()
  for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit)
}

function signalLabel(item, t) {
  if (item.source === 'github') return 'GitHub'
  const names = (item.signals ?? []).map((s) => (s === 'like' ? t('Like') : s === 'bookmark' ? t('Bookmark') : s))
  return names.length ? `X · ${names.join(' · ')}` : 'X'
}

/** How many Tags a row shows: the first (the kind of thing) and at most two topics. The rest sit in a tooltip. */
export const ROW_TAGS = 3

// Octicons star-fill, link-external and x (MIT), drawn in currentColor so they follow the theme.
const STAR_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>'
const LINK_SVG =
  '<svg class="ext" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></svg>'
export const X_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>'

/** One compact row. `ctx`: { t, mode, editable, tag }. Only the Chinese Summary is shown; the GitHub description moves
 * into its tooltip, and stands in only while there is no Summary. */
export function cardHtml(item, ctx) {
  const { t } = ctx
  const panel = ctx.mode === 'panel'
  const badges = []
  // Most Items wait for the Classifier at first, so only Needs review is a warning.
  // The title link carries the accent; the Category stays a neutral label, and "not classified" is only outlined.
  if (item.category === null) badges.push(`<span class="lt-badge is-outline">${esc(t('Not classified'))}</span>`)
  else badges.push(`<span class="lt-badge item-cat">${esc(item.category)}</span>`)
  if (item.needsReview) {
    badges.push(`<span class="lt-badge is-warn" data-tip="${esc(t('The Classifier was not sure about this one'))}">${esc(t('Needs review'))}</span>`)
  }
  // Public is what a classified Item usually is, so only the exception is marked.
  if (panel && item.visibility === 'private' && !item.repoPrivate) {
    badges.push(`<span class="lt-badge" data-tip="${esc(t('Never published'))}">${esc(t('Private'))}</span>`)
  }
  if (panel && item.repoPrivate) {
    badges.push(`<span class="lt-badge" data-tip="${esc(t('A private repository is never published'))}">${esc(t('Private repository'))}</span>`)
  }
  if (panel && item.locked) {
    badges.push(`<span class="lt-badge is-outline" data-tip="${esc(t('Changed by hand; the Classifier never overwrites it'))}">${esc(t('Locked'))}</span>`)
  }
  if (item.archived) badges.push(`<span class="lt-badge">${esc(t('Archived'))}</span>`)

  let text
  if (item.summary) {
    const tip = item.description ? ` data-tip="${esc(item.description)}"` : ''
    text = `<p class="summary"${tip}>${esc(item.summary)}</p>`
  } else if (item.description) text = `<p class="summary is-fallback" data-tip="${esc(item.description)}">${esc(item.description)}</p>`
  else if (panel && item.text) text = `<p class="summary is-fallback">${esc(item.text)}</p>`
  else text = `<p class="summary is-fallback">${esc(item.source === 'x' && panel ? t('No post text was saved') : t('No summary yet'))}</p>`

  const meta = []
  if (item.language) meta.push(`<span>${esc(item.language)}</span>`)
  if (typeof item.stars === 'number') meta.push(`<span class="stars">${STAR_SVG}${esc(compact(item.stars))}</span>`)
  if (item.addedAt) {
    const date = item.addedAt.slice(0, 10)
    meta.push(`<time datetime="${esc(date)}" data-tip="${esc(t('Added {date}', { date }))}">${esc(date)}</time>`)
  }

  const shown = item.tags.slice(0, ROW_TAGS)
  const rest = item.tags.slice(ROW_TAGS)
  const tags =
    shown
      .map(
        (tag) =>
          `<button type="button" class="lt-chip lt-chip-sm" data-tag="${esc(tag)}" aria-pressed="${ctx.tag === tag ? 'true' : 'false'}">${esc(tag)}</button>`,
      )
      .join('') + (rest.length ? `<span class="more" data-tip="${esc(rest.join(', '))}">+${rest.length}</span>` : '')
  // Panel only: the post text saved for an X Item, folded under the row until its toggle opens it. The site never has it.
  const fullId = `full-${String(item.key).replace(/[^A-Za-z0-9_-]/g, '_')}`
  const full = panel && item.text ? `<p class="fulltext" id="${esc(fullId)}" hidden>${esc(item.text)}</p>` : ''
  const toggle = full
    ? `<button type="button" class="lt-btn-link" data-fulltext aria-expanded="false" aria-controls="${esc(fullId)}">${esc(t('Saved post text'))}</button>`
    : ''
  const href = safeUrl(item.url)
  const title = href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-open>${esc(item.title)}${LINK_SVG}<span class="sr-only">${esc(t('(opens in a new tab)'))}</span></a>`
    : `<span>${esc(item.title)}</span>`
  const edit = ctx.editable
    ? `<button type="button" class="lt-btn lt-btn-ghost lt-btn-sm" data-edit aria-label="${esc(t('Edit {name}', { name: item.title }))}">${esc(t('Edit'))}</button>`
    : ''
  return `<div class="item-head"><h3>${title}</h3><span class="src">${esc(signalLabel(item, t))}</span>${badges.join('')}</div>
<div class="item-meta">${toggle}${meta.join('<span aria-hidden="true">·</span>')}${edit}</div>
${text}
${tags ? `<div class="item-labels">${tags}</div>` : ''}
${full}`
}

/** The edit form inside a card; fields mirror `starsieve override` options. */
export function editFormHtml(item, ctx) {
  const { t } = ctx
  const cats = ctx.categories.includes(item.category ?? '') || item.category === null ? ctx.categories : [item.category, ...ctx.categories]
  const options = cats
    .map((c) => `<option value="${esc(c)}"${c === item.category ? ' selected' : ''}>${esc(c)}</option>`)
    .join('')
  const none = item.category === null ? `<option value="" selected>${esc(t('Not classified'))}</option>` : ''
  const vis = item.visibility ?? 'private'
  return `<form class="edit" data-edit-form>
<h3>${esc(item.title)}</h3>
<label>${esc(t('Category'))}<select class="lt-field" name="category">${none}${options}</select></label>
<label>${esc(t('Tags'))}<input class="lt-field" name="tags" value="${esc(item.tags.join(', '))}" placeholder="${esc(t('Comma separated, at most 6'))}" autocomplete="off"></label>
<label>${esc(t('Summary'))}<textarea class="lt-field" name="summary" rows="3" maxlength="80">${esc(item.summary)}</textarea></label>
<label>${esc(t('Visibility'))}<select class="lt-field" name="visibility"><option value="public"${vis === 'public' ? ' selected' : ''}>${esc(t('Public'))}</option><option value="private"${vis === 'private' ? ' selected' : ''}>${esc(t('Private'))}</option></select></label>
${item.repoPrivate ? `<p class="note">${esc(t('A private repository is never published'))}</p>` : ''}
<p class="note">${esc(t('Saving locks it: the Classifier never overwrites it.'))}</p>
<div class="item-actions"><button type="submit" class="lt-btn lt-btn-sm lt-btn-primary">${esc(t('Save'))}</button><button type="button" class="lt-btn lt-btn-sm" data-cancel>${esc(t('Cancel'))}</button></div>
</form>`
}

/** What the edit form changes, as `override` options; only the fields that differ. */
export function formChange(item, form) {
  const change = {}
  const category = form.category
  if (category && category !== item.category) change.category = category
  const tags = String(form.tags ?? '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (tags.join('\n') !== item.tags.join('\n')) change.tags = tags
  const summary = String(form.summary ?? '').trim()
  if (summary !== item.summary) change.summary = summary
  if (form.visibility && form.visibility !== (item.visibility ?? 'private')) change.visibility = form.visibility
  return change
}

function stateHtml(title, body, actions) {
  return `<div class="state" role="status"><h2>${esc(title)}</h2>${body}${actions ?? ''}</div>`
}

function boot() {
  const bootEl = document.getElementById('starsieve-boot')
  const cfg = JSON.parse(bootEl.textContent)
  let dict = cfg.dict
  if (cfg.lang === 'auto') {
    const zh = /^zh\b/i.test(navigator.language || '')
    dict = zh ? cfg.dicts.zh : {}
    document.documentElement.lang = zh ? 'zh-CN' : 'en'
  }
  const t = makeT(dict)
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  const panel = cfg.mode === 'panel'
  const $ = (sel) => document.querySelector(sel)
  const main = $('#main')
  const toastEl = $('#toast')
  let toastTimer = 0

  const S = { source: 'all', category: null, status: null, tag: null, q: '', sort: 'recent', view: 'items' }
  let data = null
  let editable = false
  let sortedBy = null
  const nodes = new Map()

  function toast(text, error) {
    toastEl.textContent = text
    toastEl.classList.toggle('is-error', Boolean(error))
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastEl.hidden = true), error ? 8000 : 4000)
  }

  async function post(path, body, retried) {
    const res = await fetch(`${cfg.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-starsieve-token': cfg.token },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    // The Panel was restarted since this page loaded: take its new token and try once more.
    if (res.status === 403 && json.error?.code === 'bad-token' && !retried) {
      const fresh = await fetch(`${cfg.base}/api/token`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (fresh?.token) {
        cfg.token = fresh.token
        return post(path, body, true)
      }
    }
    if (!res.ok || json.ok === false) throw new Error(json.error?.message || `HTTP ${res.status}`)
    return json
  }

  const ctx = () => ({ t, mode: cfg.mode, editable, tag: S.tag, categories: data.categories })
  const bySource = () => data.items.filter((i) => S.source === 'all' || i.source === S.source)

  function layout() {
    const tabs = panel
      ? `<nav class="lt-tabs" role="tablist" aria-label="${esc(t('Views'))}">
<a class="lt-tab" role="tab" href="#items" data-view="items">${esc(t('Items'))}</a>
<a class="lt-tab" role="tab" href="#skipped" data-view="skipped">${esc(t('Skipped'))} <span class="lt-count" id="skipped-count"></span></a>
</nav>`
      : ''
    const sources = [
      ['all', t('All')],
      ['github', 'GitHub'],
      ['x', 'X'],
    ]
      .map(([v, label]) => `<button type="button" class="lt-seg-item" data-source="${v}">${esc(label)} <span class="lt-count" data-source-count="${v}"></span></button>`)
      .join('')
    const hasStars = data.items.some((i) => typeof i.stars === 'number')
    const sort = `<select class="lt-field" id="sort" aria-label="${esc(t('Sort'))}"><option value="recent">${esc(t('Recently added'))}</option>${hasStars ? `<option value="stars">${esc(t('Most stars'))}</option>` : ''}</select>`
    $('#top').innerHTML = tabs
    main.innerHTML = `<section class="view" id="view-items">
<div class="shell">
<aside class="side" id="side" aria-label="${esc(t('Filters'))}">
<div class="side-group"><h2 class="side-h" id="cats-h">${esc(t('Category'))}</h2><div class="side-list" id="cats" role="group" aria-labelledby="cats-h"></div></div>
${panel ? `<div class="side-group" id="states-wrap"><h2 class="side-h" id="states-h">${esc(t('Status'))}</h2><div class="side-list" id="states" role="group" aria-labelledby="states-h"></div></div>` : ''}
<div class="side-group side-tags" id="tags-wrap"><h2 class="side-h" id="tags-h">${esc(t('Tags'))}</h2><div class="side-chips" id="tags" role="group" aria-labelledby="tags-h"></div></div>
${panel ? '<div class="side-group side-reach" id="reach"></div>' : ''}
</aside>
<div class="content">
<div class="toolbar">
<div class="lt-segmented" role="group" aria-label="${esc(t('Source'))}">${sources}</div>
<input class="lt-field" type="search" id="q" placeholder="${esc(t('Search names, summaries and tags (press /)'))}" aria-label="${esc(t('Search'))}" autocomplete="off">
${sort}
</div>
<div class="list-head" id="status" aria-live="polite"></div>
<div class="list" id="grid"></div>
<div id="nomatch" hidden></div>
</div>
</div>
</section>
${panel ? '<section class="view" id="view-skipped" hidden></section>' : ''}`
    const grid = $('#grid')
    nodes.clear()
    sortedBy = null
    for (const item of data.items) {
      const el = document.createElement('article')
      el.className = 'item'
      el.dataset.key = item.key
      el.innerHTML = cardHtml(item, ctx())
      nodes.set(item.key, el)
      grid.append(el)
    }
  }

  /** The side column: Categories, then the two states (Panel), the most used Tags, and the X backfill (Panel). */
  function renderFacets() {
    const base = bySource()
    const cats = categoryCounts(base, data.categories)
    const row = (attr, value, label, n, on) =>
      `<button type="button" class="lt-list-item" ${attr}="${esc(value)}" aria-pressed="${on ? 'true' : 'false'}"><span class="side-name">${esc(label)}</span><span class="lt-count">${n}</span></button>`
    const chip = (value, n, on) =>
      `<button type="button" class="lt-chip lt-chip-sm" data-tag="${esc(value)}" aria-pressed="${on ? 'true' : 'false'}">${esc(value)} <span class="lt-count">${n}</span></button>`
    const side = $('#side')
    const active = document.activeElement && side.contains(document.activeElement) ? document.activeElement : null
    const focusKey = active ? ['cat', 'status', 'tag'].find((k) => active.dataset[k] !== undefined) : undefined
    const focusVal = focusKey ? active.dataset[focusKey] : undefined

    $('#cats').innerHTML =
      row('data-cat', '', t('All categories'), base.length, S.category === null) +
      cats
        .filter(([name]) => name !== NONE)
        .map(([name, n]) => row('data-cat', name, name, n, S.category === name))
        .join('')
    const states = $('#states')
    if (states) {
      const pending = cats.find(([name]) => name === NONE)?.[1] ?? 0
      const review = base.filter((i) => i.needsReview).length
      states.innerHTML =
        (pending ? row('data-cat', NONE, t('Not classified'), pending, S.category === NONE) : '') +
        (review ? row('data-status', 'review', t('Needs review'), review, S.status === 'review') : '')
      $('#states-wrap').hidden = !pending && !review
    }
    const inCat = base.filter((i) => S.category === null || (S.category === NONE ? i.category === null : i.category === S.category))
    const tags = tagCounts(inCat, 12)
    if (S.tag !== null && !tags.some(([name]) => name === S.tag)) tags.unshift([S.tag, inCat.filter((i) => i.tags.includes(S.tag)).length])
    $('#tags').innerHTML = tags.map(([name, n]) => chip(name, n, S.tag === name)).join('')
    $('#tags-wrap').hidden = !tags.length
    if (focusKey) side.querySelector(`[data-${focusKey}="${CSS.escape(focusVal)}"]`)?.focus()

    for (const v of ['all', 'github', 'x']) {
      const n = v === 'all' ? data.items.length : data.items.filter((i) => i.source === v).length
      const el = document.querySelector(`[data-source-count="${v}"]`)
      if (el) el.textContent = String(n)
      document.querySelector(`[data-source="${v}"]`)?.setAttribute('aria-pressed', String(S.source === v))
    }
  }

  function renderStatus(shown) {
    const parts = [`<span>${esc(t('{shown} of {total} Items', { shown, total: data.items.length }))}</span>`]
    if (S.tag !== null) {
      parts.push(
        `<button type="button" class="lt-chip lt-chip-sm" data-tag="${esc(S.tag)}" aria-pressed="true" aria-label="${esc(t('Remove Tag filter {name}', { name: S.tag }))}">${esc(S.tag)}${X_SVG}</button>`,
      )
    }
    if (S.source !== 'all' || S.category !== null || S.status !== null || S.tag !== null || S.q !== '') {
      parts.push(`<button type="button" class="lt-btn-link" data-clear>${esc(t('Clear filters'))}</button>`)
    }
    $('#status').innerHTML = parts.join('')
    const reach = $('#reach')
    if (reach) {
      const lines = (data.reach ?? []).map((r) => {
        const list = r.signal === 'like' ? t('Likes') : t('Bookmarks')
        const text = r.earliestPostedAt
          ? t('{list} backfill: {seen} read, back to {date}', { list, seen: r.seen, date: r.earliestPostedAt.slice(0, 10) })
          : t('{list} backfill: {seen} read', { list, seen: r.seen })
        const end = r.reachedEnd ? t('reached the end') : r.finished ? t('stopped before the end') : t('interrupted')
        return `<p data-tip="${esc(t('X lists are not ordered by post time, so completeness stays unknown'))}">${esc(text)} <span class="lt-badge ${r.reachedEnd ? 'is-ok' : 'is-warn'}">${esc(end)}</span></p>`
      })
      reach.innerHTML = lines.join('')
      reach.hidden = !lines.length
    }
  }

  function apply() {
    const visible = []
    for (const item of data.items) {
      const on = matches(item, S)
      nodes.get(item.key).hidden = !on
      if (on) visible.push(item)
    }
    const grid = $('#grid')
    if (sortedBy !== S.sort) {
      // Move the existing cards rather than rebuilding them, so focus and an open edit form survive.
      for (const item of sortItems(data.items, S.sort)) {
        const el = nodes.get(item.key)
        if (grid.moveBefore) grid.moveBefore(el, null)
        else grid.append(el)
      }
      sortedBy = S.sort
    }
    for (const b of grid.querySelectorAll('[data-tag]')) b.setAttribute('aria-pressed', String(b.dataset.tag === S.tag))
    // One Category chosen: every row would repeat its name, so the rows drop that badge.
    grid.toggleAttribute('data-one-category', S.category !== null && S.category !== NONE)
    grid.hidden = visible.length === 0
    renderFacets()
    renderStatus(visible.length)
    const nomatch = $('#nomatch')
    const filtered = S.source !== 'all' || S.category !== null || S.status !== null || S.tag !== null || S.q !== ''
    nomatch.hidden = visible.length > 0
    nomatch.innerHTML =
      visible.length > 0
        ? ''
        : stateHtml(
            t('No Items match'),
            `<p>${esc(t('Try another word, or clear the filters.'))}</p>`,
            filtered ? `<button type="button" class="lt-btn" data-clear>${esc(t('Clear filters'))}</button>` : '',
          )
  }

  function renderSkipped() {
    const el = $('#view-skipped')
    if (!el) return
    $('#skipped-count').textContent = String(data.skipped.length)
    if (!data.skipped.length) {
      el.innerHTML = stateHtml(t('No Skipped Items'), `<p>${esc(t('Posts the Classifier judges not technical are listed here by id.'))}</p>`)
      return
    }
    const rows = data.skipped
      .map(
        (s) => `<li class="row" data-skipped="${esc(s.id)}">
${safeUrl(s.url) ? `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.id)}</a>` : `<span>${esc(s.id)}</span>`}
<span class="meta">${esc(t('Skipped {date}', { date: s.skippedAt.slice(0, 10) }))}</span>
${editable ? `<button type="button" class="lt-btn lt-btn-sm" data-unskip="${esc(s.id)}" data-tip="${esc(t('The next X collection stores it again as pending'))}">${esc(t('Unskip'))}</button>` : ''}
</li>`,
      )
      .join('')
    el.innerHTML = `<p class="note">${esc(t('Only the id of a Skipped Item is kept, so it is never judged, shown or published. Unskip brings it back with the next X collection.'))}</p><ul class="rows">${rows}</ul>`
  }

  function showView() {
    const view = panel && location.hash === '#skipped' ? 'skipped' : 'items'
    S.view = view
    for (const a of document.querySelectorAll('[data-view]')) {
      const on = a.dataset.view === view
      a.setAttribute('aria-selected', String(on))
      if (on) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
    $('#view-items').hidden = view !== 'items'
    const sk = $('#view-skipped')
    if (sk) sk.hidden = view !== 'skipped'
  }

  function render() {
    layout()
    renderSkipped()
    showView()
    apply()
  }

  function emptyStore() {
    main.innerHTML = panel
      ? stateHtml(
          t('Nothing collected yet'),
          `<p>${esc(t('Collect your GitHub stars, then sort them:'))}</p><pre><code>pnpm starsieve collect github --store ${esc(cfg.storePath ?? '<store>')}
pnpm starsieve categories init --store ${esc(cfg.storePath ?? '<store>')}
pnpm starsieve classify --store ${esc(cfg.storePath ?? '<store>')}</code></pre>`,
        )
      : stateHtml(t('Nothing public yet'), `<p>${esc(t('Items appear here once they are classified as public.'))}</p>`)
  }

  async function load() {
    $('#top').innerHTML = ''
    if (!panel) {
      data = cfg.data
      if (!data.items.length) return emptyStore()
      return render()
    }
    main.innerHTML = stateHtml(t('Loading…'), `<p>${esc(t('Reading the store.'))}</p>`)
    let state
    try {
      const res = await fetch(`${cfg.base}/api/state`, { headers: { accept: 'application/json' } })
      state = await res.json()
      if (!res.ok && !state.status) throw new Error(state.error?.message || `HTTP ${res.status}`)
    } catch (e) {
      main.innerHTML = stateHtml(
        t('Could not load Stars'),
        `<p>${esc(String(e.message || e))}</p><p>${esc(t('Check that the Portal is running, then retry.'))}</p>`,
        `<button type="button" class="lt-btn lt-btn-primary" data-retry>${esc(t('Retry'))}</button>`,
      )
      return
    }
    cfg.storePath = state.storePath
    editable = !state.readOnly
    if (state.status === 'unconfigured') {
      main.innerHTML = stateHtml(
        t('No store set up'),
        `<p>${esc(t('Tell the Panel where your Private Store is, in {path}:', { path: state.configPath }))}</p><pre><code>${esc('{ "storePath": "~/path/to/stars-private" }')}</code></pre><p>${esc(t('Then reload this page.'))}</p>`,
        `<button type="button" class="lt-btn" data-retry>${esc(t('Reload'))}</button>`,
      )
      return
    }
    if (state.status === 'error') {
      main.innerHTML = stateHtml(
        t('Could not read the store'),
        `<p>${esc(state.error?.message ?? '')}</p>${state.next ? `<p>${esc(t('Next step:'))} <code>${esc(state.next)}</code></p>` : ''}`,
        `<button type="button" class="lt-btn lt-btn-primary" data-retry>${esc(t('Retry'))}</button>`,
      )
      return
    }
    data = state.data
    if (!data.items.length && !data.skipped.length) return emptyStore()
    render()
  }

  function rerenderCard(key) {
    const item = data.items.find((i) => i.key === key)
    const el = nodes.get(key)
    if (item && el) el.innerHTML = cardHtml(item, ctx())
  }

  document.addEventListener('click', async (e) => {
    const target = e.target.closest('button, a[data-view]')
    if (!target) {
      // A click anywhere else on a row opens it like its title link; links, buttons, the post text and the edit form
      // keep their own clicks, and selecting text does not open anything.
      const row = e.target.closest('.item')
      if (!row || e.target.closest('a, .fulltext, form, input, select, textarea, label')) return
      if (String(window.getSelection?.() ?? '')) return
      row.querySelector('a[data-open]')?.click()
      return
    }
    if (target.dataset.retry !== undefined) return load()
    if (target.dataset.clear !== undefined) {
      Object.assign(S, { source: 'all', category: null, status: null, tag: null, q: '' })
      $('#q').value = ''
      return apply()
    }
    if (target.dataset.source) {
      S.source = target.dataset.source
      S.category = null
      S.status = null
      S.tag = null
      return apply()
    }
    if (target.dataset.cat !== undefined) {
      S.category = target.dataset.cat === '' ? null : target.dataset.cat
      // Not classified and Needs review never overlap: an Item waiting for review already has a Category.
      if (S.category === NONE) S.status = null
      S.tag = null
      return apply()
    }
    if (target.dataset.status !== undefined) {
      S.status = S.status === target.dataset.status ? null : target.dataset.status
      if (S.category === NONE) S.category = null
      return apply()
    }
    if (target.dataset.tag !== undefined) {
      S.tag = S.tag === target.dataset.tag ? null : target.dataset.tag
      return apply()
    }
    if (target.dataset.fulltext !== undefined) {
      const open = target.getAttribute('aria-expanded') !== 'true'
      target.setAttribute('aria-expanded', String(open))
      const p = document.getElementById(target.getAttribute('aria-controls'))
      if (p) p.hidden = !open
      return
    }
    if (target.dataset.edit !== undefined) {
      const el = target.closest('[data-key]')
      const item = data.items.find((i) => i.key === el.dataset.key)
      el.innerHTML = editFormHtml(item, ctx())
      el.querySelector('select, input, textarea')?.focus()
      return
    }
    if (target.dataset.cancel !== undefined) {
      const key = target.closest('[data-key]').dataset.key
      rerenderCard(key)
      nodes.get(key).querySelector('[data-edit]')?.focus()
      return
    }
    if (target.dataset.unskip) {
      const id = target.dataset.unskip
      target.disabled = true
      try {
        await post('/api/unskip', { id })
        data.skipped = data.skipped.filter((s) => s.id !== id)
        renderSkipped()
        toast(t('{id} is no longer skipped. The next X collection stores it as pending.', { id }))
      } catch (err) {
        target.disabled = false
        toast(t('Could not unskip: {message}', { message: err.message }), true)
      }
    }
  })

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-edit-form]')
    if (!form) return
    e.preventDefault()
    const el = form.closest('[data-key]')
    const item = data.items.find((i) => i.key === el.dataset.key)
    const values = Object.fromEntries(new FormData(form))
    const change = formChange(item, values)
    if (!Object.keys(change).length) {
      rerenderCard(item.key)
      return
    }
    for (const b of form.querySelectorAll('button')) b.disabled = true
    try {
      const r = await post('/api/override', { id: item.key, ...change })
      const c = r.classification
      Object.assign(item, {
        category: c.category,
        tags: c.tags,
        summary: c.summary,
        visibility: c.visibility,
        needsReview: c.needsReview,
        locked: c.locked,
      })
      rerenderCard(item.key)
      apply()
      toast(t('Saved and Locked: {name}', { name: item.title }))
    } catch (err) {
      for (const b of form.querySelectorAll('button')) b.disabled = false
      toast(t('Could not save: {message}', { message: err.message }), true)
    }
  })

  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      S.q = e.target.value.trim()
      apply()
    }
  })
  document.addEventListener('change', (e) => {
    if (e.target.id === 'sort') {
      S.sort = e.target.value
      apply()
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const q = $('#q')
    if (q) {
      e.preventDefault()
      q.focus()
    }
  })
  window.addEventListener('hashchange', () => {
    if (data) showView()
  })

  load()
}

if (typeof document !== 'undefined') boot()
