// publish: the deterministic filter. Private repositories and private Items never reach items.json or the READMEs.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyBatch } from '../core/apply.ts'
import { buildBatch } from '../core/batch.ts'
import { overrideItem } from '../core/override.ts'
import { loadCategories, loadItems, saveCategoriesTable } from '../core/store.ts'
import { seedMixedStore, seedStore, snapshot, star, withDir, xRaw } from '../testing/fixtures.ts'
import { buildProjection, check, contentHash, holdSources, type PublicDoc, type PublicGithubItem, type PublicXItem, publish, renderReadme } from './projection.ts'
import { collectGithub } from '../collect/github.ts'

const PUB = 'github:acme/open'
const PRIV_REPO = 'github:corp/secret-repo'
const PRIV_ITEM = 'github:acme/personal'
const UNCLASSIFIED = 'github:acme/later'

async function setup(dir: string) {
  const store = await seedStore(dir, [
    star('acme/open', { starred_at: '2026-11-01T00:00:00Z' }),
    star('acme/older', { starred_at: '2026-10-01T00:00:00Z' }),
    star('corp/secret-repo', { private: true }),
    star('acme/personal'),
    star('acme/later'),
  ])
  const batch = buildBatch(await loadItems(store), {}, 25)
  const entry = (id: string, visibility: string) => ({
    id,
    category: 'CLI 与开发工具',
    tags: ['t'],
    summary: `${id} 摘要`,
    visibility,
  })
  await applyBatch(store, {
    schemaVersion: 1,
    batchId: batch.batchId,
    items: batch.items,
    classifications: [
      entry(PUB, 'public'),
      entry('github:acme/older', 'public'),
      entry(PRIV_REPO, 'public'),
      entry(PRIV_ITEM, 'private'),
    ],
  })
  return { store, out: join(dir, 'out') }
}

describe('publish', () => {
  it('includes only public Items of public repositories that have a Classification', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const r = await publish(store, out, false)
      assert.equal(r.publicItems, 2)
      const items = await readFile(join(out, 'items.json'), 'utf8')
      const readme = await readFile(join(out, 'README.md'), 'utf8')
      const doc = JSON.parse(items) as { schemaVersion: number; items: { id: string }[] }
      assert.equal(doc.schemaVersion, 1)
      assert.deepEqual(
        doc.items.map((i) => i.id),
        [PUB, 'github:acme/older'],
      )
      for (const text of [items, readme]) {
        assert.ok(!text.includes('secret-repo'), 'private repository leaked')
        assert.ok(!text.includes('acme/personal'), 'private Item leaked')
        assert.ok(!text.includes('acme/later'), 'unclassified Item leaked')
      }
      assert.match(readme, /## CLI 与开发工具\n\n- \[acme\/open\]\(https:\/\/github.com\/acme\/open\) — /)
    })
  })

  it('keeps a private repository out even after the owner overrides it to public', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await overrideItem(store, PRIV_REPO, { visibility: 'public' })
      await publish(store, out, false)
      const items = await readFile(join(out, 'items.json'), 'utf8')
      const readme = await readFile(join(out, 'README.md'), 'utf8')
      assert.ok(!items.includes('secret-repo') && !readme.includes('secret-repo'))
    })
  })

  it('publishes nothing from the store beyond the allowlisted fields', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await publish(store, out, false)
      const doc = JSON.parse(await readFile(join(out, 'items.json'), 'utf8')) as { items: object[] }
      assert.deepEqual(Object.keys(doc.items[0]!).sort(), [
        'addedAt',
        'archived',
        'category',
        'description',
        'id',
        'language',
        'name',
        'needsReview',
        'stargazers',
        'starredAt',
        'summary',
        'tags',
        'topics',
        'url',
      ])
    })
  })

  it('--dry-run writes nothing and reports the difference; after publishing it reports none', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const storeBefore = await snapshot(store)
      const dry = await publish(store, out, true)
      assert.deepEqual(dry.added, [PUB, 'github:acme/older'])
      assert.equal(dry.identical, false)
      assert.deepEqual(await snapshot(store), storeBefore)
      await assert.rejects(readFile(join(out, 'items.json')), { code: 'ENOENT' })

      await publish(store, out, false)
      const again = await publish(store, out, true)
      assert.equal(again.identical, true)
      assert.deepEqual([again.added, again.removed, again.changed], [[], [], []])
    })
  })

  it('reports changed Items in a dry run after an override', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await publish(store, out, false)
      await overrideItem(store, PUB, { category: '应用' })
      await overrideItem(store, 'github:acme/older', { visibility: 'private' })
      const dry = await publish(store, out, true)
      assert.deepEqual([dry.changed, dry.removed], [[PUB], ['github:acme/older']])
    })
  })
})

describe('publish: star counts, Needs Review, addedAt', () => {
  it('carries stargazers, needsReview and addedAt; star counts alone are not something new to publish', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await overrideItem(store, 'github:acme/older', { visibility: 'public' })
      const doc = await buildProjection(store)
      const open = doc.items.find((i) => 'id' in i && i.id === PUB) as unknown as Record<string, unknown>
      assert.deepEqual([open.stargazers, open.needsReview, open.addedAt], [10, false, '2026-11-01T00:00:00Z'])
      await publish(store, out, false)
      assert.equal((await check(store)).pendingPublish, false)
      // Star counts move: the file would change, but there is nothing new.
      await collectGithub(store, async () => [star('acme/open', { starred_at: '2026-11-01T00:00:00Z', stargazers_count: 5000 })])
      const moved = await buildProjection(store)
      assert.notDeepEqual(moved, doc)
      assert.equal(contentHash(moved), contentHash(doc))
      assert.equal((await check(store)).pendingPublish, false)
      const dry = await publish(store, out, true)
      assert.deepEqual([dry.identical, dry.readmeChanged, dry.contentChanged], [false, false, false])
      for (const lang of ['en', 'zh'] as const) assert.equal(renderReadme(moved, lang), renderReadme(doc, lang))
    })
  })

  it('holdSources keeps a held Source as it was and takes the rest fresh', async () => {
    await withDir(async (dir) => {
      const { store } = await setup(dir)
      const before = await buildProjection(store)
      await overrideItem(store, PUB, { summary: 'new summary' })
      const now = await buildProjection(store)
      const held = holdSources(now, before, ['github'], [])
      assert.ok(!JSON.stringify(held).includes('new summary'))
      assert.ok(JSON.stringify(holdSources(now, before, ['x'], [])).includes('new summary'))
    })
  })

  it('holdSources drops a held Item the store no longer has as public: made private, gone, or never public now', async () => {
    await withDir(async (dir) => {
      const { store } = await setup(dir)
      const before = await buildProjection(store)
      // The public file also lists an Item the store does not have, and one of a private repository (an older bug).
      const stale = { ...before.items[0]!, id: 'github:acme/deleted', url: 'https://github.com/acme/deleted' }
      const leaked = { ...before.items[0]!, id: PRIV_REPO, url: 'https://github.com/corp/secret-repo' }
      const xPost = { url: 'https://x.com/dev/status/9', author: 'dev', postedAt: null, addedAt: '2026-11-01T00:00:00Z', category: 'CLI 与开发工具', tags: [], summary: 'skipped since', needsReview: false }
      const previous = { ...before, items: [...before.items, stale, leaked, xPost] }
      // The owner takes one back while GitHub collection is failing.
      await overrideItem(store, PUB, { visibility: 'private', summary: 'changed while held' })
      const now = await buildProjection(store)
      const held = holdSources(now, previous, ['github', 'x'], [])
      const keys = held.items.map((i) => ('id' in i ? i.id : i.url))
      assert.deepEqual(keys, ['github:acme/older'])
      assert.ok(!JSON.stringify(held).includes('changed while held'))
    })
  })
})

describe('check', () => {
  it('reports pending Classification and an unpublished Public Projection', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const before = await check(store)
      assert.equal(before.pendingClassification, 1)
      assert.equal(before.pendingPublish, true)
      assert.equal(before.hasWork, true)
      await publish(store, out, false)
      const after = await check(store)
      assert.equal(after.pendingPublish, false)
      assert.equal(after.publicItems, 2)
      assert.equal(after.classified, 4)
      assert.equal(after.hasWork, true)
      await overrideItem(store, UNCLASSIFIED, {})
      assert.equal((await check(store)).hasWork, false)
    })
  })
})

describe('publish X Items', () => {
  it('publishes only url, author, postedAt, addedAt, category, tags, summary and needsReview; never text or Skipped Items', async () => {
    await withDir(async (dir) => {
      const store = await seedMixedStore(dir, [star('acme/open')], [
        xRaw('111', { author: 'alice', text: 'SECRET-TEXT about Rust' }),
        xRaw('222', { text: 'NONTECH cats' }),
        xRaw('333', { text: '' }),
      ])
      const batch = buildBatch(await loadItems(store), {}, 25, 'x')
      const keep = (id: string) => ({ id, keep: true, category: '教程与观点', tags: ['rust'], summary: `${id} 摘要`, visibility: 'public' })
      await applyBatch(store, {
        schemaVersion: 1,
        batchId: batch.batchId,
        items: batch.items,
        classifications: [keep('x:111'), { id: 'x:222', keep: false }, keep('x:333')],
      })
      const out = join(dir, 'out')
      const r = await publish(store, out, false)
      assert.deepEqual(r.added, ['https://x.com/alice/status/111'])
      const items = await readFile(join(out, 'items.json'), 'utf8')
      const readme = await readFile(join(out, 'README.md'), 'utf8')
      const doc = JSON.parse(items) as { items: Record<string, unknown>[] }
      assert.deepEqual(doc.items, [
        {
          addedAt: '2026-11-20T00:00:00.000Z',
          author: 'alice',
          category: '教程与观点',
          needsReview: false,
          postedAt: '2026-11-10T00:00:00.000Z',
          summary: 'x:111 摘要',
          tags: ['rust'],
          url: 'https://x.com/alice/status/111',
        },
      ])
      for (const text of [items, readme]) {
        assert.ok(!text.includes('SECRET-TEXT'), 'post text published')
        assert.ok(!text.includes('222'), 'Skipped Item published')
        // No text: forced private by apply.
        assert.ok(!text.includes('333'), 'post with no text published')
      }
      assert.match(readme, /- X · \[@alice\]\(https:\/\/x.com\/alice\/status\/111\) — x:111 摘要<br><sub>rust<\/sub>/)
      const k = await check(store)
      assert.deepEqual([k.bySource.x, k.skippedItems, k.pendingPublish], [{ items: 2, pendingClassification: 0 }, 1, false])
    })
  })
})

describe('README', () => {
  const repo = (name: string, over: Partial<PublicGithubItem> = {}): PublicGithubItem => ({
    id: `github:${name}`,
    url: `https://github.com/${name}`,
    name,
    description: null,
    language: null,
    topics: [],
    archived: false,
    stargazers: 10,
    starredAt: '2026-11-01T00:00:00Z',
    addedAt: '2026-11-01T00:00:00Z',
    category: 'AI 编程 Agent',
    tags: [],
    summary: '',
    needsReview: false,
    ...over,
  })
  const post = (author: string, over: Partial<PublicXItem> = {}): PublicXItem => ({
    url: `https://x.com/${author}/status/1`,
    author,
    postedAt: null,
    addedAt: '2026-11-01T00:00:00Z',
    category: 'AI 编程 Agent',
    tags: [],
    summary: '',
    needsReview: false,
    ...over,
  })
  const doc = (...items: PublicDoc['items']): PublicDoc => ({ schemaVersion: 1, items })

  it('says there is nothing yet for an empty set, without a contents list', () => {
    assert.equal(
      renderReadme(doc(), 'zh'),
      `# 技术收藏

[English](README.md) | 简体中文

还没有公开的条目。

---

数据：[items.json](items.json)

分类与摘要由 AI 辅助整理。

由 [starsieve](https://github.com/Adonis0123/starsieve) 自动生成，请勿手改。
`,
    )
  })

  it('lists one Source with the site link, the language once and at most 3 Tags, the first Tag kept', () => {
    const readme = renderReadme(
      doc(
        repo('acme/one', { summary: '一个 CLI', language: 'Rust', tags: ['工具', 'cli', 'rust', 'tui', 'git'] }),
        repo('acme/two', { language: 'Go', tags: ['go', 'cli'] }),
        repo('acme/three', { category: '资料合集', summary: '笔记' }),
      ),
      'zh',
      { title: 'Adonis 的技术收藏', siteUrl: 'https://example.github.io/stars/', dataPath: 'data/items.json', categoryLabels: { 资料合集: 'Collections' } },
    )
    assert.equal(
      readme,
      `# Adonis 的技术收藏

[English](README.md) | 简体中文

收录 3 个 GitHub 仓库，分为 2 个分类。

**[打开在线目录 →](https://example.github.io/stars/)** 可搜索、筛选，按 star 数排序。

## 目录

- [AI 编程 Agent](#ai-编程-agent)（2）
- [资料合集](#资料合集)（1）

## AI 编程 Agent

- [acme/one](https://github.com/acme/one) — 一个 CLI<br><sub>Rust · 工具 · cli · tui</sub>
- [acme/two](https://github.com/acme/two)<br><sub>go · cli</sub>

[↑ 回到目录](#目录)

## 资料合集

- [acme/three](https://github.com/acme/three) — 笔记

[↑ 回到目录](#目录)

---

数据：[data/items.json](data/items.json)

分类与摘要由 AI 辅助整理，待确认状态见[在线目录](https://example.github.io/stars/)。

由 [starsieve](https://github.com/Adonis0123/starsieve) 自动生成，请勿手改。
`,
    )
  })

  it('marks X posts, escapes Markdown in shown text and gives repeated headings distinct anchors', () => {
    const readme = renderReadme(
      doc(
        post('dev_1', { category: '目录', summary: 'a *b* [c] <d> |e| #f', tags: ['教程', 'a`b'] }),
        repo('acme/x_y', { category: 'A b' }),
        repo('acme/z', { category: 'a-b' }),
      ),
      'zh',
      { title: '目录' },
    )
    assert.equal(
      readme,
      `# 目录

[English](README.md) | 简体中文

收录 2 个 GitHub 仓库和 1 条 X 帖子，分为 3 个分类。

## 目录

- [目录](#目录-2)（1）
- [A b](#a-b)（1）
- [a-b](#a-b-1)（1）

## 目录

- X · [@dev\\_1](https://x.com/dev_1/status/1) — a \\*b\\* \\[c\\] \\<d\\> \\|e\\| \\#f<br><sub>教程 · a\\\`b</sub>

[↑ 回到目录](#目录-1)

## A b

- [acme/x\\_y](https://github.com/acme/x_y)

[↑ 回到目录](#目录-1)

## a-b

- [acme/z](https://github.com/acme/z)

[↑ 回到目录](#目录-1)

---

数据：[items.json](items.json)

分类与摘要由 AI 辅助整理。

由 [starsieve](https://github.com/Adonis0123/starsieve) 自动生成，请勿手改。
`,
    )
  })

  it('in English, says there is nothing yet and links the Chinese README', () => {
    assert.equal(
      renderReadme(doc(), 'en'),
      `# Tech collection

English | [简体中文](README.zh-CN.md)

Nothing published yet.

---

Data: [items.json](items.json)

Categories and Summaries are sorted out with AI help.

Generated by [starsieve](https://github.com/Adonis0123/starsieve); do not edit by hand.
`,
    )
  })

  it('in English, shows Categories by their English names (the Chinese name without one, Uncategorized for 未分类) and Summaries and Tags as they are', () => {
    const readme = renderReadme(
      doc(
        repo('acme/one', { summary: '一个 CLI', language: 'Rust', tags: ['工具', 'cli'] }),
        repo('acme/two', { category: '模型与评测' }),
        post('dev', { category: '未分类', summary: '一条帖子。', tags: ['教程'] }),
      ),
      'en',
      {
        title: 'My stars',
        siteUrl: 'https://example.github.io/stars/',
        dataPath: 'data/items.json',
        categoryLabels: { 'AI 编程 Agent': 'AI coding agents', 其他: 'Other' },
      },
    )
    assert.equal(
      readme,
      `# My stars

English | [简体中文](README.zh-CN.md)

Collects 2 GitHub repositories and 1 X posts, in 3 Categories. Summaries and Tags are in Chinese.

**[Open the online catalog →](https://example.github.io/stars/)** Search, filter and sort by stars there.

## Contents

- [AI coding agents](#ai-coding-agents) (1)
- [模型与评测](#模型与评测) (1)
- [Uncategorized](#uncategorized) (1)

## AI coding agents

- [acme/one](https://github.com/acme/one) — 一个 CLI<br><sub>Rust · 工具 · cli</sub>

[↑ Back to contents](#contents)

## 模型与评测

- [acme/two](https://github.com/acme/two)

[↑ Back to contents](#contents)

## Uncategorized

- X · [@dev](https://x.com/dev/status/1) — 一条帖子<br><sub>教程</sub>

[↑ Back to contents](#contents)

---

Data: [data/items.json](data/items.json)

Categories and Summaries are sorted out with AI help; what still needs review is shown in the [online catalog](https://example.github.io/stars/).

Generated by [starsieve](https://github.com/Adonis0123/starsieve); do not edit by hand.
`,
    )
  })

  it('in English, takes anchors from the English names, so two Categories that show the same name stay apart', () => {
    const readme = renderReadme(doc(repo('acme/a', { category: '甲' }), repo('acme/b', { category: '乙' })), 'en', {
      categoryLabels: { 甲: 'Tools', 乙: 'Tools' },
    })
    assert.match(readme, /- \[Tools\]\(#tools\) \(1\)\n- \[Tools\]\(#tools-1\) \(1\)\n/)
    assert.match(readme, /## Tools\n\n- \[acme\/a\][^\n]*\n\n\[↑ Back to contents\]\(#contents\)\n\n## Tools\n\n- \[acme\/b\]/)
  })

  it('writes README.md in English and README.zh-CN.md in Chinese, with English names from the store and one title or one per language', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const table = (await loadCategories(store))!
      await saveCategoriesTable(store, {
        ...table,
        categories: table.categories.map((c) => (c.name === 'CLI 与开发工具' ? { ...c, nameEn: ' CLI and dev tools ' } : c)),
      })
      await publish(store, out, false, { readme: { title: 'Stars' } })
      const en = await readFile(join(out, 'README.md'), 'utf8')
      const zh = await readFile(join(out, 'README.zh-CN.md'), 'utf8')
      assert.match(en, /^# Stars\n\nEnglish \| \[简体中文\]\(README\.zh-CN\.md\)\n\nCollects 2 GitHub repositories, in 1 Categories\. Summaries and Tags are in Chinese\.\n/)
      assert.match(en, /## CLI and dev tools\n\n- \[acme\/open\]\(https:\/\/github.com\/acme\/open\) — github:acme\/open 摘要/)
      assert.match(zh, /^# Stars\n\n\[English\]\(README\.md\) \| 简体中文\n\n收录 2 个 GitHub 仓库，分为 1 个分类。\n/)
      assert.match(zh, /## CLI 与开发工具\n\n- \[acme\/open\]/)
      assert.ok(!zh.includes('CLI and dev tools') && !zh.includes('Summaries and Tags'))
      await publish(store, out, false, { readme: { title: { zh: '我的收藏' } } })
      assert.match(await readFile(join(out, 'README.md'), 'utf8'), /^# Tech collection\n/)
      assert.match(await readFile(join(out, 'README.zh-CN.md'), 'utf8'), /^# 我的收藏\n/)
    })
  })

  it('counts a change to the Chinese README alone as a README change', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      await publish(store, out, false)
      const same = await publish(store, out, true)
      assert.deepEqual([same.readmeChanged, same.identical, same.contentChanged], [false, true, false])
      await writeFile(join(out, 'README.zh-CN.md'), 'edited\n')
      const zhOnly = await publish(store, out, true)
      assert.deepEqual([zhOnly.readmeChanged, zhOnly.identical, zhOnly.contentChanged], [true, false, true])
      const title = await publish(store, out, true, { readme: { title: { zh: '我的收藏' } } })
      assert.equal(title.readmeChanged, true)
    })
  })

  it('is byte-identical on a rerun and follows the layout for the data link', async () => {
    await withDir(async (dir) => {
      const { store, out } = await setup(dir)
      const options = { layout: 'repo' as const, readme: { title: 'T', siteUrl: 'https://example.github.io/stars/' } }
      await publish(store, out, false, options)
      const first = await Promise.all(['README.md', 'README.zh-CN.md'].map((f) => readFile(join(out, f))))
      const again = await publish(store, out, false, options)
      const second = await Promise.all(['README.md', 'README.zh-CN.md'].map((f) => readFile(join(out, f))))
      assert.ok(first[0]!.equals(second[0]!) && first[1]!.equals(second[1]!))
      assert.equal(again.readmeChanged, false)
      assert.match(first[0]!.toString(), /Data: \[data\/items\.json\]\(data\/items\.json\)/)
      assert.match(first[1]!.toString(), /数据：\[data\/items\.json\]\(data\/items\.json\)/)
    })
  })
})
