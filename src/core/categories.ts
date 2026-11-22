// The Category Table: fixed set of Categories shared by every Source.
import { mkdir } from 'node:fs/promises'
import {
  loadCategories,
  loadClassifications,
  requireStore,
  saveCategoriesTable,
  saveClassifications,
  withStoreLock,
} from './store.ts'
import { type Category, type CategoryTable, SCHEMA_VERSION, UNCATEGORIZED } from './types.ts'

/** GitHub allows 32 Lists per user, and every Category with GitHub Items becomes one. */
export const MAX_CATEGORIES = 32

/** By what an Item is for or which field it belongs to; what kind of thing it is goes in its first Tag. */
export const DEFAULT_CATEGORIES: CategoryTable = {
  schemaVersion: SCHEMA_VERSION,
  categories: [
    {
      name: 'AI 编程 Agent',
      nameEn: 'AI coding agents',
      description:
        'Coding agent CLIs and IDEs, agent harnesses, multi-agent and session managers, relays and model switchers for Claude Code, Codex, Cursor, Gemini CLI and similar',
    },
    {
      name: 'Agent 技能与插件',
      nameEn: 'Agent skills and plugins',
      description:
        'Skills, plugins, MCP servers, rules, prompts and AGENTS.md files that extend a coding agent, unless the skill is mainly about video or design (then use that Category)',
    },
    {
      name: 'AI 视频与动画',
      nameEn: 'AI video and animation',
      description:
        'Video creation with AI or code: video generation, editing, motion graphics, animation, stop-motion, Remotion/HyperFrames style code video, video skills, and tutorials or posts teaching how to make videos',
    },
    {
      name: 'AI 图像与设计',
      nameEn: 'AI images and design',
      description: 'Image generation, image prompt libraries, cover and poster tools, UI/UX design methods, design skills and design-to-code',
    },
    {
      name: '前端与 UI',
      nameEn: 'Front end and UI',
      description:
        'Web and mobile front-end: React/Vue/Svelte libraries, UI components, web animation libraries, CSS, editors embedded in pages, browser extensions and templates',
    },
    {
      name: '开发工具与终端',
      nameEn: 'Developer tools and terminals',
      description: 'Developer tooling that is not an AI agent: terminals, editors, bundlers, CLIs, testing, TypeScript utilities, desktop app frameworks',
    },
    {
      name: 'AI 应用与平台',
      nameEn: 'AI apps and platforms',
      description:
        'AI products and infrastructure that are not coding agents: assistants, RAG, agent frameworks and SDKs, model APIs and gateways, GUI/browser agents, PPT or document generators',
    },
    { name: '模型与评测', nameEn: 'Models and benchmarks', description: 'AI models, weights, datasets and benchmarks' },
    {
      name: '效率与桌面应用',
      nameEn: 'Productivity and desktop apps',
      description: 'End-user apps and self-hosted services for daily use: macOS/Windows utilities, clipboard, notes, productivity, personal tools',
    },
    {
      name: 'AI 工程方法与观点',
      nameEn: 'AI engineering methods and opinions',
      description: 'How to work with AI: context and harness engineering, software design (DDD), workflows, career and industry opinions, talks and essays',
    },
    {
      name: '资料合集',
      nameEn: 'Collections and references',
      description: 'Awesome lists, curated link collections, learning roadmaps and general guides that span many topics',
    },
    { name: UNCATEGORIZED, nameEn: 'Uncategorized', description: 'Anything that does not fit the other Categories' },
  ],
}

/** Writes the default table only when none exists; never overwrites. */
export async function initCategories(storeDir: string): Promise<{ created: boolean; table: CategoryTable }> {
  const existing = await loadCategories(storeDir)
  if (existing) return { created: false, table: existing }
  await mkdir(storeDir, { recursive: true })
  await saveCategoriesTable(storeDir, DEFAULT_CATEGORIES)
  return { created: true, table: DEFAULT_CATEGORIES }
}

export class CategoryTableError extends Error {}

/** Checks a Category Table read from a file and returns only its known fields. */
export function validateCategoryTable(value: unknown): CategoryTable {
  const fail = (why: string): never => {
    throw new CategoryTableError(`invalid Category Table: ${why}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('not a JSON object')
  const doc = value as { schemaVersion?: unknown; categories?: unknown }
  if (doc.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}, got ${String(doc.schemaVersion)}`)
  if (!Array.isArray(doc.categories) || doc.categories.length === 0) fail('"categories" must be a non-empty array')
  const list = doc.categories as unknown[]
  if (list.length > MAX_CATEGORIES) fail(`at most ${MAX_CATEGORIES} Categories (the GitHub Lists limit), got ${list.length}`)
  const categories: Category[] = []
  const seen = new Set<string>()
  list.forEach((raw, i) => {
    const c = (raw ?? {}) as { name?: unknown; description?: unknown; nameEn?: unknown }
    if (typeof c.name !== 'string' || c.name.trim() === '') fail(`categories[${i}].name must be a non-empty string`)
    const name = c.name as string
    if (name !== name.trim()) fail(`categories[${i}].name ${JSON.stringify(name)} has leading or trailing spaces`)
    if (typeof c.description !== 'string') fail(`categories[${i}].description must be a string`)
    if (seen.has(name)) fail(`Category ${JSON.stringify(name)} appears twice`)
    seen.add(name)
    const category: Category = { name, description: c.description as string }
    if (c.nameEn !== undefined) {
      if (typeof c.nameEn !== 'string' || c.nameEn.trim() === '' || /[\r\n]/.test(c.nameEn)) {
        fail(`categories[${i}].nameEn must be one non-empty line`)
      }
      category.nameEn = (c.nameEn as string).trim()
    }
    categories.push(category)
  })
  if (!seen.has(UNCATEGORIZED)) fail(`the table must contain ${JSON.stringify(UNCATEGORIZED)}`)
  return { schemaVersion: SCHEMA_VERSION, categories }
}

export interface SetCategoriesResult {
  categories: string[]
  /** Classifier Classifications deleted by `reclassify`; those Items are pending again. */
  removed: number
  /** Locked Classifications whose Category is not in the new table; left as they are for the owner to override. */
  staleLocked: { id: string; category: string }[]
}

/**
 * Replaces the Category Table. With `reclassify`, every unlocked Classification the Classifier made is deleted, so the
 * Item is pending again; Locked ones (the owner's) and `collector` ones (private repositories' stars) stay, and Skipped
 * Items are untouched.
 */
export async function setCategories(
  storeDir: string,
  value: unknown,
  options: { reclassify?: boolean } = {},
): Promise<SetCategoriesResult> {
  const table = validateCategoryTable(value)
  await requireStore(storeDir)
  const names = new Set(table.categories.map((c) => c.name))
  return withStoreLock(storeDir, async () => {
    const all = await loadClassifications(storeDir)
    let removed = 0
    if (options.reclassify) {
      for (const [id, c] of Object.entries(all)) {
        if (c.by === 'classifier' && !c.locked) {
          delete all[id]
          removed++
        }
      }
    }
    const staleLocked = Object.entries(all)
      .filter(([, c]) => c.locked && !names.has(c.category))
      .map(([id, c]) => ({ id, category: c.category }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    await saveCategoriesTable(storeDir, table)
    if (removed > 0) await saveClassifications(storeDir, all)
    return { categories: [...names], removed, staleLocked }
  })
}
