// The LaunchAgent: plist content, install (bootout then bootstrap), status and uninstall, with a fake launchctl.
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Exec } from '../run/exec.ts'
import { withDir } from '../testing/fixtures.ts'
import { install, LABEL, loginShellPath, plistPath, programArguments, status, uninstall } from './launchd.ts'

const LEGACY = 'com.adonis.starsieve'

/** launchctl with the given labels loaded; `print` answers only for those. */
function fakeLaunchctl(printOut = '', loaded: string[] = [LABEL]) {
  const calls: string[][] = []
  const exec: Exec = async (_cmd, args) => {
    calls.push([...args])
    const label = args[1]?.split('/')[2]
    if (args[0] === 'print') return printOut && label && loaded.includes(label) ? { code: 0, stdout: printOut, stderr: '' } : { code: 113, stdout: '', stderr: 'not found' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

async function writeLegacyPlist(home: string): Promise<string> {
  const file = plistPath(home, LEGACY)
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(file, `<plist><dict><key>Label</key><string>${LEGACY}</string><array><string>--no-push</string></array></dict></plist>\n`)
  return file
}

describe('schedule', () => {
  it('writes a plist that runs "run --no-push" daily at 08:17 with the login PATH, not at load', async () => {
    await withDir(async (dir) => {
      const lc = fakeLaunchctl()
      const r = await install({
        repoDir: '/repo/starsieve',
        nodePath: '/opt/node/bin/node',
        logDir: join(dir, 'Logs'),
        push: false,
        maxBatches: 4,
        home: dir,
        uid: 501,
        launchctl: lc.exec,
        loginPath: async () => '/opt/homebrew/bin:/home/me/.local/bin:/usr/bin:/bin',
      })
      assert.equal(r.plist, plistPath(dir))
      const xml = await readFile(r.plist, 'utf8')
      for (const want of [
        `<string>${LABEL}</string>`,
        '<string>/opt/node/bin/node</string>\n    <string>/repo/starsieve/src/cli/main.ts</string>\n    <string>run</string>\n    <string>--no-push</string>\n    <string>--max-batches</string>\n    <string>4</string>',
        '<key>PATH</key>\n    <string>/opt/homebrew/bin:/home/me/.local/bin:/usr/bin:/bin</string>',
        '<key>WorkingDirectory</key>\n  <string>/repo/starsieve</string>',
        '<key>Hour</key>\n    <integer>8</integer>\n    <key>Minute</key>\n    <integer>17</integer>',
        '<key>RunAtLoad</key>\n  <false/>',
        `<string>${join(dir, 'Logs', 'launchd.out.log')}</string>`,
        `<string>${join(dir, 'Logs', 'launchd.err.log')}</string>`,
      ]) {
        assert.ok(xml.includes(want), want)
      }
      assert.deepEqual(lc.calls, [
        ['bootout', `gui/501/${LEGACY}`],
        ['bootout', `gui/501/${LABEL}`],
        ['bootstrap', 'gui/501', r.plist],
      ])
      assert.deepEqual(r.legacyRemoved, [])
      assert.ok((await stat(join(dir, 'Logs'))).isDirectory())
    })
  })

  it('without --no-push once schedulePush is true', () => {
    assert.deepEqual(programArguments({ repoDir: '/r', nodePath: 'node', push: true }), ['node', '/r/src/cli/main.ts', 'run'])
  })

  it('status reads launchctl print; uninstall boots out and removes the plist', async () => {
    await withDir(async (dir) => {
      const lc = fakeLaunchctl(`gui/501/${LABEL} = {\n\tstate = not running\n\truns = 2\n\tlast exit code = 0\n}`)
      await install({ repoDir: '/r', logDir: join(dir, 'L'), push: false, home: dir, uid: 501, launchctl: lc.exec, loginPath: async () => '/usr/bin' })
      const s = await status({ home: dir, uid: 501, launchctl: lc.exec })
      assert.deepEqual([s.installed, s.loaded, s.noPush, s.state, s.runs, s.lastExitCode, s.legacy], [true, true, true, 'not running', 2, '0', false])
      const u = await uninstall({ home: dir, uid: 501, launchctl: lc.exec })
      assert.equal(u.removed, true)
      assert.equal(await stat(u.plist).catch(() => undefined), undefined)
    })
  })

  it('uses a neutral label; install boots out and removes a job left under the legacy label', async () => {
    assert.equal(LABEL, 'io.github.starsieve')
    await withDir(async (dir) => {
      const legacy = await writeLegacyPlist(dir)
      const lc = fakeLaunchctl()
      const r = await install({ repoDir: '/r', logDir: join(dir, 'L'), push: false, home: dir, uid: 501, launchctl: lc.exec, loginPath: async () => '/usr/bin' })
      assert.deepEqual(r.legacyRemoved, [legacy])
      assert.equal(await stat(legacy).catch(() => undefined), undefined)
      assert.ok((await readFile(plistPath(dir), 'utf8')).includes(`<string>${LABEL}</string>`))
      // The legacy job is gone before the new one is loaded, so the two never both run.
      const order = lc.calls.map((c) => c.join(' '))
      assert.ok(order.indexOf(`bootout gui/501/${LEGACY}`) < order.indexOf(`bootstrap gui/501 ${r.plist}`))
    })
  })

  it('status and uninstall find a plist installed under the legacy label', async () => {
    await withDir(async (dir) => {
      const legacy = await writeLegacyPlist(dir)
      const lc = fakeLaunchctl(`gui/501/${LEGACY} = {\n\tstate = not running\n\truns = 5\n}`, [LEGACY])
      const s = await status({ home: dir, uid: 501, launchctl: lc.exec })
      assert.deepEqual([s.plist, s.label, s.legacy, s.installed, s.loaded, s.runs, s.noPush], [legacy, LEGACY, true, true, true, 5, true])
      const u = await uninstall({ home: dir, uid: 501, launchctl: lc.exec })
      assert.deepEqual([u.removed, u.legacyRemoved], [true, [legacy]])
      assert.ok(lc.calls.some((c) => c.join(' ') === `bootout gui/501/${LEGACY}`))
      assert.equal(await stat(legacy).catch(() => undefined), undefined)
      const after = await status({ home: dir, uid: 501, launchctl: lc.exec })
      assert.deepEqual([after.installed, after.legacy], [false, false])
    })
  })

  it('takes PATH from the login shell output, ignoring other lines', async () => {
    const fake: Exec = async () => ({ code: 0, stdout: 'welcome!\n__STARSIEVE_PATH__/a:/b\n', stderr: '' })
    assert.equal(await loginShellPath(fake, '/bin/zsh'), '/a:/b')
  })
})
