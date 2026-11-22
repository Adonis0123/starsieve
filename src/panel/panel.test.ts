// Panel: the HTTP API reads the whole store and writes only through overrideItem / unskipItem, behind Host, Origin,
// token and readOnly checks. The page itself is checked in a browser, not here.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { request, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { overrideItem } from '../core/override.ts'
import { loadClassifications, loadSkipped, saveSkipped } from '../core/store.ts'
import { seedMixedStore, star, withDir, xRaw } from '../testing/fixtures.ts'
import { createPanelHandler, type PanelOptions } from './index.ts'

interface Reply {
  status: number
  json: Record<string, any>
  text: string
}

async function withPanel(options: Omit<PanelOptions, 'allowedHosts'>, fn: (call: Call, token: string, host: string) => Promise<void>) {
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => void handler!(req, res))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  handler = createPanelHandler({ ...options, allowedHosts: [host], basePath: '/panel' })
  const call: Call = (method, path, o = {}) =>
    new Promise((done, fail) => {
      const body = o.body === undefined ? undefined : JSON.stringify(o.body)
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(host.split(':')[1]),
          method,
          path: `/panel${path}`,
          headers: {
            host: o.host ?? host,
            ...(o.origin !== null ? { origin: o.origin ?? `http://${host}` } : {}),
            ...(o.token ? { 'x-starsieve-token': o.token } : {}),
            ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
          },
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8').on('data', (d: string) => (text += d))
          res.on('end', () => {
            let json: Record<string, any> = {}
            try {
              json = JSON.parse(text)
            } catch {}
            done({ status: res.statusCode ?? 0, json, text })
          })
        },
      )
      req.on('error', fail)
      req.end(body)
    })
  try {
    await fn(call, handler.token, host)
  } finally {
    server.close()
  }
}

type Call = (
  method: string,
  path: string,
  o?: { body?: unknown; token?: string; host?: string; origin?: string | null },
) => Promise<Reply>

async function store(dir: string): Promise<string> {
  const s = await seedMixedStore(
    dir,
    [star('acme/alpha', { stargazers_count: 120 }), star('acme/secret', { private: true })],
    [xRaw('11', { text: 'a post about Rust' })],
  )
  await overrideItem(s, 'github:acme/alpha', { category: '库与框架', visibility: 'public' })
  await saveSkipped(s, { 'x:99': { skippedAt: '2026-11-19T00:00:00.000Z' } })
  return s
}

describe('panel handler', () => {
  it('answers health and state with every Item, the Skipped Items and the store path', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      await withPanel({ storePath: s, version: '9.9.9' }, async (call) => {
        assert.deepEqual((await call('GET', '/api/health')).json, { app: 'starsieve', version: '9.9.9' })
        const st = await call('GET', '/api/state')
        assert.equal(st.status, 200)
        assert.equal(st.json.status, 'ok')
        const keys = st.json.data.items.map((i: { key: string }) => i.key).sort()
        assert.deepEqual(keys, ['github:acme/alpha', 'github:acme/secret', 'x:11'])
        const alpha = st.json.data.items.find((i: { key: string }) => i.key === 'github:acme/alpha')
        assert.deepEqual([alpha.category, alpha.visibility, alpha.locked, alpha.stars], ['库与框架', 'public', true, 120])
        assert.equal(st.json.data.items.find((i: { key: string }) => i.key === 'x:11').category, null)
        assert.deepEqual(st.json.data.skipped.map((x: { id: string }) => x.id), ['x:99'])
        const page = await call('GET', '/')
        assert.equal(page.status, 200)
        assert.match(page.text, /\/_shared\/local-tools\.css/)
      })
    })
  })

  it('override writes through overrideItem: cleaned, Locked, and refused like the CLI', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      await withPanel({ storePath: s }, async (call, token) => {
        const ok = await call('POST', '/api/override', {
          token,
          body: { id: 'x:11', category: 'CLI 与开发工具', tags: ['rust', 'Rust', 'cli'], summary: 'see <b>https://x.y</b> now' },
        })
        assert.equal(ok.status, 200)
        const c = (await loadClassifications(s))['x:11']!
        assert.deepEqual([c.category, c.tags, c.summary, c.locked, c.by, c.needsReview], ['CLI 与开发工具', ['rust', 'cli'], 'see now', true, 'owner', false])
        assert.deepEqual(ok.json.classification, c)

        const bad = await call('POST', '/api/override', { token, body: { id: 'x:11', category: 'Nope' } })
        assert.equal(bad.status, 400)
        assert.match(bad.json.error.message, /not in the Category Table/)
        const missing = await call('POST', '/api/override', { token, body: { id: 'x:404', category: 'CLI 与开发工具' } })
        assert.equal(missing.status, 400)
      })
    })
  })

  it('unskip writes through unskipItem', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      await withPanel({ storePath: s }, async (call, token) => {
        const r = await call('POST', '/api/unskip', { token, body: { id: 'x:99' } })
        assert.deepEqual([r.status, r.json.id], [200, 'x:99'])
        assert.deepEqual(await loadSkipped(s), {})
      })
    })
  })

  it('refuses writes without the token, from another origin or host, and always when readOnly', async () => {
    await withDir(async (dir) => {
      const s = await store(dir)
      const before = await readFile(join(s, 'classifications.json'), 'utf8')
      const body = { id: 'x:11', category: 'CLI 与开发工具' }
      await withPanel({ storePath: s }, async (call, token) => {
        assert.equal((await call('POST', '/api/override', { body })).status, 403)
        const wrong = await call('POST', '/api/override', { body, token: 'wrong' })
        assert.deepEqual([wrong.status, wrong.json.error.code], [403, 'bad-token'])
        assert.equal((await call('GET', '/api/token')).json.token, token)
        assert.equal((await call('POST', '/api/override', { body, token, origin: 'http://evil.localhost' })).status, 403)
        assert.equal((await call('POST', '/api/override', { body, token, origin: null })).status, 403)
        assert.equal((await call('GET', '/api/state', { host: 'evil.localhost:1' })).status, 403)
        assert.equal((await call('GET', '/api/override')).status, 405)
      })
      await withPanel({ storePath: s, readOnly: true }, async (call, token) => {
        const r = await call('POST', '/api/override', { body, token })
        assert.equal(r.status, 403)
        assert.match(r.json.error.message, /read-only/)
        assert.equal((await call('POST', '/api/unskip', { body: { id: 'x:99' }, token })).status, 403)
        assert.equal((await call('GET', '/api/state')).json.readOnly, true)
        assert.equal((await call('GET', '/api/token')).status, 403)
        // The page gets no token to write with.
        assert.ok(!(await call('GET', '/')).text.includes(token))
      })
      assert.equal(await readFile(join(s, 'classifications.json'), 'utf8'), before)
      assert.deepEqual(Object.keys(await loadSkipped(s)), ['x:99'])
    })
  })

  it('reports no store set up, and a store that is missing, with a next step', async () => {
    await withDir(async (dir) => {
      const configPath = join(dir, 'config.json')
      await withPanel({ configPath }, async (call) => {
        assert.equal((await call('GET', '/api/state')).json.status, 'unconfigured')
      })
      await writeFile(configPath, JSON.stringify({ storePath: join(dir, 'nowhere') }))
      await withPanel({ configPath }, async (call) => {
        const st = (await call('GET', '/api/state')).json
        assert.equal(st.status, 'error')
        assert.match(st.next, /collect github --store/)
      })
    })
  })

  it('rejects options outside the Portal contract with a TypeError', () => {
    assert.throws(() => createPanelHandler({ allowedHosts: [], lang: 'fr' as 'en' }), TypeError)
    assert.throws(() => createPanelHandler({ allowedHosts: [], theme: { colorScheme: 'sepia' as 'auto' } }), TypeError)
    assert.doesNotThrow(() =>
      createPanelHandler({ allowedHosts: [], theme: { colorScheme: 'auto', header: 'bar', light: { bg: '#fff' }, dark: { bg: '#000' } } }),
    )
  })
})
