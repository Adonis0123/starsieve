// init data / init github, and the zero-dependency scripts they write: validate.mjs and heartbeat-check.mjs.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import { overrideItem } from '../core/override.ts'
import { buildProjection } from '../publish/projection.ts'
import { seedMixedStore, star, withDir, xRaw } from '../testing/fixtures.ts'
import { githubCommands, initData } from './init.ts'
// @ts-expect-error -- plain JavaScript, no types
import { decide, TITLE } from './templates/heartbeat-check.mjs'
// @ts-expect-error -- plain JavaScript, no types
import { validateDoc, validatePaths } from './templates/validate.mjs'

const run = promisify(execFile)

async function publicDoc(dir: string) {
  const store = await seedMixedStore(dir, [star('acme/open'), star('acme/secret', { private: true })], [xRaw('21', { text: 'SECRET TEXT' })])
  await overrideItem(store, 'github:acme/open', { category: '库与框架', visibility: 'public', summary: '一个库' })
  await overrideItem(store, 'github:acme/secret', { category: '库与框架', visibility: 'public' })
  await overrideItem(store, 'x:21', { category: '教程与观点', visibility: 'public', summary: '讲 agent' })
  return buildProjection(store)
}

describe('validate.mjs', () => {
  it('accepts what publish writes', async () => {
    await withDir(async (dir) => {
      const doc = await publicDoc(dir)
      assert.equal(doc.items.length, 2)
      assert.deepEqual(validateDoc(JSON.parse(JSON.stringify(doc))), [])
    })
  })

  it('rejects private fields, X text, private-repository marks, long summaries and a wrong schemaVersion', async () => {
    await withDir(async (dir) => {
      const original = JSON.stringify(await publicDoc(dir))
      type Doc = { schemaVersion: number; items: Record<string, unknown>[] }
      const cases: [string, (d: Doc, gh: Record<string, unknown>, x: Record<string, unknown>) => void, RegExp][] = [
        ['visibility', (d) => (d.items[0]!.visibility = 'private'), /visibility: private data/],
        ['repoPrivate', (_d, gh) => (gh.repoPrivate = true), /repoPrivate/],
        ['X text', (_d, _gh, x) => (x.text = 'SECRET TEXT'), /has text/],
        ['summary', (_d, gh) => (gh.summary = '长'.repeat(81)), /81 characters/],
        ['link in summary', (_d, gh) => (gh.summary = 'see https://evil.example'), /links or HTML/],
        ['schemaVersion', (d) => (d.schemaVersion = 2), /schemaVersion/],
        ['missing needsReview', (_d, gh) => delete gh.needsReview, /missing needsReview/],
        ['unknown field', (_d, _gh, x) => (x.likedBy = 'me'), /unexpected field likedBy/],
      ]
      for (const [name, mutate, re] of cases) {
        const doc = JSON.parse(original) as Doc
        mutate(doc, doc.items.find((i) => 'id' in i)!, doc.items.find((i) => !('id' in i))!)
        const errors = validateDoc(doc) as string[]
        assert.ok(errors.some((e) => re.test(e)), `${name}: ${errors.join('; ')}`)
      }
    })
  })

  it('allows only data/, README.md and docs/ in a PR', () => {
    assert.deepEqual(validatePaths(['data/items.json', 'README.md', 'docs/index.html']), [])
    assert.equal(validatePaths(['.github/workflows/check.yml', 'package.json']).length, 2)
  })

  it('as a script: exit 1 with the problem for a bad file, exit 0 for a good one; --base checks changed paths', async () => {
    await withDir(async (dir) => {
      const doc = await publicDoc(dir)
      const pub = join(dir, 'public')
      await initData({ privateDir: join(dir, 'private'), publicDir: pub })
      const script = join(pub, '.github', 'scripts', 'validate.mjs')
      const good = join(dir, 'good.json')
      const bad = join(dir, 'bad.json')
      await writeFile(good, JSON.stringify(doc))
      const tampered = JSON.parse(JSON.stringify(doc))
      tampered.items.push({ ...tampered.items[0], id: 'github:corp/secret', repoPrivate: true, visibility: 'private' })
      await writeFile(bad, JSON.stringify(tampered))
      const ok = await run('node', [script, '--items', good])
      assert.match(ok.stdout, /valid: 2 items/)
      const err = await run('node', [script, '--items', bad]).then(() => undefined, (e: { code: number; stdout: string }) => e)
      assert.equal(err?.code, 1)
      assert.match(err!.stdout, /github:corp\/secret\) has visibility/)

      // --base: a PR that touches .github is rejected.
      const git = (...a: string[]) => run('git', a, { cwd: pub })
      await git('init', '-q', '-b', 'main')
      await git('-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'base')
      await writeFile(join(pub, 'package.json'), '{}')
      await run('mkdir', ['-p', join(pub, 'data')])
      await writeFile(join(pub, 'data', 'items.json'), JSON.stringify(doc))
      await git('add', '-A')
      await git('-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'pr')
      const pr = await run('node', [script, '--base', 'HEAD~1']).then(() => undefined, (e: { code: number; stdout: string }) => e)
      assert.equal(pr?.code, 1)
      assert.match(pr!.stdout, /\.github\/scripts\/validate\.mjs: the PR may change only/)
      assert.match(pr!.stdout, /package\.json: the PR may change only/)
    })
  })
})

describe('heartbeat-check.mjs', () => {
  const now = new Date('2026-11-21T12:00:00Z')
  it('opens one issue after 48 hours without a successful run, and closes it after one', () => {
    const stale = { lastSuccessAt: '2026-11-19T11:00:00Z', lastAttemptAt: '2026-11-21T08:17:00Z', steps: [{ name: 'collect-x', status: 'failed', error: 'logged out' }] }
    const d = decide(stale, now, [])
    assert.equal(d.action, 'create')
    assert.match(d.body, /collect-x: logged out/)
    assert.equal(decide(stale, now, [{ number: 3, title: TITLE }]).action, 'none')
    assert.equal(decide(undefined, now, []).action, 'create')
    const fresh = { lastSuccessAt: '2026-11-21T08:17:00Z' }
    assert.deepEqual(decide(fresh, now, [{ number: 3, title: TITLE }]).numbers, [3])
    assert.equal(decide(fresh, now, []).action, 'none')
  })
})

describe('init data', () => {
  it('writes both repositories\' files, keeps a changed file unless --force', async () => {
    await withDir(async (dir) => {
      const o = { privateDir: join(dir, 'private'), publicDir: join(dir, 'public'), storeDir: join(dir, 'private', 'store') }
      const first = await initData(o)
      assert.deepEqual(first.map((f) => f.status), ['created', 'created', 'created', 'created'])
      const wf = await readFile(join(dir, 'private', '.github', 'workflows', 'heartbeat.yml'), 'utf8')
      assert.match(wf, /--heartbeat "store\/heartbeat.json"/)
      assert.match(await readFile(join(dir, 'public', '.github', 'workflows', 'check.yml'), 'utf8'), /^ {2}check:$/m)
      const check = join(dir, 'public', '.github', 'workflows', 'check.yml')
      await writeFile(check, 'mine')
      assert.equal((await initData(o)).find((f) => f.path === check)?.status, 'kept')
      assert.equal(await readFile(check, 'utf8'), 'mine')
      assert.equal((await initData({ ...o, force: true })).find((f) => f.path === check)?.status, 'updated')
    })
  })
})

describe('init github', () => {
  it('prints auto-merge, branch protection requiring "check", and Pages from main /docs', () => {
    const text = githubCommands('o/stars').map((c) => c.command).join('\n')
    assert.match(text, /allow_auto_merge=true/)
    assert.match(text, /repos\/o\/stars\/branches\/main\/protection/)
    assert.match(text, /"context":"check"/)
    assert.match(text, /"path":"\/docs"/)
  })
})
