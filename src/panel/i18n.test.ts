// Every page string has Chinese, and no Chinese entry is left over; client.js filters and sorts like the page shows.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
// @ts-expect-error client.js is the Panel's plain browser script and ships no type declarations
import { cardHtml, categoryCounts, formChange, makeT, matches, NONE, safeUrl, sortItems } from './client.js'
import { ZH } from './i18n.ts'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('i18n', () => {
  it('has a Chinese entry for every t() string in client.js, and every entry is used', () => {
    const client = read('./client.js')
    const page = read('./page.ts')
    const used = new Set([...client.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!))
    const missing = [...used].filter((s) => !(s in ZH))
    assert.deepEqual(missing, [], 'add these to ZH in src/panel/i18n.ts')
    const unused = Object.keys(ZH).filter((k) => !used.has(k) && !page.includes(`'${k}'`))
    assert.deepEqual(unused, [], 'remove these from ZH in src/panel/i18n.ts, or use them')
  })
})

describe('client filters', () => {
  const item = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    source: 'github',
    title: key,
    summary: '',
    description: null,
    category: 'A',
    tags: [] as string[],
    language: null,
    addedAt: '2026-01-01',
    ...over,
  })

  it('filters by source, category (including not classified), tag and words', () => {
    const items = [item('a', { tags: ['rust'] }), item('b', { source: 'x', category: null, summary: 'Agent skill notes' })]
    const f = { source: 'all', category: null, tag: null, q: '' }
    assert.deepEqual(items.filter((i) => matches(i, { ...f, source: 'x' })).map((i) => i.key), ['b'])
    assert.deepEqual(items.filter((i) => matches(i, { ...f, category: NONE })).map((i) => i.key), ['b'])
    assert.deepEqual(items.filter((i) => matches(i, { ...f, tag: 'rust' })).map((i) => i.key), ['a'])
    assert.deepEqual(items.filter((i) => matches(i, { ...f, q: 'skill agent' })).map((i) => i.key), ['b'])
  })

  it('sorts by recently added or by stars, and lists Categories in table order', () => {
    const items = [item('old', { stars: 900, addedAt: '2025-01-01' }), item('new', { stars: 5, addedAt: '2026-05-01' }), item('x', { addedAt: '2026-06-01' })]
    assert.deepEqual(sortItems(items, 'recent').map((i: { key: string }) => i.key), ['x', 'new', 'old'])
    assert.deepEqual(sortItems(items, 'stars').map((i: { key: string }) => i.key), ['old', 'new', 'x'])
    const cats = categoryCounts([item('1', { category: 'B' }), item('2', { category: 'A' }), item('3', { category: null }), item('4', { category: 'Z' })], ['A', 'B'])
    assert.deepEqual(cats, [['A', 1], ['B', 1], ['Z', 1], [NONE, 1]])
  })

  it('filters to Items that need review only when asked', () => {
    const items = [item('a', { needsReview: true }), item('b', { needsReview: false })]
    const f = { source: 'all', category: null, tag: null, q: '' }
    assert.deepEqual(items.filter((i) => matches(i, f)).map((i) => i.key), ['a', 'b'])
    assert.deepEqual(items.filter((i) => matches(i, { ...f, status: 'review' })).map((i) => i.key), ['a'])
  })

  it('links a row only to its GitHub repository or X post; any other url is plain text', () => {
    assert.equal(safeUrl('https://github.com/acme/alpha'), 'https://github.com/acme/alpha')
    assert.equal(safeUrl('https://x.com/dev/status/21'), 'https://x.com/dev/status/21')
    assert.equal(safeUrl('https://twitter.com/dev/status/21'), 'https://twitter.com/dev/status/21')
    for (const bad of ['http://github.com/a/b', 'https://github.com.evil.dev/a', 'https://evil.dev/?u=https://github.com/', 'javascript:alert(1)', 'https://user@github.com/a', 'https://github.com:8443/a/b', '', null]) {
      assert.equal(safeUrl(bad), null, String(bad))
    }
    const ctx = { t: makeT({}), mode: 'site', editable: false, tag: null }
    const linked = cardHtml(item('acme/alpha', { url: 'https://github.com/acme/alpha' }), ctx)
    assert.match(linked, /<a href="https:\/\/github\.com\/acme\/alpha" target="_blank" rel="noopener noreferrer"/)
    const plain = cardHtml(item('acme/beta', { url: 'https://evil.dev/acme/beta' }), ctx)
    assert.ok(!plain.includes('<a '), plain)
    assert.ok(!plain.includes('evil.dev'), plain)
  })

  it('shows the saved X post text in the Panel only, and at most three Tags per row', () => {
    const post = item('@dev', { source: 'x', url: 'https://x.com/dev/status/1', text: 'the full post', tags: ['a', 'b', 'c', 'd', 'e'] })
    const panel = cardHtml(post, { t: makeT({}), mode: 'panel', editable: true, tag: null })
    const site = cardHtml(post, { t: makeT({}), mode: 'site', editable: false, tag: null })
    assert.match(panel, /<p class="fulltext" id="full-_dev" hidden>the full post<\/p>/)
    assert.ok(!site.includes('the full post'))
    assert.equal((site.match(/data-tag=/g) ?? []).length, 3)
    assert.match(site, /data-tip="d, e">\+2</)
    assert.ok(!site.includes('data-edit'))
  })

  it('sends only the fields the edit form changed', () => {
    const it0 = item('a', { tags: ['rust', 'cli'], summary: 'S', visibility: 'private' })
    assert.deepEqual(formChange(it0, { category: 'A', tags: 'rust, cli', summary: 'S', visibility: 'private' }), {})
    assert.deepEqual(formChange(it0, { category: 'B', tags: 'rust，web', summary: ' T ', visibility: 'public' }), {
      category: 'B',
      tags: ['rust', 'web'],
      summary: 'T',
      visibility: 'public',
    })
  })
})
