// Heartbeat: <store>/heartbeat.json, the last attempted and last successful run with each step's result.
// The private repository's CI reads lastSuccessAt and opens an issue after 48 hours without one.
import { readJson, writeJson } from '../core/json.ts'
import { paths } from '../core/store.ts'
import { SCHEMA_VERSION } from '../core/types.ts'

export type StepStatus = 'ok' | 'failed' | 'skipped' | 'timeout' | 'dry-run'

export interface StepResult {
  name: string
  status: StepStatus
  ms: number
  /** What the step did, in a few words. */
  detail?: string
  error?: string
}

export interface Heartbeat {
  schemaVersion: number
  lastAttemptAt: string
  /** null until the first run where no step failed. */
  lastSuccessAt: string | null
  /** The last run: `success`, `failed`, or `running` while it is in progress. */
  result: 'success' | 'failed' | 'running'
  /** The last run found nothing new to classify or publish and only wrote this file. */
  nothingNew: boolean
  steps: StepResult[]
}

export async function loadHeartbeat(storeDir: string): Promise<Heartbeat | undefined> {
  return readJson<Heartbeat>(paths.heartbeat(storeDir))
}

export async function saveHeartbeat(storeDir: string, hb: Omit<Heartbeat, 'schemaVersion'>): Promise<void> {
  await writeJson(paths.heartbeat(storeDir), { schemaVersion: SCHEMA_VERSION, ...hb })
}
