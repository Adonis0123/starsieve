// site build: index.html carries only the Public Projection.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { overrideItem } from '../core/override.ts'
import { saveSkipped } from '../core/store.ts'
import { seedMixedStore, star, withDir, xRaw } from '../testing/fixtures.ts'
import { buildSite } from './build.ts'

const CSS = ':root { --kit-bg: var(--x); }\n.lt-btn { min-height: 32px }\n'

describe('site build', () => {
  it('writes one index.html with public Items only: no private Item, private repository, Skipped id or X text', async () => {
    await withDir(async (dir) => {
      const store = await seedMixedStore(
        dir,
        [star('acme/open-thing'), star('acme/rex-private-repo', { private: true }), star('acme/kept-private')],
        [xRaw('21', { text: 'SECRET POST TEXT one' }), xRaw('22', { text: 'SECRET POST TEXT two', author: 'someone' })],
      )
      await overrideItem(store, 'github:acme/open-thing', { category: '库与框架', visibility: 'public', summary: 'An open library' })
      // An owner override cannot make a private repository's star public.
      await overrideItem(store, 'github:acme/rex-private-repo', { category: '库与框架', visibility: 'public' })
      await overrideItem(store, 'github:acme/kept-private', { category: '库与框架', visibility: 'private' })
      await overrideItem(store, 'x:21', { category: '教程与观点', visibility: 'public', summary: 'A thread on agents' })
      await saveSkipped(store, { 'x:777000111': { skippedAt: '2026-11-19T00:00:00.000Z' } })
      const css = join(dir, 'local-tools.css')
      await writeFile(css, CSS)

      const out = join(dir, 'site')
      const r = await buildSite(store, out, { css })
      assert.equal(r.publicItems, 2)
      const html = await readFile(join(out, 'index.html'), 'utf8')
      for (const present of ['acme/open-thing', 'An open library', 'https://x.com/dev/status/21', 'A thread on agents', '--kit-bg']) {
        assert.ok(html.includes(present), present)
      }
      for (const absent of ['rex-private-repo', 'kept-private', 'SECRET POST TEXT', 'x:777000111', '777000111', 'someone', 'x:22']) {
        assert.ok(!html.includes(absent), absent)
      }
      // Star counts and Needs Review reach the site, so it can sort by stars and mark what waits for review.
      assert.match(html, /"stars":10/)
      assert.match(html, /"needsReview":false/)
      // No edit API in the site, and the same store gives the same file.
      assert.ok(!html.includes('"mode":"panel"'))
      await buildSite(store, out, { css })
      assert.equal(await readFile(join(out, 'index.html'), 'utf8'), html)
    })
  })

  it('names the next step when no stylesheet is given', async () => {
    await withDir(async (dir) => {
      const store = await seedMixedStore(dir, [star('acme/a')], [])
      await assert.rejects(buildSite(store, join(dir, 'site'), { configPath: join(dir, 'none.json') }), /--css/)
    })
  })
})
