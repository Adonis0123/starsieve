// classify: a fake agent CLI stands in for cursor-agent; failures must leave the store byte-for-byte unchanged.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildBatch } from '../core/batch.ts'
import { writeJson } from '../core/json.ts'
import { loadCategories, loadClassifications, loadItems, loadSkipped, paths } from '../core/store.ts'
import { FAKE_AGENT, seedMixedStore, seedStore, snapshot, star, withDir, xRaw } from '../testing/fixtures.ts'
import { buildPrompt, classify, parseAgentJson } from './runner.ts'

async function storeWithAgent(dir: string, args: string[], timeoutMs = 20_000) {
  const store = await seedStore(dir, [
    star('acme/alpha', { starred_at: '2026-11-01T00:00:00Z' }),
    star('acme/beta', { starred_at: '2026-11-03T00:00:00Z' }),
    star('acme/gamma', { starred_at: '2026-11-02T00:00:00Z' }),
  ])
  await writeJson(paths.config(store), {
    schemaVersion: 1,
    classifier: { command: ['node', FAKE_AGENT, ...args], timeoutMs },
  })
  return store
}

describe('classify', () => {
  it('runs the agent in a deny-all workspace and applies its answer', async () => {
    await withDir(async (dir) => {
      const store = await storeWithAgent(dir, ['ok', '{prompt}'])
      const r = await classify(store, 2)
      assert.equal(r.batch.size, 2)
      assert.equal(r.apply?.accepted, 2)
      // Newest stars first.
      assert.deepEqual(Object.keys(await loadClassifications(store)).sort(), ['github:acme/beta', 'github:acme/gamma'])
      const next = await classify(store, 25)
      assert.equal(next.batch.size, 1)
      const done = await classify(store, 25)
      assert.equal(done.batch.size, 0)
      assert.equal(done.apply, null)
    })
  })

  it('reads JSON from a fenced block', async () => {
    await withDir(async (dir) => {
      const store = await storeWithAgent(dir, ['fenced', '{prompt}'])
      assert.equal((await classify(store, 25)).apply?.accepted, 3)
    })
  })

  it('sends the prompt on stdin when the command has no {prompt}', async () => {
    await withDir(async (dir) => {
      const store = await storeWithAgent(dir, ['stdin'])
      assert.equal((await classify(store, 25)).apply?.accepted, 3)
    })
  })

  for (const [mode, timeoutMs, error] of [
    ['garbage', 20_000, /not a JSON object/],
    ['no-array', 20_000, /no "classifications" array/],
    ['fail', 20_000, /exited with 3: model quota exceeded/],
    ['sleep', 500, /timed out after 500 ms/],
  ] as const) {
    it(`writes nothing when the agent output is ${mode}`, async () => {
      await withDir(async (dir) => {
        const store = await storeWithAgent(dir, [mode, '{prompt}'], timeoutMs)
        const before = await snapshot(store)
        await assert.rejects(classify(store, 25, undefined, { logDir: join(dir, 'logs') }), error)
        assert.deepEqual(await snapshot(store), before)
      })
    })
  }

  it('fails when the agent CLI does not exist, writing nothing', async () => {
    await withDir(async (dir) => {
      const store = await storeWithAgent(dir, [])
      await writeJson(paths.config(store), {
        schemaVersion: 1,
        classifier: { command: [join(dir, 'no-such-agent'), '{prompt}'], timeoutMs: 5000 },
      })
      const before = await snapshot(store)
      await assert.rejects(classify(store, 25), /cannot start/)
      assert.deepEqual(await snapshot(store), before)
    })
  })
})

describe('parseAgentJson', () => {
  it('accepts bare JSON, prose around an object, and rejects arrays', () => {
    assert.deepEqual(parseAgentJson('{"a":1}\n'), { a: 1 })
    assert.deepEqual(parseAgentJson('Sure! {"a":{"b":2}} done'), { a: { b: 2 } })
    assert.throws(() => parseAgentJson('[1,2]'), /not a JSON object/)
  })

  it('an unparsable answer is reported by length and hash only; the text goes to a 0600 file in the log directory', async () => {
    const secret = 'post text by someone else that must not reach the log, the Heartbeat or git '.repeat(10)
    assert.throws(() => parseAgentJson(secret), (e: Error) => {
      assert.match(e.message, /no-json-object; \d+ characters, sha256 [0-9a-f]{12}\)/)
      assert.ok(!e.message.includes('post text'))
      return true
    })
    assert.throws(() => parseAgentJson('  \n'), /\(empty; /)
    await withDir(async (dir) => {
      const store = await storeWithAgent(dir, ['garbage', '{prompt}'])
      const logDir = join(dir, 'logs')
      const error = await classify(store, 25, undefined, { logDir }).then(
        () => assert.fail('classify should fail'),
        (e: Error) => e,
      )
      assert.ok(!error.message.includes('could not classify'), error.message)
      const path = /the output is in (\S+)$/.exec(error.message)?.[1]
      assert.ok(path?.startsWith(logDir), error.message)
      assert.equal(await readFile(path!, 'utf8'), 'I could not classify these, sorry.\n')
      assert.equal((await stat(path!)).mode & 0o777, 0o600)
    })
  })
})

describe('classify by Source', () => {
  async function mixedWithAgent(dir: string) {
    const store = await seedMixedStore(
      dir,
      [star('acme/alpha', { starred_at: '2026-12-01T00:00:00Z' }), star('corp/secret', { private: true })],
      [xRaw('1'), xRaw('2', { text: 'NONTECH holiday' }), xRaw('3', { text: '' })],
    )
    await writeJson(paths.config(store), {
      schemaVersion: 1,
      classifier: { command: ['node', FAKE_AGENT, 'ok', '{prompt}'], timeoutMs: 20_000 },
    })
    return store
  }

  it('builds one prompt per Source; only the X prompt asks for keep', async () => {
    await withDir(async (dir) => {
      const store = await mixedWithAgent(dir)
      const items = await loadItems(store)
      const table = (await loadCategories(store))!
      const x = buildPrompt(buildBatch(items, {}, 25, 'x'), table)
      const gh = buildPrompt(buildBatch(items, {}, 25, 'github'), table)
      assert.match(x, /keep: true for a technical post, false otherwise/)
      assert.match(x, /programming, AI, developer tools or design engineering/)
      assert.match(x, /"textEmpty": true has no text/)
      assert.doesNotMatch(gh, /keep/)
      // The star of a private repository is never in any prompt.
      for (const prompt of [x, gh, buildPrompt(buildBatch(items, {}, 25), table)]) {
        assert.ok(!prompt.includes('corp/secret'), 'private repository sent to the Classifier')
      }
    })
  })

  it('both prompts ask for the item type as the first tag and a Category by description', async () => {
    await withDir(async (dir) => {
      const store = await mixedWithAgent(dir)
      const items = await loadItems(store)
      const table = (await loadCategories(store))!
      const x = buildPrompt(buildBatch(items, {}, 25, 'x'), table)
      const gh = buildPrompt(buildBatch(items, {}, 25, 'github'), table)
      for (const prompt of [x, gh]) {
        assert.match(prompt, /The first tag is the item's type, exactly one of: 库, 工具, 应用, Skill\/插件, 模型, 教程, 文章\/观点, 合集, 模板\./)
        assert.match(prompt, /At most 6 tags in total, the type included/)
        assert.match(prompt, /chosen by its description/)
      }
      assert.match(gh, /"tags":\["工具",/)
      assert.match(x, /usually 教程 .* or 文章\/观点/)
      assert.doesNotMatch(gh, /usually 教程/)
    })
  })

  it('--source x classifies X posts and turns non-technical ones into Skipped Items', async () => {
    await withDir(async (dir) => {
      const store = await mixedWithAgent(dir)
      const r = await classify(store, 25, 'x')
      assert.deepEqual([r.batch.source, r.batch.size], ['x', 3])
      assert.deepEqual([r.apply?.accepted, r.apply?.skippedItems], [2, 1])
      assert.deepEqual(Object.keys(await loadSkipped(store)), ['x:2'])
      const c = await loadClassifications(store)
      assert.equal(c['x:3']?.visibility, 'private')
      assert.equal(c['github:acme/alpha'], undefined)
      // Without --source the GitHub star (newer) comes next; the private one never does.
      const next = await classify(store, 25)
      assert.deepEqual([next.batch.source, next.batch.size], ['github', 1])
      assert.equal((await classify(store, 25)).batch.size, 0)
    })
  })
})
