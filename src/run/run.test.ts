// run: the step order, the Heartbeat, the nothing-new path, failures, and git against local bare remotes.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { collectGithub } from '../collect/github.ts'
import { LoggedOutError } from '../collect/x.ts'
import { overrideItem } from '../core/override.ts'
import { star, withDir } from '../testing/fixtures.ts'
import { fakeGh, gitIn, makeRepos, type Repos } from '../testing/repos.ts'
import { loadHeartbeat } from './heartbeat.ts'
import { acquireLock, LockedError } from './lock.ts'
import { blobHash, rollbackWrites, squashUnpushed } from './public-repo.ts'
import { type RunDeps, type RunOptions, run } from './run.ts'

const STARS = [
  star('acme/alpha', { starred_at: '2026-11-01T00:00:00Z', stargazers_count: 120 }),
  star('acme/beta', { starred_at: '2026-11-05T00:00:00Z' }),
  star('corp/secret', { private: true }),
]
const NOW = new Date('2026-11-21T08:17:00')
const DAY_BRANCH = 'starsieve/20261121'

/** GitHub's view of the PR head: the day branch on the bare remote. */
const remoteHead = (r: Repos, branch = DAY_BRANCH) => () => gitIn(r.publicBare, 'rev-parse', branch).then((s) => s.trim(), () => undefined)

function setup(r: Repos, over: Partial<RunOptions> = {}, deps: Partial<RunDeps> = {}) {
  let stars = STARS
  const gh = fakeGh([], { prHead: remoteHead(r) })
  const options: RunOptions = {
    store: r.store,
    publicRepo: r.pub,
    slug: 'o/stars',
    push: false,
    css: r.css,
    logDir: join(r.dir, 'logs'),
    mergeTimeoutMs: 1000,
    pollMs: 1,
    ...over,
    deps: {
      collectGithub: (s) => collectGithub(s, async () => stars),
      collectX: async () => [],
      gh: gh.exec,
      now: () => NOW,
      sleep: async () => {},
      ...deps,
    },
  }
  return { options, gh, setStars: (s: typeof STARS) => (stars = s) }
}

const status = (r: Awaited<ReturnType<typeof run>>) => Object.fromEntries(r.steps.map((s) => [s.name, s.status]))

describe('run', () => {
  it('--no-push: runs every step in order, commits both clones locally, writes the Heartbeat and the log', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const { options, gh } = setup(repos)
      const r = await run(options)
      assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2))
      assert.deepEqual(
        r.steps.map((s) => s.name),
        ['check', 'collect-github', 'collect-x', 'classify', 'publish', 'site', 'private', 'public', 'pr', 'wait-merge', 'lists-sync', 'heartbeat'],
      )
      assert.deepEqual([status(r).pr, status(r)['lists-sync']], ['skipped', 'dry-run'])
      assert.equal(r.classified, 2)
      assert.equal(r.nothingNew, false)

      // Public branch: data, README and site; the clone is back on main; nothing pushed.
      const files = (await gitIn(repos.pub, 'show', '--name-only', '--format=', DAY_BRANCH)).trim().split('\n').sort()
      assert.deepEqual(files, ['README.md', 'data/items.json', 'docs/index.html'])
      assert.equal((await gitIn(repos.pub, 'branch', '--show-current')).trim(), 'main')
      const items = JSON.parse(await gitIn(repos.pub, 'show', `${DAY_BRANCH}:data/items.json`)) as { items: { id: string }[] }
      assert.deepEqual(items.items.map((i) => i.id).sort(), ['github:acme/alpha', 'github:acme/beta'])
      assert.equal((await gitIn(repos.publicBare, 'branch', '--list')).includes('starsieve/'), false)
      assert.equal((await gitIn(repos.privateBare, 'rev-list', '--count', 'main')).trim(), '1')

      // Private store: committed locally, clean afterwards, Heartbeat committed with the last commit.
      assert.equal((await gitIn(repos.store, 'status', '--porcelain')).trim(), '')
      const hb = (await loadHeartbeat(repos.store))!
      assert.equal(hb.result, 'success')
      assert.equal(hb.lastSuccessAt, NOW.toISOString())
      assert.equal(hb.lastAttemptAt, NOW.toISOString())
      assert.ok(hb.steps.some((s) => s.name === 'classify' && s.status === 'ok'))
      assert.match(await gitIn(repos.store, 'log', '-1', '--format=%s'), /heartbeat/)

      // Lists were only read: no mutation, no PR call.
      assert.equal(gh.mutations.length, 0)
      assert.ok(!gh.calls.some((c) => c.args[0] === 'pr'))
      assert.match(await readFile(r.logPath, 'utf8'), /classify: ok/)
      assert.ok(r.logPath.endsWith('run-20261121.log'))
    })
  })

  it('a second run with nothing new only writes the Heartbeat and makes no public commit', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const { options, setStars } = setup(repos)
      await run(options)
      const tipBefore = (await gitIn(repos.pub, 'rev-parse', DAY_BRANCH)).trim()
      const privateBefore = Number((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim())
      // Star counts moved: still nothing new to publish.
      setStars(STARS.map((s) => ({ ...s, repo: { ...s.repo, stargazers_count: 999 } })))
      const r = await run(options)
      assert.equal(r.ok, true)
      assert.equal(r.nothingNew, true)
      assert.equal(r.public.commit, null)
      assert.equal((await gitIn(repos.pub, 'rev-parse', DAY_BRANCH)).trim(), tipBefore)
      assert.equal((await gitIn(repos.pub, 'branch', '--list', 'starsieve/*')).trim().split('\n').length, 1)
      assert.equal(status(r).site, 'skipped')
      const hb = (await loadHeartbeat(repos.store))!
      assert.deepEqual([hb.result, hb.nothingNew], ['success', true])
      const privateAfter = Number((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim())
      assert.ok(privateAfter > privateBefore)
    })
  })

  it('a new README (here its title) is published even when no Item changed', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      await run(setup(repos).options)
      const tipBefore = (await gitIn(repos.pub, 'rev-parse', DAY_BRANCH)).trim()
      const r = await run(setup(repos, { readme: { title: 'Stars of o' } }).options)
      assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2))
      assert.equal(r.nothingNew, false)
      assert.match(r.steps.find((x) => x.name === 'publish')!.detail!, /README changed/)
      assert.ok(r.public.commit)
      const files = (await gitIn(repos.pub, 'diff', '--name-only', tipBefore, DAY_BRANCH)).trim().split('\n')
      assert.deepEqual(files, ['README.md'])
      assert.match(await gitIn(repos.pub, 'show', `${DAY_BRANCH}:README.md`), /^# Stars of o/)
    })
  })

  it('--pr-dry-run pushes both repositories to their remotes but only prints the PR and plans the Lists', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      // First a --no-push run, so the push run has a local branch and commits to send.
      await run(setup(repos).options)
      const { options, gh } = setup(repos, { push: true, prDryRun: true })
      const r = await run(options)
      assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2))
      assert.equal(r.public.pushed, true)
      assert.equal(r.private.pushed, true)
      assert.equal((await gitIn(repos.publicBare, 'rev-parse', DAY_BRANCH)).trim(), (await gitIn(repos.pub, 'rev-parse', DAY_BRANCH)).trim())
      assert.equal((await gitIn(repos.privateBare, 'rev-parse', 'main')).trim(), (await gitIn(repos.store, 'rev-parse', 'HEAD')).trim())
      assert.equal(status(r).pr, 'dry-run')
      assert.ok(r.printed.some((p) => p.startsWith('gh pr create')))
      assert.ok(r.printed.some((p) => p.includes('--auto --squash')))
      assert.ok(!gh.calls.some((c) => c.args[0] === 'pr'), 'no gh pr call')
      assert.equal(gh.mutations.length, 0)
    })
  })

  it('push: opens the PR with auto-merge, waits for the merge, then syncs the Lists', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const { options, gh } = setup(repos, { push: true })
      // Simulate GitHub merging the PR: the merge check pushes the branch to main of the bare remote.
      const merge = gh.exec
      options.deps!.gh = async (cmd, args, o) => {
        if (args[0] === 'pr' && args[1] === 'view') await gitIn(repos.pub, 'push', '--quiet', 'origin', `${DAY_BRANCH}:main`)
        return merge(cmd, args, o)
      }
      const r = await run(options)
      assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2))
      assert.equal(r.public.pr, 'https://github.com/o/stars/pull/7')
      assert.equal(r.public.merged, true)
      const merges = gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge')
      assert.deepEqual(merges[0]?.args.slice(-2), ['--auto', '--squash'])
      // Two lists created? No: both public stars share one Category, so one list, and both repositories added to it.
      assert.equal(r.lists?.created.length, 1)
      assert.equal(r.lists?.updated, 2)
    })
  })

  it('a merge that takes too long is a timeout, not a failure', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const { options } = setup(repos, { push: true, mergeTimeoutMs: 1 })
      options.deps!.gh = fakeGh([], { prState: 'OPEN', prHead: remoteHead(repos) }).exec
      const r = await run(options)
      assert.equal(status(r)['wait-merge'], 'timeout')
      assert.equal(r.ok, true)
      assert.equal(r.public.merged, false)
    })
  })

  it('a failed X collection fails the run, but the rest goes on and X stays as published', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const first = await run(setup(repos).options)
      const firstSuccess = (await loadHeartbeat(repos.store))!.lastSuccessAt
      assert.equal(first.ok, true)
      const { options } = setup(repos, {}, {
        collectX: async () => {
          throw new LoggedOutError('X is logged out: https://x.com/i/jf/onboarding')
        },
      })
      const r = await run(options)
      assert.equal(r.ok, false)
      assert.equal(status(r)['collect-x'], 'failed')
      assert.equal(status(r).publish, 'ok')
      assert.deepEqual(r.held, ['x'])
      const hb = (await loadHeartbeat(repos.store))!
      assert.equal(hb.result, 'failed')
      assert.equal(hb.lastSuccessAt, firstSuccess)
      assert.match(hb.steps.find((s) => s.name === 'collect-x')!.error!, /logged out/)
    })
  })

  it('a failed GitHub collection keeps the public GitHub Items as they were', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      await run(setup(repos).options)
      await overrideItem(repos.store, 'github:acme/alpha', { summary: 'changed while GitHub was down' })
      const { options } = setup(repos, {}, {
        collectGithub: async () => {
          throw new Error('gh: HTTP 502')
        },
      })
      const r = await run(options)
      assert.equal(r.ok, false)
      assert.deepEqual(r.held, ['github'])
      const items = await gitIn(repos.pub, 'show', `${DAY_BRANCH}:data/items.json`)
      assert.ok(!items.includes('changed while GitHub was down'))
    })
  })

  it('a failed classify step stops the run; later steps are skipped and the failure is committed in the Heartbeat', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS, 'fail')
      const r = await run(setup(repos).options)
      assert.equal(r.ok, false)
      assert.equal(status(r).classify, 'failed')
      for (const name of ['publish', 'site', 'private', 'public', 'pr', 'wait-merge', 'lists-sync']) assert.equal(status(r)[name], 'skipped', name)
      assert.equal(status(r).heartbeat, 'ok')
      const committed = JSON.parse(await gitIn(repos.store, 'show', 'HEAD:heartbeat.json')) as { result: string; lastSuccessAt: string | null }
      assert.deepEqual([committed.result, committed.lastSuccessAt], ['failed', null])
      assert.equal((await gitIn(repos.pub, 'branch', '--list', 'starsieve/*')).trim(), '')
    })
  })

  it('--dry-run writes nothing to the store or the clones', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const r = await run(setup(repos, { dryRun: true }).options)
      assert.equal(r.ok, true)
      assert.ok(r.steps.every((s) => s.status === 'dry-run'))
      assert.equal((await gitIn(repos.store, 'status', '--porcelain')).trim(), '')
      assert.equal(await stat(join(repos.store, 'heartbeat.json')).catch(() => undefined), undefined)
    })
  })

  it('a store whose repository pushes to the public repository is never committed or pushed; the Heartbeat stays local', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const privateCount = async () => (await gitIn(repos.privateBare, 'rev-list', '--count', 'main')).trim()
      const publicRefs = async () => (await gitIn(repos.publicBare, 'for-each-ref', '--format=%(refname) %(objectname)')).trim()
      const refsBefore = await publicRefs()
      // The private clone's origin points at the public repository.
      await gitIn(repos.store, 'remote', 'set-url', 'origin', repos.publicBare)
      const r = await run(setup(repos, { push: true, prDryRun: true }).options)
      assert.equal(r.ok, false)
      assert.equal(status(r).check, 'failed')
      assert.match(r.steps.find((x) => x.name === 'check')!.error!, /pushes to the public repository/)
      for (const name of ['collect-github', 'publish', 'private', 'public', 'pr']) assert.equal(status(r)[name], 'skipped', name)
      assert.equal(status(r).heartbeat, 'skipped')
      assert.deepEqual([r.private.commits, r.private.pushed], [[], false])
      assert.equal(await publicRefs(), refsBefore, 'nothing reached the public remote')
      assert.equal((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim(), '1', 'no store commit')
      assert.equal((await loadHeartbeat(repos.store))?.result, 'failed', 'the Heartbeat is written locally')
      assert.equal(await privateCount(), '1')

      // Same with a GitHub origin that names the public repository (config publicRepo o/stars), in any letter case.
      await gitIn(repos.store, 'remote', 'set-url', 'origin', 'git@github.com:O/Stars.git')
      const r2 = await run(setup(repos).options)
      assert.equal(status(r2).check, 'failed')
      assert.equal((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim(), '1')
    })
  })

  it('a push URL of the store repository naming the public repository blocks store commits: one pushurl, one of several, a slug in another case', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const publicRefs = async () => (await gitIn(repos.publicBare, 'for-each-ref', '--format=%(refname) %(objectname)')).trim()
      const refsBefore = await publicRefs()
      const blocked = async (label: string, push = false) => {
        const r = await run(setup(repos, push ? { push: true, prDryRun: true } : {}).options)
        assert.equal(status(r).check, 'failed', label)
        assert.match(r.steps.find((x) => x.name === 'check')!.error!, /pushes to the public repository/, label)
        assert.deepEqual([r.private.commits, r.private.pushed], [[], false], label)
        assert.equal((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim(), '1', `${label}: no store commit`)
      }
      // The fetch URL stays the private repository; only the push URL is the public one.
      await gitIn(repos.store, 'remote', 'set-url', '--push', 'origin', repos.publicBare)
      await blocked('one pushurl', true)
      assert.equal(await publicRefs(), refsBefore, 'nothing reached the public remote')
      assert.equal((await gitIn(repos.privateBare, 'rev-list', '--count', 'main')).trim(), '1')

      // Two push URLs, the private one first.
      await gitIn(repos.store, 'config', '--unset-all', 'remote.origin.pushurl')
      await gitIn(repos.store, 'remote', 'set-url', '--add', '--push', 'origin', repos.privateBare)
      await gitIn(repos.store, 'remote', 'set-url', '--add', '--push', 'origin', repos.publicBare)
      await blocked('one of two pushurls')

      // A GitHub push URL naming the publicRepo slug (o/stars) in another letter case.
      await gitIn(repos.store, 'config', '--unset-all', 'remote.origin.pushurl')
      await gitIn(repos.store, 'remote', 'set-url', '--push', 'origin', 'https://github.com/O/STARS.git')
      await blocked('slug pushurl')

      // An ssh push URL whose host is in capitals still names the public repository.
      await gitIn(repos.store, 'remote', 'set-url', '--push', 'origin', 'ssh://git@GITHUB.COM/o/stars.git')
      await blocked('uppercase host pushurl')
      await gitIn(repos.store, 'remote', 'set-url', '--push', 'origin', 'ssh://git@ssh.github.com:443/o/stars.git')
      await blocked('ssh over port 443 pushurl')

      // A push URL that is the private repository itself is fine.
      await gitIn(repos.store, 'remote', 'set-url', '--push', 'origin', repos.privateBare)
      const ok = await run(setup(repos).options)
      assert.equal(ok.ok, true, JSON.stringify(ok.steps, null, 2))
    })
  })

  it('a store that fails the check step (broken JSON) is never committed or pushed; the Heartbeat stays local', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const privateMain = (await gitIn(repos.privateBare, 'rev-parse', 'main')).trim()
      const publicRefs = async () => (await gitIn(repos.publicBare, 'for-each-ref', '--format=%(refname) %(objectname)')).trim()
      const refsBefore = await publicRefs()
      await writeFile(join(repos.store, 'classifications.json'), '{ "schemaVersion": 1, "classifications": {')
      const r = await run(setup(repos, { push: true, prDryRun: true }).options)
      assert.equal(r.ok, false)
      assert.equal(status(r).check, 'failed')
      assert.equal(status(r).heartbeat, 'skipped')
      assert.deepEqual([r.private.commits, r.private.pushed], [[], false])
      assert.equal((await gitIn(repos.privateBare, 'rev-parse', 'main')).trim(), privateMain, 'the private remote got no commit')
      assert.equal((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim(), '1', 'no local store commit')
      assert.equal(await publicRefs(), refsBefore)
      assert.equal((await loadHeartbeat(repos.store))?.result, 'failed', 'the Heartbeat is written locally')
    })
  })

  it('a store that fails the check after classifying is never committed or pushed; the Heartbeat stays local', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const privateMain = (await gitIn(repos.privateBare, 'rev-parse', 'main')).trim()
      const classify: RunDeps['classify'] = async (store) => {
        await writeFile(join(store, 'classifications.json'), '{ "schemaVersion": 1, "classifications": {')
        return { apply: undefined } as unknown as Awaited<ReturnType<RunDeps['classify']>>
      }
      const r = await run(setup(repos, { push: true, prDryRun: true }, { classify }).options)
      assert.equal(r.ok, false)
      assert.equal(status(r).check, 'ok')
      assert.equal(status(r).classify, 'failed')
      assert.equal((await gitIn(repos.privateBare, 'rev-parse', 'main')).trim(), privateMain, 'the private remote got no commit')
      assert.equal((await gitIn(repos.store, 'rev-list', '--count', 'HEAD')).trim(), '1', 'no local store commit')
      assert.equal((await loadHeartbeat(repos.store))?.result, 'failed', 'the Heartbeat is written locally')
    })
  })

  it('a store inside the public clone: nothing is written there, not even the Heartbeat', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const store = join(repos.pub, 'data')
      await gitIn(repos.store, 'mv', 'items', join(repos.store, 'items-moved'))
      const { mkdir, cp } = await import('node:fs/promises')
      await mkdir(store, { recursive: true })
      await cp(join(repos.store, 'items-moved'), join(store, 'items'), { recursive: true })
      await writeFile(join(store, 'categories.json'), await readFile(join(repos.store, 'categories.json'), 'utf8'))
      const before = (await gitIn(repos.pub, 'status', '--porcelain', '--untracked-files=all')).trim().split('\n').sort()
      const r = await run(setup(repos, { store }).options)
      assert.equal(r.ok, false)
      assert.match(r.steps.find((x) => x.name === 'check')!.error!, /inside the public clone/)
      assert.equal(status(r).heartbeat, 'skipped')
      assert.equal(await stat(join(store, 'heartbeat.json')).catch(() => undefined), undefined)
      const after = (await gitIn(repos.pub, 'status', '--porcelain', '--untracked-files=all')).trim().split('\n').sort()
      assert.deepEqual(after, before)
    })
  })

  it('a never-pushed branch is pushed as one commit: an Item published locally and then taken back never reaches the remote', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      await run(setup(repos).options)
      assert.match(await gitIn(repos.pub, 'show', `${DAY_BRANCH}:data/items.json`), /acme\/beta/)
      await overrideItem(repos.store, 'github:acme/beta', { visibility: 'private' })
      await run(setup(repos).options)
      assert.equal((await gitIn(repos.pub, 'rev-list', '--count', `main..${DAY_BRANCH}`)).trim(), '2', 'two local commits')
      const r = await run(setup(repos, { push: true, prDryRun: true }).options)
      assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2))
      assert.equal(r.public.pushed, true)
      assert.equal((await gitIn(repos.publicBare, 'rev-list', '--count', `main..${DAY_BRANCH}`)).trim(), '1')
      const history = await gitIn(repos.publicBare, 'log', '--all', '-p')
      assert.ok(!history.includes('acme/beta'), 'the taken-back Item is nowhere in the remote history')
      assert.ok(history.includes('acme/alpha'))
      assert.equal((await gitIn(repos.pub, 'status', '--porcelain')).trim(), '')
    })
  })

  it('squashUnpushed: commits after the pushed tip become one commit on top of it; the pushed history is kept', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const pub = repos.pub
      const commit = async (text: string) => {
        await writeFile(join(pub, 'README.md'), text)
        await gitIn(pub, 'add', 'README.md')
        await gitIn(pub, 'commit', '--quiet', '-m', text)
      }
      await gitIn(pub, 'checkout', '--quiet', '-b', 'starsieve/x')
      await commit('pushed')
      await gitIn(pub, 'push', '--quiet', '-u', 'origin', 'starsieve/x')
      const pushed = (await gitIn(pub, 'rev-parse', 'HEAD')).trim()
      await commit('taken back later')
      await commit('current')
      const tip = await squashUnpushed(pub, 'starsieve/x', 'origin/main', 'squashed')
      assert.ok(tip)
      assert.equal((await gitIn(pub, 'rev-parse', `${tip}^`)).trim(), pushed)
      assert.equal(await gitIn(pub, 'show', `${tip}:README.md`), 'current')
      assert.equal(await readFile(join(pub, 'README.md'), 'utf8'), 'current')
      assert.ok(!(await gitIn(pub, 'log', '-p', 'starsieve/x')).includes('taken back later'))
      // One commit straight on the pushed tip: left alone.
      await gitIn(pub, 'push', '--quiet', 'origin', 'starsieve/x')
      await commit('one more')
      assert.equal(await squashUnpushed(pub, 'starsieve/x', 'origin/main', 'squashed'), undefined)
    })
  })

  it('squashUnpushed refuses unpushed commits that change files outside the published paths, and leaves the branch as it is', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const pub = repos.pub
      const commit = async (file: string, text: string) => {
        await writeFile(join(pub, file), text)
        await gitIn(pub, 'add', file)
        await gitIn(pub, 'commit', '--quiet', '-m', text)
      }
      await gitIn(pub, 'checkout', '--quiet', '-b', 'starsieve/y')
      await commit('README.md', 'first')
      await commit('.github/scripts/validate.mjs', '// CI fix\n')
      await commit('README.md', 'second')
      const before = (await gitIn(pub, 'rev-parse', 'HEAD')).trim()
      await assert.rejects(squashUnpushed(pub, 'starsieve/y', 'origin/main', 'squashed'), /outside data, README\.md, docs \(\.github\/scripts\/validate\.mjs\)/)
      assert.equal((await gitIn(pub, 'rev-parse', 'starsieve/y')).trim(), before, 'the branch is untouched')
      assert.equal(await readFile(join(pub, '.github/scripts/validate.mjs'), 'utf8'), '// CI fix\n')
      assert.equal((await gitIn(pub, 'status', '--porcelain')).trim(), '')
    })
  })

  it('squashUnpushed refuses a branch that has diverged from its pushed copy instead of rebuilding it on main', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const pub = repos.pub
      const commit = async (text: string) => {
        await writeFile(join(pub, 'README.md'), text)
        await gitIn(pub, 'add', 'README.md')
        await gitIn(pub, 'commit', '--quiet', '-m', text)
      }
      await gitIn(pub, 'checkout', '--quiet', '-b', 'starsieve/z')
      await commit('pushed')
      await gitIn(pub, 'push', '--quiet', '-u', 'origin', 'starsieve/z')
      await gitIn(pub, 'reset', '--quiet', '--hard', 'origin/main')
      await commit('local one')
      await commit('local two')
      const before = (await gitIn(pub, 'rev-parse', 'HEAD')).trim()
      await assert.rejects(squashUnpushed(pub, 'starsieve/z', 'origin/main', 'squashed'), /have diverged/)
      assert.equal((await gitIn(pub, 'rev-parse', 'starsieve/z')).trim(), before)
    })
  })

  it('squashUnpushed onto a main that moved on (outside the published paths) keeps main as it is now', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const pub = repos.pub
      await gitIn(pub, 'checkout', '--quiet', '-b', 'starsieve/w')
      for (const text of ['one', 'two']) {
        await writeFile(join(pub, 'README.md'), text)
        await gitIn(pub, 'add', 'README.md')
        await gitIn(pub, 'commit', '--quiet', '-m', text)
      }
      await gitIn(pub, 'checkout', '--quiet', 'main')
      await writeFile(join(pub, '.github/scripts/validate.mjs'), '// newer on main\n')
      await gitIn(pub, 'commit', '--quiet', '-am', 'ci on main')
      await gitIn(pub, 'push', '--quiet', 'origin', 'main')
      await gitIn(pub, 'checkout', '--quiet', 'starsieve/w')
      const tip = await squashUnpushed(pub, 'starsieve/w', 'origin/main', 'squashed')
      assert.ok(tip)
      assert.equal((await gitIn(pub, 'rev-parse', `${tip}^`)).trim(), (await gitIn(pub, 'rev-parse', 'origin/main')).trim())
      assert.equal(await gitIn(pub, 'show', `${tip}:README.md`), 'two')
      assert.equal(await gitIn(pub, 'show', `${tip}:.github/scripts/validate.mjs`), '// newer on main\n')
      assert.equal((await gitIn(pub, 'status', '--porcelain')).trim(), '')
    })
  })

  it('run: a refused squash fails the public step, pushes nothing, and keeps the local day branch with its commits', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      await run(setup(repos).options)
      await gitIn(repos.pub, 'checkout', '--quiet', DAY_BRANCH)
      await writeFile(join(repos.pub, '.github/scripts/validate.mjs'), '// CI fix\n')
      await gitIn(repos.pub, 'commit', '--quiet', '-am', 'ci fix')
      await gitIn(repos.pub, 'checkout', '--quiet', 'main')
      const { options, setStars } = setup(repos, { push: true, prDryRun: true })
      setStars([...STARS, star('acme/gamma', { starred_at: '2026-11-20T00:00:00Z' })])
      const r = await run(options)
      assert.equal(status(r).public, 'failed')
      assert.match(r.steps.find((x) => x.name === 'public')!.error!, /outside data, README\.md, docs/)
      assert.equal(r.public.pushed, false)
      assert.equal((await gitIn(repos.publicBare, 'branch', '--list')).includes('starsieve/'), false, 'nothing pushed')
      const history = (await gitIn(repos.pub, 'log', '--format=%s', DAY_BRANCH)).split('\n')
      assert.ok(history.includes('ci fix'), 'the CI commit is still on the branch')
      assert.equal((await gitIn(repos.pub, 'branch', '--show-current')).trim(), 'main')
      assert.equal((await gitIn(repos.pub, 'status', '--porcelain')).trim(), '')
    })
  })

  it('a failure after the public steps keeps changes the run did not make in the public clone, and reports them', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      // GitHub reports another head, so the pr step fails; meanwhile the owner edits the clone.
      const gh = fakeGh([], { prHead: async () => 'a'.repeat(40) })
      const { options } = setup(repos, { push: true }, {
        gh: async (cmd, args, o) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            await writeFile(join(repos.pub, 'README.md'), 'owner edit\n')
            await writeFile(join(repos.pub, 'data/note.txt'), 'owner note\n')
          }
          return gh.exec(cmd, args, o)
        },
      })
      const r = await run(options)
      assert.equal(status(r).pr, 'failed')
      assert.equal(r.ok, false)
      assert.equal(await readFile(join(repos.pub, 'README.md'), 'utf8'), 'owner edit\n')
      assert.equal(await readFile(join(repos.pub, 'data/note.txt'), 'utf8'), 'owner note\n')
      const restore = r.steps.find((x) => x.name === 'restore-public')
      assert.equal(restore?.status, 'failed')
      assert.match(restore!.error!, /not rolled back.*README\.md/)
      assert.match(restore!.error!, /data\/note\.txt/)
      assert.match(await readFile(r.logPath, 'utf8'), /not rolled back, changes this run did not make/)
      // The run's own commit stays on the day branch.
      assert.match(await gitIn(repos.pub, 'log', '-1', '--format=%s', DAY_BRANCH), /starsieve: publish/)
    })
  })

  it('a failure with no outside changes undoes what the run wrote: the public clone is back on its branch and clean', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const tracked = (await gitIn(repos.pub, 'ls-files')).trim()
      // The private push fails, so the public files written by publish and site are still uncommitted.
      await gitIn(repos.store, 'remote', 'set-url', 'origin', join(dir, 'missing.git'))
      const r = await run(setup(repos, { push: true, prDryRun: true }).options)
      assert.equal(status(r).private, 'failed')
      assert.equal(status(r).public, 'skipped')
      assert.equal(r.steps.some((x) => x.name === 'restore-public'), false)
      assert.equal((await gitIn(repos.pub, 'branch', '--show-current')).trim(), 'main')
      assert.equal((await gitIn(repos.pub, 'status', '--porcelain', '--untracked-files=all')).trim(), '')
      assert.equal((await gitIn(repos.pub, 'branch', '--list', 'starsieve/*')).trim(), '')
      assert.equal((await gitIn(repos.pub, 'ls-files')).trim(), tracked)
      await assert.rejects(stat(join(repos.pub, 'docs/index.html')), /ENOENT/, 'the page site build wrote is gone')
    })
  })

  it('a step that fails before writing a file never claims it: an owner edit made meanwhile is kept and reported', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      // site cannot read its stylesheet, so it fails before writing index.html; the owner saves one as it starts.
      const { options } = setup(repos, {
        css: join(dir, 'missing.css'),
        echo: (line) => {
          if (line.includes('site: start')) {
            mkdirSync(join(repos.pub, 'docs'), { recursive: true })
            writeFileSync(join(repos.pub, 'docs/index.html'), '<p>owner page</p>\n')
          }
        },
      })
      const r = await run(options)
      assert.equal(status(r).site, 'failed')
      assert.equal(await readFile(join(repos.pub, 'docs/index.html'), 'utf8'), '<p>owner page</p>\n')
      // What publish did write is undone (main has no README.md).
      await assert.rejects(stat(join(repos.pub, 'README.md')), /ENOENT/)
      const restore = r.steps.find((x) => x.name === 'restore-public')
      assert.match(restore?.error ?? '', /docs\/index\.html \(not written by this run\)/)
      const hb = (await loadHeartbeat(repos.store))!
      assert.match(hb.steps.find((x) => x.name === 'restore-public')?.error ?? '', /docs\/index\.html/)
    })
  })

  it("never reuses or merges another repository's PR, and merges only at the commit it pushed", async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const fork = { url: 'https://github.com/o/stars/pull/3', headRefName: DAY_BRANCH, headRefOid: 'f'.repeat(40), isCrossRepository: true, headRepositoryOwner: { login: 'evil' } }
      const gh = fakeGh([], { prList: [fork], prHead: remoteHead(repos) })
      const { options } = setup(repos, { push: true }, { gh: gh.exec })
      const r = await run(options)
      assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2))
      const list = gh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'list')!
      assert.deepEqual(list.args.slice(list.args.indexOf('--author'), list.args.indexOf('--author') + 2), ['--author', '@me'])
      assert.ok(gh.calls.some((c) => c.args[1] === 'create'), 'opened its own PR')
      const merge = gh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge')!
      assert.equal(merge.args[2], 'https://github.com/o/stars/pull/7')
      const pushed = (await gitIn(repos.publicBare, 'rev-parse', DAY_BRANCH)).trim()
      assert.equal(merge.args[merge.args.indexOf('--match-head-commit') + 1], pushed)

      // GitHub reports another head: no merge.
      await overrideItem(repos.store, 'github:acme/alpha', { summary: 'moved on' })
      const other = fakeGh([], { prHead: async () => 'a'.repeat(40) })
      const r2 = await run(setup(repos, { push: true }, { gh: other.exec }).options)
      assert.equal(status(r2).pr, 'failed')
      assert.match(r2.steps.find((x) => x.name === 'pr')!.error!, /not merging it/)
      assert.ok(!other.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge'))
    })
  })

  it('only one run at a time', async () => {
    await withDir(async (dir) => {
      const repos = await makeRepos(dir, STARS)
      const lock = join(dir, 'logs', 'run.lock')
      const release = await acquireLock(lock)
      await assert.rejects(run(setup(repos).options), LockedError)
      await release()
      // A lock left by a process that is gone is taken over.
      await acquireLock(lock, 999_999)
      const r = await run(setup(repos).options)
      assert.equal(r.ok, true)
    })
  })
})

/** A clone with README.md committed as `head\n`. */
async function headRepo(dir: string): Promise<string> {
  const repo = join(dir, 'clone')
  await mkdir(repo)
  await gitIn(repo, 'init', '--quiet', '-b', 'main')
  await gitIn(repo, 'config', 'user.name', 'starsieve test')
  await gitIn(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'README.md'), 'head\n')
  await gitIn(repo, 'add', '-A')
  await gitIn(repo, 'commit', '--quiet', '-m', 'initial')
  return repo
}

describe('rollbackWrites', () => {
  it('undoes the run\'s own writes, staged or not, and leaves the clone clean', async () => {
    await withDir(async (dir) => {
      const repo = await headRepo(dir)
      await writeFile(join(repo, 'README.md'), 'run\n')
      await mkdir(join(repo, 'data'))
      await writeFile(join(repo, 'data/items.json'), '{}\n')
      // The run staged both (its commit then failed).
      await gitIn(repo, 'add', '-A')
      const written = new Map([['README.md', blobHash('run\n')], ['data/items.json', blobHash('{}\n')]])
      const r = await rollbackWrites(repo, written)
      assert.deepEqual([r.reverted.sort(), r.kept], [['README.md', 'data/items.json'], []])
      assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'head\n')
      await assert.rejects(stat(join(repo, 'data')), /ENOENT/)
      assert.equal((await gitIn(repo, 'status', '--porcelain', '--untracked-files=all')).trim(), '')
    })
  })

  it('keeps a version the owner staged while the working tree still holds what the run wrote', async () => {
    await withDir(async (dir) => {
      const repo = await headRepo(dir)
      await writeFile(join(repo, 'README.md'), 'owner staged\n')
      await gitIn(repo, 'add', 'README.md')
      await writeFile(join(repo, 'README.md'), 'run\n')
      const r = await rollbackWrites(repo, new Map([['README.md', blobHash('run\n')]]))
      assert.deepEqual(r.reverted, [])
      assert.deepEqual(r.kept, [{ path: 'README.md', reason: 'another version of it is staged' }])
      assert.equal(await gitIn(repo, 'show', ':README.md'), 'owner staged\n')
      assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'run\n')
    })
  })

  it('checks each file again right before restoring or removing it, and keeps an owner save made in between', async () => {
    await withDir(async (dir) => {
      const repo = await headRepo(dir)
      await writeFile(join(repo, 'README.md'), 'run\n')
      await writeFile(join(repo, 'new.json'), 'run new\n')
      const written = new Map([['README.md', blobHash('run\n')], ['new.json', blobHash('run new\n')]])
      const r = await rollbackWrites(repo, written, {
        beforeRestore: (path) => writeFile(join(repo, path), `owner ${path}\n`),
      })
      assert.deepEqual(r.reverted, [])
      assert.deepEqual(r.kept.map((k) => k.reason), ['changed while it was being rolled back', 'changed while it was being rolled back'])
      assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'owner README.md\n')
      assert.equal(await readFile(join(repo, 'new.json'), 'utf8'), 'owner new.json\n')
    })
  })
})
