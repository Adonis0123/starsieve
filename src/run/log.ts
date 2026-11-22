// The run log: ~/Library/Logs/starsieve/run-YYYYMMDD.log, appended line by line so a crash keeps what was written.
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STARSIEVE_LOG_DIR || join(homedir(), 'Library', 'Logs', 'starsieve')
}

/** Local date as YYYYMMDD (the owner's day, not UTC). */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export interface RunLog {
  path: string
  line: (message: string) => void
}

export function openRunLog(dir: string, now: () => Date, echo?: (s: string) => void): RunLog {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `run-${localDay(now())}.log`)
  return {
    path,
    line(message) {
      const text = `[${now().toISOString()}] ${message}`
      appendFileSync(path, `${text}\n`)
      echo?.(text)
    },
  }
}
