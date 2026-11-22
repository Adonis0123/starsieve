#!/usr/bin/env node
// Heartbeat check for the private starsieve repository, run by .github/workflows/heartbeat.yml every 6 hours.
// Zero dependencies; written by `starsieve init data`. Opens one issue when the last successful run is older than
// 48 hours (never a second while one is open) and closes it once a run succeeds again.
//
//   node .github/scripts/heartbeat-check.mjs [--heartbeat <file>]   (needs gh and GH_TOKEN)
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const STALE_HOURS = 48
export const TITLE = 'starsieve: no successful run for 48 hours'

/** Pure: what to do, given the heartbeat file's content (or undefined), the time, and the open issues with TITLE. */
export function decide(heartbeat, now, openIssues) {
  const last = heartbeat && typeof heartbeat.lastSuccessAt === 'string' ? Date.parse(heartbeat.lastSuccessAt) : Number.NaN
  const hours = Number.isNaN(last) ? Number.POSITIVE_INFINITY : (now.getTime() - last) / 3_600_000
  const stale = hours > STALE_HOURS
  if (stale && openIssues.length === 0) {
    const since = Number.isNaN(last) ? 'never' : heartbeat.lastSuccessAt
    const attempt = heartbeat?.lastAttemptAt ?? 'never'
    const failedSteps = (heartbeat?.steps ?? []).filter((s) => s.status === 'failed').map((s) => `- ${s.name}: ${s.error ?? ''}`)
    const body = [
      `The last successful \`starsieve run\` was ${since}; the last attempt was ${attempt}.`,
      '',
      ...(failedSteps.length ? ['Failed steps in the last attempt:', ...failedSteps, ''] : []),
      'Check that the Mac is on, `starsieve schedule status`, and the log in ~/Library/Logs/starsieve/.',
      'This issue closes itself after the next successful run.',
    ].join('\n')
    return { action: 'create', stale, hours, body }
  }
  if (!stale && openIssues.length > 0) return { action: 'close', stale, hours, numbers: openIssues.map((i) => i.number) }
  return { action: 'none', stale, hours }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function main(argv) {
  const at = argv.indexOf('--heartbeat')
  const path = at === -1 ? 'heartbeat.json' : argv[at + 1]
  let heartbeat
  try {
    heartbeat = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    heartbeat = undefined
  }
  const listed = JSON.parse(gh(['issue', 'list', '--state', 'open', '--search', `in:title "${TITLE}"`, '--json', 'number,title', '--limit', '20']))
  const open = listed.filter((i) => i.title === TITLE)
  const d = decide(heartbeat, new Date(), open)
  if (d.action === 'create') gh(['issue', 'create', '--title', TITLE, '--body', d.body])
  if (d.action === 'close') for (const n of d.numbers) gh(['issue', 'close', String(n), '--comment', 'A run succeeded again; closing.'])
  process.stdout.write(`last success ${Number.isFinite(d.hours) ? `${d.hours.toFixed(1)} h ago` : 'never'}: ${d.action}\n`)
  return 0
}

const entry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (entry) process.exitCode = main(process.argv.slice(2))
