// The ego-browser side of the X collector: each call is one `ego-browser nodejs` script on its own task space,
// created on the Default profile (the one logged in to X) and always finished. No model ever drives it (ADR 0003).
import { spawn } from 'node:child_process'
import { assertLoggedIn, LIST_URL, type OpenXBrowser, type RawRow, type XBrowser, type XList } from './x.ts'

const MARK = '@@starsieve-json@@'
const PROFILE_ID = 'Default'
const CALL_TIMEOUT_MS = 120_000

export class BrowserError extends Error {}

/** Runs one script; it must print one `MARK <json>` line. Other output (notices) is ignored. */
async function runScript(body: string): Promise<Record<string, unknown>> {
  const script = `const out = (v) => console.log(${JSON.stringify(MARK)} + JSON.stringify(v));
try {
${body}
} catch (e) {
  out({ error: String(e && e.message ? e.message : e) });
}
`
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), CALL_TIMEOUT_MS)
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
      child.on('error', (e) => {
        clearTimeout(timer)
        fail(new BrowserError(`cannot start ego-browser: ${e.message}`))
      })
      child.on('close', (c) => {
        clearTimeout(timer)
        done({ code: c, stdout, stderr })
      })
      child.stdin.end(script)
    },
  )
  // ego-browser prints the script's console.log on stderr; look in both.
  const line = `${stdout}\n${stderr}`.split('\n').findLast((l) => l.startsWith(MARK))
  if (!line) {
    const tail = `${stderr}\n${stdout}`.trim().split('\n').slice(-5).join('\n')
    throw new BrowserError(`ego-browser nodejs exited with ${code} and no result${tail ? `: ${tail}` : ''}`)
  }
  const value = JSON.parse(line.slice(MARK.length)) as Record<string, unknown>
  if (typeof value.error === 'string') throw new BrowserError(`ego-browser: ${value.error}`)
  return value
}

/** Page-side: every article on screen as a RawRow. Runs inside the page. */
const EXTRACT = `() => [...document.querySelectorAll("article")].map((a) => ({
  hrefs: [...a.querySelectorAll("a[href]")].map((x) => x.getAttribute("href")),
  timeHref: a.querySelector("time")?.closest("a")?.getAttribute("href") ?? null,
  datetime: a.querySelector("time")?.getAttribute("datetime") ?? null,
  text: a.querySelector('[data-testid="tweetText"]')?.innerText ?? "",
  hasMediaElement: !!a.querySelector('[data-testid="tweetPhoto"],[data-testid="videoPlayer"],[data-testid="videoComponent"]'),
  article: (() => {
    const cover = a.querySelector('[data-testid="article-cover-image"]');
    const card = cover && cover.parentElement;
    if (!card) return [];
    return [...card.querySelectorAll("*")]
      .filter((e) => !cover.contains(e) && e.children.length === 0 && (e.innerText || "").trim())
      .map((e) => e.innerText.trim());
  })(),
}))`

const resume = (spaceId: number) => `const task = await taskSpace(${spaceId});
const page = task.page("p1");`

function loadScript(spaceId: number, list: XList): string {
  const url = LIST_URL[list]
  const path = new URL(url).pathname
  return `${resume(spaceId)}
let lastError;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await page.goto(${JSON.stringify(url)}, { timeout: 30000 });
    lastError = undefined;
    break;
  } catch (e) {
    lastError = e;
    await page.waitForTimeout(2000 * attempt);
  }
}
if (lastError) throw new Error("cannot open ${url} after 3 tries: " + (lastError.message ?? lastError));
let ready = true;
await page.waitForFunction(
  () => document.querySelector("article") || document.querySelector('[data-testid="emptyState"]') || /^\\/(i\\/jf\\/|i\\/flow\\/login|login)/.test(location.pathname),
  undefined,
  { timeout: 20000 },
).catch(() => { ready = false; });
const state = await page.evaluate(() => ({
  url: location.href,
  empty: !!document.querySelector('[data-testid="emptyState"]'),
  selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("href") ?? null,
}));
out({ ready, ...state, expectedTab: ${JSON.stringify(path)}, rows: await page.evaluate(${EXTRACT}) });`
}

function scrollScript(spaceId: number): string {
  return `${resume(spaceId)}
const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
await page.mouse.move(Math.round(size.w / 2), Math.round(size.h / 2));
await page.mouse.wheel(0, 2500);
await page.waitForTimeout(1500);
out({ url: await page.url(), rows: await page.evaluate(${EXTRACT}) });`
}

/** Opens a new task space on the Default profile; every method below reuses it by id. */
export const openEgoBrowser: OpenXBrowser = async () => {
  const opened = await runScript(`const task = await taskSpace("starsieve x " + Date.now(), { profileId: ${JSON.stringify(PROFILE_ID)} });
out({ spaceId: task.spaceId });`)
  const spaceId = opened.spaceId
  if (typeof spaceId !== 'number') throw new BrowserError('ego-browser did not return a task space id')

  const browser: XBrowser = {
    async load(list) {
      const r = await runScript(loadScript(spaceId, list))
      const url = String(r.url)
      assertLoggedIn(url)
      if (r.ready !== true) {
        throw new BrowserError(`${url} showed neither posts nor an empty list within 20 s; X may not have loaded`)
      }
      if (typeof r.selectedTab === 'string' && r.selectedTab !== r.expectedTab) {
        throw new BrowserError(`${url}: selected tab is ${r.selectedTab}, expected ${String(r.expectedTab)}`)
      }
      return { rows: (r.rows as RawRow[]) ?? [], empty: r.empty === true }
    },
    async scroll() {
      const r = await runScript(scrollScript(spaceId))
      assertLoggedIn(String(r.url))
      return (r.rows as RawRow[]) ?? []
    },
    async close() {
      await runScript(`const task = await taskSpace(${spaceId});
await task.finish({ keep: [] });
out({ finished: true });`)
    },
  }
  return browser
}
