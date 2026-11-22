// The LaunchAgent: plist content, install (bootout then bootstrap), status and uninstall, with a fake launchctl.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Exec } from '../run/exec.ts'
import { withDir } from '../testing/fixtures.ts'
import { install, LABEL, loginShellPath, plistPath, programArguments, status, uninstall } from './launchd.ts'

function fakeLaunchctl(printOut = '') {
  const calls: string[][] = []
  const exec: Exec = async (_cmd, args) => {
    calls.push([...args])
    if (args[0] === 'print') return printOut ? { code: 0, stdout: printOut, stderr: '' } : { code: 113, stdout: '', stderr: 'not found' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
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
        loginPath: async () => '/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin',
      })
      assert.equal(r.plist, plistPath(dir))
      const xml = await readFile(r.plist, 'utf8')
      for (const want of [
        `<string>${LABEL}</string>`,
        '<string>/opt/node/bin/node</string>\n    <string>/repo/starsieve/src/cli/main.ts</string>\n    <string>run</string>\n    <string>--no-push</string>\n    <string>--max-batches</string>\n    <string>4</string>',
        '<key>PATH</key>\n    <string>/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin</string>',
        '<key>WorkingDirectory</key>\n  <string>/repo/starsieve</string>',
        '<key>Hour</key>\n    <integer>8</integer>\n    <key>Minute</key>\n    <integer>17</integer>',
        '<key>RunAtLoad</key>\n  <false/>',
        `<string>${join(dir, 'Logs', 'launchd.out.log')}</string>`,
        `<string>${join(dir, 'Logs', 'launchd.err.log')}</string>`,
      ]) {
        assert.ok(xml.includes(want), want)
      }
      assert.deepEqual(lc.calls, [
        ['bootout', `gui/501/${LABEL}`],
        ['bootstrap', 'gui/501', r.plist],
      ])
      assert.ok((await stat(join(dir, 'Logs'))).isDirectory())
    })
  })

  it('without --no-push once schedulePush is true', () => {
    assert.deepEqual(programArguments({ repoDir: '/r', nodePath: 'node', push: true }), ['node', '/r/src/cli/main.ts', 'run'])
  })

  it('status reads launchctl print; uninstall boots out and removes the plist', async () => {
    await withDir(async (dir) => {
      const lc = fakeLaunchctl('gui/501/com.adonis.starsieve = {\n\tstate = not running\n\truns = 2\n\tlast exit code = 0\n}')
      await install({ repoDir: '/r', logDir: join(dir, 'L'), push: false, home: dir, uid: 501, launchctl: lc.exec, loginPath: async () => '/usr/bin' })
      const s = await status({ home: dir, uid: 501, launchctl: lc.exec })
      assert.deepEqual([s.installed, s.loaded, s.noPush, s.state, s.runs, s.lastExitCode], [true, true, true, 'not running', 2, '0'])
      const u = await uninstall({ home: dir, uid: 501, launchctl: lc.exec })
      assert.equal(u.removed, true)
      assert.equal(await stat(u.plist).catch(() => undefined), undefined)
    })
  })

  it('takes PATH from the login shell output, ignoring other lines', async () => {
    const fake: Exec = async () => ({ code: 0, stdout: 'welcome!\n__STARSIEVE_PATH__/a:/b\n', stderr: '' })
    assert.equal(await loginShellPath(fake, '/bin/zsh'), '/a:/b')
  })
})
