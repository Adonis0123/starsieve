// Child processes for run, lists sync and schedule: one result shape, and a non-zero exit is a value, not a throw.
import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  input?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** A command runner; tests pass a fake for `gh` and `launchctl`. */
export type Exec = (cmd: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>

export const exec: Exec = (cmd, args, options = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs) : undefined
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      done({ code: 127, stdout, stderr: `cannot start ${cmd}: ${e.message}` })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr })
    })
    child.stdin.end(options.input ?? '')
  })

/** The last lines of stderr (or stdout), for an error message. */
export function tail(r: ExecResult, lines = 5): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-lines).join('\n')
}
