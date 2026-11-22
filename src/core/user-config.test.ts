// The user config: the README's title and site link are checked before they reach the public README.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withDir } from '../testing/fixtures.ts'
import { loadUserConfig } from './user-config.ts'

describe('user config', () => {
  it('reads readme.title and siteUrl, and rejects a multi-line title or a URL that would break a Markdown link', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'config.json')
      const load = async (doc: unknown) => {
        await writeFile(path, JSON.stringify(doc))
        return loadUserConfig(path)
      }
      assert.deepEqual(await load({ readme: { title: ' 我的收藏 ' }, siteUrl: 'https://o.github.io/stars/' }), {
        readme: { title: '我的收藏' },
        siteUrl: 'https://o.github.io/stars/',
      })
      for (const bad of [{ readme: 'x' }, { readme: { title: '' } }, { readme: { title: 'a\nb' } }]) {
        await assert.rejects(load(bad), /readme/)
      }
      for (const bad of ['ftp://o.io/', 'https://o.io/a b', 'https://o.io/(x)', 'o.github.io/stars', 42]) {
        await assert.rejects(load({ siteUrl: bad }), /siteUrl/)
      }
    })
  })
})
