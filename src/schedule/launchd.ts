// The LaunchAgent that runs `starsieve run` every day at 08:17 on the owner's Mac (ADR 0003).
// launchd starts jobs with a bare PATH, so install records the login shell's PATH into the plist.
// launchd runs a missed StartCalendarInterval job when the Mac wakes.
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeText } from '../core/json.ts'
import { type Exec, exec as realExec, tail } from '../run/exec.ts'

export const LABEL = 'com.adonis.starsieve'
export const HOUR = 8
export const MINUTE = 17

export interface PlistSpec {
  label: string
  programArguments: string[]
  path: string
  workingDirectory: string
  stdoutPath: string
  stderrPath: string
  hour: number
  minute: number
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

export function plistXml(p: PlistSpec): string {
  const args = p.programArguments.map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(p.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(p.path)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(p.workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${p.hour}</integer>
    <key>Minute</key>
    <integer>${p.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(p.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(p.stderrPath)}</string>
</dict>
</plist>
`
}

export interface ScheduleOptions {
  /** The starsieve checkout (WorkingDirectory; src/cli/main.ts is run from it). */
  repoDir: string
  nodePath?: string
  logDir: string
  /** false: the plist runs `run --no-push` (config `schedulePush`). */
  push: boolean
  maxBatches?: number
  home?: string
  uid?: number
  launchctl?: Exec
  /** The login shell's PATH; defaults to asking $SHELL. */
  loginPath?: () => Promise<string>
}

export function plistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

const MARK = '__STARSIEVE_PATH__'

/**
 * The PATH an interactive login shell sets up (nvm, Homebrew, ~/.local/bin), as a new terminal has it. The shell starts
 * from a bare environment, as launchd would start it, so nothing from the current process (pnpm, node_modules/.bin)
 * leaks into the plist.
 */
export async function loginShellPath(run: Exec = realExec, shell = process.env.SHELL || '/bin/zsh'): Promise<string> {
  const env: NodeJS.ProcessEnv = { HOME: homedir(), USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: shell, TERM: 'dumb', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const flags of [['-l', '-i'], ['-l']]) {
    const r = await run(shell, [...flags, '-c', `printf '${MARK}%s\\n' "$PATH"`], { timeoutMs: 20_000, env })
    const line = `${r.stdout}`.split('\n').find((l) => l.startsWith(MARK))
    if (line && line.length > MARK.length) return line.slice(MARK.length)
  }
  throw new Error(`cannot read PATH from the login shell ${shell}`)
}

export function programArguments(o: Pick<ScheduleOptions, 'repoDir' | 'nodePath' | 'push' | 'maxBatches'>): string[] {
  return [
    o.nodePath ?? process.execPath,
    join(o.repoDir, 'src', 'cli', 'main.ts'),
    'run',
    ...(o.push ? [] : ['--no-push']),
    ...(o.maxBatches ? ['--max-batches', String(o.maxBatches)] : []),
  ]
}

export interface InstallResult {
  plist: string
  programArguments: string[]
  path: string
  push: boolean
}

export async function install(o: ScheduleOptions): Promise<InstallResult> {
  const launchctl = o.launchctl ?? realExec
  const uid = o.uid ?? process.getuid!()
  const file = plistPath(o.home)
  const path = await (o.loginPath ?? (() => loginShellPath()))()
  const args = programArguments(o)
  await mkdir(o.logDir, { recursive: true })
  await writeText(
    file,
    plistXml({
      label: LABEL,
      programArguments: args,
      path,
      workingDirectory: o.repoDir,
      stdoutPath: join(o.logDir, 'launchd.out.log'),
      stderrPath: join(o.logDir, 'launchd.err.log'),
      hour: HOUR,
      minute: MINUTE,
    }),
  )
  // bootout first, so installing again replaces the loaded job instead of failing.
  await launchctl('launchctl', ['bootout', `gui/${uid}/${LABEL}`])
  const r = await launchctl('launchctl', ['bootstrap', `gui/${uid}`, file])
  if (r.code !== 0) throw new Error(`launchctl bootstrap gui/${uid} ${file} failed: ${tail(r)}`)
  return { plist: file, programArguments: args, path, push: o.push }
}

export async function uninstall(o: Pick<ScheduleOptions, 'home' | 'uid' | 'launchctl'>): Promise<{ plist: string; removed: boolean }> {
  const launchctl = o.launchctl ?? realExec
  const uid = o.uid ?? process.getuid!()
  const file = plistPath(o.home)
  await launchctl('launchctl', ['bootout', `gui/${uid}/${LABEL}`])
  const existed = (await readFile(file, 'utf8').catch(() => undefined)) !== undefined
  await rm(file, { force: true })
  return { plist: file, removed: existed }
}

export interface StatusResult {
  plist: string
  installed: boolean
  loaded: boolean
  /** `--no-push` is in the installed command. */
  noPush: boolean | null
  state: string | null
  lastExitCode: string | null
  runs: number | null
}

export async function status(o: Pick<ScheduleOptions, 'home' | 'uid' | 'launchctl'>): Promise<StatusResult> {
  const launchctl = o.launchctl ?? realExec
  const uid = o.uid ?? process.getuid!()
  const file = plistPath(o.home)
  const text = await readFile(file, 'utf8').catch(() => undefined)
  const r = await launchctl('launchctl', ['print', `gui/${uid}/${LABEL}`])
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(r.stdout)?.[1]?.trim() ?? null
  const runs = field('runs')
  return {
    plist: file,
    installed: text !== undefined,
    loaded: r.code === 0,
    noPush: text === undefined ? null : text.includes('<string>--no-push</string>'),
    state: r.code === 0 ? field('state') : null,
    lastExitCode: r.code === 0 ? field('last exit code') : null,
    runs: runs === null ? null : Number(runs),
  }
}
