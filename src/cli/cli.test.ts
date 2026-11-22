// CLI: in-process runs with a fake star fetcher, plus one real child process for the entry point.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LoggedOutError, type OpenXBrowser } from '../collect/x.ts'
import { loadBackfill, loadCategories, loadClassifications, loadSkipped, loadXItems, saveSkipped } from '../core/store.ts'
import { fakeXBrowser, star, withDir, xRaw } from '../testing/fixtures.ts'
import { main } from './main.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const STARS = [star('acme/alpha'), star('acme/beta', { starred_at: '2026-11-05T00:00:00Z' })]

async function run(args: string[], openXBrowser?: OpenXBrowser) {
  let out = ''
  let err = ''
  const code = await main(args, {
    io: { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) },
    fetchStars: async () => STARS,
    openXBrowser,
  })
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(out) as Record<string, unknown>
  } catch {
    // text output
  }
  return { code, out, err, json }
}

describe('cli', () => {
  it('collect, categories init and check print a JSON envelope with schemaVersion', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const c = await run(['collect', 'github', '--store', store, '--json'])
      assert.equal(c.code, 0)
      assert.deepEqual([c.json.schemaVersion, c.json.ok, c.json.total], [1, true, 2])
      const i = await run(['categories', 'init', '--store', store, '--json'])
      assert.equal(i.json.created, true)
      const k = await run(['check', '--store', store, '--json'])
      assert.deepEqual([k.json.schemaVersion, k.json.pendingClassification], [1, 2])
    })
  })

  it('categories init never overwrites an existing table', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await run(['categories', 'init', '--store', store])
      const table = (await loadCategories(store))!
      table.categories = table.categories.slice(0, 2)
      await writeFile(join(store, 'categories.json'), JSON.stringify(table))
      const again = await run(['categories', 'init', '--store', store, '--json'])
      assert.equal(again.json.created, false)
      assert.equal((await loadCategories(store))!.categories.length, 2)
    })
  })

  it('categories set replaces the table and --reclassify reports what it removed', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await run(['collect', 'github', '--store', store])
      await run(['categories', 'init', '--store', store])
      const file = join(dir, 'table.json')
      await writeFile(file, JSON.stringify({ schemaVersion: 1, categories: [{ name: '工具' }] }))
      const bad = await run(['categories', 'set', '--store', store, '--file', file, '--json'])
      assert.deepEqual([bad.code, bad.json.ok], [1, false])
      const table = { schemaVersion: 1, categories: [{ name: '工具', description: 't' }, { name: '未分类', description: 'u' }] }
      await writeFile(file, JSON.stringify(table))
      const ok = await run(['categories', 'set', '--store', store, '--file', file, '--reclassify', '--json'])
      assert.equal(ok.code, 0)
      assert.deepEqual([ok.json.removed, ok.json.staleLocked, ok.json.categories], [0, [], ['工具', '未分类']])
      assert.deepEqual(await loadCategories(store), table)
    })
  })

  it('pending prints a Batch that apply accepts; override Locks and apply then skips it', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await run(['collect', 'github', '--store', store])
      await run(['categories', 'init', '--store', store])
      const p = await run(['pending', '--store', store, '--limit', '25', '--json'])
      const batch = p.json as { schemaVersion: number; batchId: string; items: { id: string; inputHash: string }[] }
      assert.equal(batch.schemaVersion, 1)
      assert.deepEqual(
        batch.items.map((x) => x.id),
        ['github:acme/beta', 'github:acme/alpha'],
      )
      assert.match(batch.items[0]!.inputHash, /^[0-9a-f]{64}$/)

      const o = await run([
        'override',
        'github:acme/alpha',
        '--store',
        store,
        '--category',
        '效率与桌面应用',
        '--tags',
        'x,y',
        '--visibility',
        'public',
        '--json',
      ])
      assert.equal(o.code, 0)

      const file = join(dir, 'answer.json')
      const answer = (id: string) => ({ id, category: '前端与 UI', tags: [], summary: 's', visibility: 'public' })
      await writeFile(file, JSON.stringify({ ...batch, classifications: batch.items.map((x) => answer(x.id)) }))
      const a = await run(['apply', '--store', store, '--file', file, '--json'])
      assert.deepEqual([a.json.accepted, a.json.skipped], [1, 1])

      const saved = await loadClassifications(store)
      assert.deepEqual(saved['github:acme/alpha'], {
        category: '效率与桌面应用',
        tags: ['x', 'y'],
        summary: '',
        visibility: 'public',
        needsReview: false,
        locked: true,
        by: 'owner',
        inputHash: batch.items[1]!.inputHash,
      })
      assert.equal(saved['github:acme/beta']?.category, '前端与 UI')
    })
  })

  it('override rejects a Category outside the table and a bad visibility', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await run(['collect', 'github', '--store', store])
      await run(['categories', 'init', '--store', store])
      const bad = await run(['override', 'github:acme/alpha', '--store', store, '--category', '游戏', '--json'])
      assert.equal(bad.code, 1)
      assert.equal(bad.json.ok, false)
      const vis = await run(['override', 'github:acme/alpha', '--store', store, '--visibility', 'secret'])
      assert.equal(vis.code, 1)
      assert.deepEqual(await loadClassifications(store), {})
    })
  })

  it('override --summary is cleaned like the Classifier summary', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await run(['collect', 'github', '--store', store])
      await run(['categories', 'init', '--store', store])
      const long = `看 <b>这个</b> https://evil.example/x?a=1 [链接](https://a.b) ${'很'.repeat(100)}`
      const o = await run(['override', 'github:acme/alpha', '--store', store, '--summary', long, '--json'])
      assert.equal(o.code, 0)
      const summary = (await loadClassifications(store))['github:acme/alpha']!.summary
      assert.ok(!/https?:|evil|<b>/.test(summary), summary)
      assert.ok(summary.startsWith('看 这个 链接 很'), summary)
      assert.equal([...summary].length, 80)
    })
  })

  it('collect x and backfill x print a JSON envelope; a logged-out browser exits 1 with an error envelope', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      const likes = [[xRaw('1'), xRaw('2')], [xRaw('2'), xRaw('3')]]
      const c = await run(['collect', 'x', '--store', store, '--signal', 'likes', '--max-scrolls', '1', '--json'], fakeXBrowser({ likes }).open)
      assert.equal(c.code, 0)
      assert.deepEqual([c.json.ok, c.json.added], [true, 3])
      const again = await run(
        ['collect', 'x', '--store', store, '--signal', 'likes', '--known-stop', '2', '--json'],
        fakeXBrowser({ likes }).open,
      )
      const list = (again.json.lists as { added: number; stoppedBy: string; knownRun: number }[])[0]!
      assert.deepEqual([again.json.added, list.stoppedBy, list.knownRun], [0, 'known', 2])

      const b = await run(['backfill', 'x', '--store', store, '--signal', 'likes', '--max-scrolls', '3', '--json'], fakeXBrowser({ likes }).open)
      assert.equal(b.code, 0)
      assert.deepEqual((await loadBackfill(store)).x.like?.scrolls, 3)

      const out = fakeXBrowser({ likes }, { failOnScroll: 1, error: new LoggedOutError('X is logged out') })
      const bad = await run(['collect', 'x', '--store', store, '--signal', 'likes', '--json'], out.open)
      assert.equal(bad.code, 1)
      assert.deepEqual(bad.json, { schemaVersion: 1, ok: false, error: { message: 'X is logged out' } })
      assert.equal((await loadXItems(store)).length, 3)
    })
  })

  it('override --unskip takes a Skipped Item back; the next collect x stores it as pending', async () => {
    await withDir(async (dir) => {
      const store = join(dir, 'store')
      await run(['categories', 'init', '--store', store])
      await saveSkipped(store, { 'x:7': { skippedAt: '2026-11-19T00:00:00.000Z' }, 'x:8': { skippedAt: '2026-11-19T00:00:00.000Z' } })

      const u = await run(['override', 'x:7', '--store', store, '--unskip', '--json'])
      assert.equal(u.code, 0)
      assert.deepEqual([u.json.id, u.json.unskipped, u.json.url], ['x:7', true, 'https://x.com/i/status/7'])
      assert.deepEqual(Object.keys(await loadSkipped(store)), ['x:8'])

      // x:7 is new again for collection; x:8 stays skipped and is never stored.
      const b = fakeXBrowser({ likes: [[xRaw('7'), xRaw('8')]] })
      await run(['collect', 'x', '--store', store, '--signal', 'likes', '--max-scrolls', '1', '--json'], b.open)
      assert.deepEqual((await loadXItems(store)).map((i) => i.id), ['x:7'])
      const p = await run(['pending', '--store', store, '--source', 'x'])
      assert.deepEqual((JSON.parse(p.out) as { items: { id: string }[] }).items.map((i) => i.id), ['x:7'])

      const again = await run(['override', 'x:7', '--store', store, '--unskip', '--json'])
      assert.equal(again.code, 1)
      assert.match(String((again.json.error as { message: string }).message), /not a Skipped Item/)
      const mixed = await run(['override', 'x:8', '--store', store, '--unskip', '--category', 'X'])
      assert.equal(mixed.code, 2)
    })
  })

  it('reports usage errors with exit code 2', async () => {
    assert.equal((await run(['collect', 'x', '--store', '/x', '--signal', 'retweets'])).code, 2)
    assert.equal((await run(['collect', 'x', '--store', '/x', '--known-stop', '0'])).code, 2)
    assert.equal((await run(['pending', '--store', '/x', '--source', 'mastodon'])).code, 2)
    assert.equal((await run(['publish', '--store', '/x'])).code, 2)
    assert.equal((await run(['frobnicate'])).code, 2)
    assert.equal((await run(['check', '--store', '/x', '--bogus'])).code, 2)
  })

  it('runs as a real process', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [MAIN, '--help'])
    assert.match(stdout, /starsieve collect github/)
  })
})

describe('cli: run, lists sync, init, schedule', () => {
  it('run --no-push --json and lists sync --dry-run take the store and clone from the config; init github --dry-run prints', async () => {
    const { makeRepos, fakeGh } = await import('../testing/repos.ts')
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const configPath = join(dir, 'config.json')
      await writeFile(configPath, JSON.stringify({ storePath: repos.store, publicRepoPath: repos.pub, portalCss: repos.css, publicRepo: 'o/stars' }))
      const gh = fakeGh()
      let out = ''
      const io = { out: (s: string) => (out += `${s}\n`), err: () => {} }
      const common = { io, configPath, logDir: join(dir, 'logs'), fetchStars: async () => STARS, runDeps: { gh: gh.exec, collectX: async () => [] } }
      assert.equal(await main(['run', '--no-push', '--max-batches', '2', '--json'], common), 0)
      const r = JSON.parse(out) as { ok: boolean; mode: string; classified: number; logPath: string }
      assert.deepEqual([r.ok, r.mode, r.classified], [true, 'no-push', 2])
      // --max-batches 0: collect and publish, classify nothing.
      out = ''
      assert.equal(await main(['run', '--no-push', '--max-batches', '0', '--json'], common), 0)
      const r0 = JSON.parse(out) as { ok: boolean; classified: number; batches: number }
      assert.deepEqual([r0.ok, r0.classified, r0.batches], [true, 0, 0])
      assert.equal(await main(['run', '--no-push', '--max-batches', '-1', '--json'], common), 2)
      out = ''
      assert.equal(await main(['lists', 'sync', '--dry-run', '--json'], common), 0)
      const l = JSON.parse(out) as { dryRun: boolean; updates: unknown[] }
      assert.equal(l.dryRun, true)
      assert.equal(gh.mutations.length, 0)
      out = ''
      assert.equal(await main(['init', 'github', '--dry-run'], common), 0)
      assert.match(out, /repos\/o\/stars\/branches\/main\/protection/)
      assert.equal(await main(['init', 'github'], common), 2)
    })
  })

  it('schedule install writes --no-push while schedulePush is false', async () => {
    await withDir(async (dir) => {
      const configPath = join(dir, 'config.json')
      await writeFile(configPath, JSON.stringify({ schedulePush: false, scheduleMaxBatches: 3 }))
      const calls: string[][] = []
      const launchctl = async (_c: string, args: readonly string[]) => {
        calls.push([...args])
        return { code: 0, stdout: '', stderr: '' }
      }
      let out = ''
      const code = await main(['schedule', 'install', '--json'], {
        io: { out: (s) => (out += s), err: () => {} },
        configPath,
        home: dir,
        logDir: join(dir, 'logs'),
        launchctl,
        loginPath: async () => '/usr/bin:/bin',
      })
      assert.equal(code, 0)
      const r = JSON.parse(out) as { programArguments: string[]; push: boolean }
      assert.deepEqual(r.programArguments.slice(2), ['run', '--no-push', '--max-batches', '3'])
      assert.equal(r.push, false)
      assert.equal(calls[1]?.[0], 'bootstrap')
    })
  })
})
