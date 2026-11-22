// init data: the template files of the two data repositories, written into local clones (nothing is pushed).
// init github: the repository settings the public repository needs, printed as `gh api` commands (never run here).
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { writeText } from '../core/json.ts'

const TEMPLATES = new URL('./templates/', import.meta.url)
const template = (name: string) => readFile(new URL(name, TEMPLATES), 'utf8')

export type FileStatus = 'created' | 'updated' | 'unchanged' | 'kept'

export interface InitFile {
  repo: 'private' | 'public'
  path: string
  status: FileStatus
}

export interface InitDataOptions {
  privateDir: string
  publicDir: string
  /** The Private Store inside the private clone, for the heartbeat file's path; defaults to the clone itself. */
  storeDir?: string
  /** Overwrite files that differ from the template. */
  force?: boolean
}

/** Writes each template; a file that exists and differs is kept unless `force`. */
export async function initData(o: InitDataOptions): Promise<InitFile[]> {
  const privateDir = resolve(o.privateDir)
  const publicDir = resolve(o.publicDir)
  const store = o.storeDir ? resolve(o.storeDir) : privateDir
  const rel = relative(privateDir, store)
  if (rel.startsWith('..')) throw new Error(`the store ${store} is not inside the private clone ${privateDir}`)
  const heartbeatPath = rel ? `${rel}/heartbeat.json` : 'heartbeat.json'
  const files: [InitFile['repo'], string, string][] = [
    ['public', '.github/workflows/check.yml', await template('check.yml')],
    ['public', '.github/scripts/validate.mjs', await template('validate.mjs')],
    ['private', '.github/workflows/heartbeat.yml', (await template('heartbeat.yml')).replace('{{HEARTBEAT}}', heartbeatPath)],
    ['private', '.github/scripts/heartbeat-check.mjs', await template('heartbeat-check.mjs')],
  ]
  const out: InitFile[] = []
  for (const [repo, path, text] of files) {
    const full = join(repo === 'public' ? publicDir : privateDir, path)
    const now = await readFile(full, 'utf8').catch(() => undefined)
    let status: FileStatus
    if (now === text) status = 'unchanged'
    else if (now !== undefined && !o.force) status = 'kept'
    else {
      status = now === undefined ? 'created' : 'updated'
      await writeText(full, text)
    }
    out.push({ repo, path: full, status })
  }
  return out
}

/** The required check's name: the job id in check.yml. */
export const REQUIRED_CHECK = 'check'

export interface GithubCommand {
  what: string
  command: string
}

/** The `gh api` calls that set up the public repository: auto-merge, branch protection on main, Pages from main /docs. */
export function githubCommands(slug: string): GithubCommand[] {
  const protection = {
    required_status_checks: { strict: false, checks: [{ context: REQUIRED_CHECK }] },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
  }
  const pages = { build_type: 'legacy', source: { branch: 'main', path: '/docs' } }
  return [
    {
      what: 'allow auto-merge and squash merges, delete merged branches',
      command: `gh api -X PATCH repos/${slug} -F allow_auto_merge=true -F allow_squash_merge=true -F delete_branch_on_merge=true`,
    },
    {
      what: `protect main: the "${REQUIRED_CHECK}" job of .github/workflows/check.yml must pass before a PR merges`,
      command: `gh api -X PUT repos/${slug}/branches/main/protection --input - <<'JSON'\n${JSON.stringify(protection)}\nJSON`,
    },
    {
      what: 'serve GitHub Pages from main /docs (if Pages is already on, use -X PUT with the same body)',
      command: `gh api -X POST repos/${slug}/pages --input - <<'JSON'\n${JSON.stringify(pages)}\nJSON`,
    },
  ]
}
