// Stable JSON on disk: sorted object keys, two-space indent, trailing newline, atomic replace.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

/** Compact canonical form used for hashing. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`)
  }
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, text)
  await rename(tmp, path)
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, stableStringify(value))
}
