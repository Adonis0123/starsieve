#!/usr/bin/env node
// Required check for the public starsieve repository: the second line of defense after `starsieve publish` (ADR 0002).
// Zero dependencies; written by `starsieve init data`. CI runs the copy from the base branch against the PR's files.
//
//   node .github/scripts/validate.mjs [--root <dir>] [--items <file>] [--base <git ref>]
//
// --items: the file to check (default <root>/data/items.json). --base: also check that the PR changed only data/,
// README.md and docs/. Exit 0 when valid, 1 with one line per problem otherwise.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1
export const MAX_SUMMARY = 80
export const MAX_TAGS = 6
export const ALLOWED_PATHS = [/^data\//, /^README\.md$/, /^docs\//]
export const GITHUB_KEYS = ['addedAt', 'archived', 'category', 'description', 'id', 'language', 'name', 'needsReview', 'stargazers', 'starredAt', 'summary', 'tags', 'topics', 'url']
export const X_KEYS = ['addedAt', 'author', 'category', 'needsReview', 'postedAt', 'summary', 'tags', 'url']
/** Fields of the Private Store that must never be public: Visibility, private-repository marks, X post text, store internals. */
export const FORBIDDEN_KEYS = ['visibility', 'repoPrivate', 'private', 'text', 'textEmpty', 'hasMedia', 'signals', 'collectedAt', 'locked', 'by', 'inputHash']

const LINK_OR_HTML = /https?:\/\/|www\.|<\/?[a-z!][^>]*>/i
const isString = (v) => typeof v === 'string'
const isDate = (v) => isString(v) && !Number.isNaN(Date.parse(v))

/** Problems in one items.json document; empty when it is valid. */
export function validateDoc(doc) {
  const errors = []
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['items.json must be a JSON object']
  if (doc.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(doc.schemaVersion)}`)
  for (const key of Object.keys(doc)) if (key !== 'schemaVersion' && key !== 'items') errors.push(`unexpected top-level field ${key}`)
  if (!Array.isArray(doc.items)) return [...errors, 'items must be an array']
  const seen = new Set()
  doc.items.forEach((item, i) => {
    const at = `items[${i}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} must be an object`)
      return
    }
    const github = 'id' in item
    const name = `${at} (${github ? item.id : item.url})`
    for (const key of FORBIDDEN_KEYS) if (key in item) errors.push(`${name} has ${key}: private data must never be published`)
    const allowed = github ? GITHUB_KEYS : X_KEYS
    for (const key of Object.keys(item)) if (!allowed.includes(key) && !FORBIDDEN_KEYS.includes(key)) errors.push(`${name} has unexpected field ${key}`)
    for (const key of allowed) if (!(key in item)) errors.push(`${name} is missing ${key}`)

    const key = github ? item.id : item.url
    if (seen.has(key)) errors.push(`${name} appears twice`)
    seen.add(key)

    if (!isString(item.category) || item.category === '') errors.push(`${name}: category must be a non-empty string`)
    if (!Array.isArray(item.tags) || !item.tags.every(isString)) errors.push(`${name}: tags must be an array of strings`)
    else if (item.tags.length > MAX_TAGS) errors.push(`${name}: at most ${MAX_TAGS} tags, got ${item.tags.length}`)
    if (!isString(item.summary)) errors.push(`${name}: summary must be a string`)
    else {
      if ([...item.summary].length > MAX_SUMMARY) errors.push(`${name}: summary is ${[...item.summary].length} characters, at most ${MAX_SUMMARY}`)
      if (LINK_OR_HTML.test(item.summary)) errors.push(`${name}: summary must not contain links or HTML`)
    }
    if (typeof item.needsReview !== 'boolean') errors.push(`${name}: needsReview must be true or false`)
    if (!isDate(item.addedAt)) errors.push(`${name}: addedAt must be a date`)

    if (github) {
      if (!/^github:[\w.-]+\/[\w.-]+$/.test(String(item.id))) errors.push(`${name}: id must be github:owner/name`)
      if (!isString(item.url) || !item.url.startsWith('https://github.com/')) errors.push(`${name}: url must be a https://github.com/ link`)
      if (!Number.isInteger(item.stargazers) || item.stargazers < 0) errors.push(`${name}: stargazers must be a whole number`)
      if (typeof item.archived !== 'boolean') errors.push(`${name}: archived must be true or false`)
      if (!isDate(item.starredAt)) errors.push(`${name}: starredAt must be a date`)
    } else {
      if (!isString(item.url) || !/^https:\/\/x\.com\/[\w]+\/status\/\d+$/.test(item.url)) errors.push(`${name}: url must be an x.com status link`)
      if (!isString(item.author) || item.author === '') errors.push(`${name}: author must be a non-empty string`)
      if (item.postedAt !== null && !isDate(item.postedAt)) errors.push(`${name}: postedAt must be a date or null`)
    }
  })
  return errors
}

/** Problems with the changed paths: the daily PR may only touch the public files starsieve writes. */
export function validatePaths(paths) {
  return paths.filter((p) => !ALLOWED_PATHS.some((re) => re.test(p))).map((p) => `${p}: the PR may change only data/, README.md and docs/`)
}

function main(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--root', '--items', '--base'].includes(argv[i]) || argv[i + 1] === undefined) {
      process.stderr.write('usage: validate.mjs [--root <dir>] [--items <file>] [--base <git ref>]\n')
      return 2
    }
    args.set(argv[i], argv[i + 1])
  }
  const root = resolve(args.get('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
  const itemsPath = resolve(args.get('--items') ?? join(root, 'data', 'items.json'))
  const errors = []
  let doc
  try {
    doc = JSON.parse(readFileSync(itemsPath, 'utf8'))
  } catch (e) {
    errors.push(`cannot read ${itemsPath}: ${e.message}`)
  }
  if (doc !== undefined) errors.push(...validateDoc(doc))
  if (args.has('--base')) {
    const out = execFileSync('git', ['diff', '--name-only', `${args.get('--base')}...HEAD`], { cwd: root, encoding: 'utf8' })
    errors.push(...validatePaths(out.split('\n').filter(Boolean)))
  }
  if (errors.length) {
    for (const e of errors) process.stdout.write(`invalid: ${e}\n`)
    process.stdout.write(`${errors.length} problems; fix them in the Private Store (starsieve override) and publish again.\n`)
    return 1
  }
  process.stdout.write(`valid: ${doc.items.length} items in ${itemsPath}\n`)
  return 0
}

const entry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (entry) process.exitCode = main(process.argv.slice(2))
