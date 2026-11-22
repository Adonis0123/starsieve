# starsieve

English | [简体中文](README.zh-CN.md)

Sorts the repositories you starred on GitHub and the technical posts you liked or bookmarked on X into Categories with any agent CLI as the Classifier, and publishes only the Items that may be public. Terms follow [GLOSSARY.md](GLOSSARY.md); decisions are in [docs/adr](docs/adr).

Built so far: collect (GitHub stars, X likes and bookmarks), Backfill, classify, apply, override (and unskip), publish, check, the Portal Panel, the public site build, the daily `run` (git commit and push, PR with auto-merge, Heartbeat), GitHub Lists sync, the data repositories' CI templates and the LaunchAgent.

## Requirements

- macOS. `schedule` installs a LaunchAgent, and logs and saved Classifier output go to `~/Library/Logs/starsieve/`.
- Node 22.18+ (runs the TypeScript sources directly) and pnpm.
- `gh` logged in (`gh auth login`) as the owner of both data repositories. Its default `repo` scope covers reading your stars (`gh api user/starred`, also those of private repositories), pushing, and the daily PR (`gh pr create`, `gh pr merge --auto`). `run` also syncs GitHub Lists (`gh api graphql`: `viewer.lists`, `createUserList`, `updateUserListsForItem`); if GitHub refuses those for a missing scope, add `user`: `gh auth refresh -s user`. Pushing the `.github/workflows/` files that `init data` writes needs the `workflow` scope when git uses `gh` for HTTPS: `gh auth refresh -s workflow`. The commands `init github --dry-run` prints change repository settings, so they need admin rights on the public repository.
- An agent CLI as the Classifier; the default is `cursor-agent` (see [Classifier](#classifier) before using another one).
- For X (optional): the `ego-browser` CLI with its `Default` profile logged in to x.com. Without it, set `"collectX": false` in the user config, and `run` skips X.
- The Local Tools Portal (optional): only the Panel needs it; `site build` and `run` work without it.

The default Category Table (`categories init`) and the published README are in Chinese. Replace the table with `categories set --file`; the README's fixed text is Chinese only, and `readme.title` sets its title.

## Quick start

`<owner>` is your GitHub login; `stars-private` and `stars` are example names.

1. Clone this repository and install:

   ```sh
   git clone https://github.com/Adonis0123/starsieve && cd starsieve
   pnpm install
   ```

2. Create a private repository for the Private Store and a public one for the catalog, each with a first commit on `main`, and clone both:

   ```sh
   gh repo create <owner>/stars-private --private --add-readme
   gh repo create <owner>/stars --public --add-readme
   gh repo clone <owner>/stars-private ~/stars-private
   gh repo clone <owner>/stars ~/stars
   ```

3. Write the CI files into both clones (the store is the private clone itself; `--store <dir>` names a folder inside it), then commit and push them yourself:

   ```sh
   pnpm starsieve init data --private ~/stars-private --public ~/stars
   git -C ~/stars-private add .github && git -C ~/stars-private commit -m "add heartbeat check" && git -C ~/stars-private push
   git -C ~/stars add .github && git -C ~/stars commit -m "add data check" && git -C ~/stars push
   ```

4. Fill the store and classify one Batch (`run` classifies the rest):

   ```sh
   pnpm starsieve categories init --store ~/stars-private
   pnpm starsieve collect github --store ~/stars-private
   pnpm starsieve classify --store ~/stars-private --limit 25
   ```

5. See what would be public: `publish --dry-run` counts the public Items and writes nothing, and `site build` writes the site into a scratch folder (`run` writes the real files into the public clone):

   ```sh
   pnpm starsieve publish --store ~/stars-private --out /tmp/starsieve-preview --dry-run
   pnpm starsieve site build --store ~/stars-private --out /tmp/starsieve-preview/site
   ```

6. Write `~/.config/starsieve/config.json`. `run` needs at least these keys; leave out `collectX` when ego-browser is set up for X. All keys are in [Configuration](#configuration).

   ```json
   { "storePath": "~/stars-private", "publicRepoPath": "~/stars", "publicRepo": "<owner>/stars", "collectX": false }
   ```

7. `pnpm starsieve run --dry-run` prints the plan; `pnpm starsieve run --no-push` runs everything but only commits locally.

8. `pnpm starsieve init github --dry-run` prints the `gh api` commands that turn on auto-merge, protect main with the `check` job and serve Pages from `/docs`; run them yourself.

9. `pnpm starsieve schedule install` runs `run` daily at 08:17. It passes `--no-push` until `schedulePush` is `true`.

## Configuration

There are two config files:

- `~/.config/starsieve/config.json` (`$XDG_CONFIG_HOME/starsieve/config.json` when that is set) holds this machine's settings and stays out of every repository. Every key is optional; `~/` and relative paths (relative to the file's folder) are expanded. All keys:

  ```json
  {
    "storePath": "~/stars-private",
    "publicRepoPath": "~/stars",
    "publicRepo": "<owner>/stars",
    "siteUrl": "https://<owner>.github.io/stars/",
    "readme": { "title": "技术收藏" },
    "portalCss": "~/path/to/local-tools.css",
    "collectX": true,
    "schedulePush": false,
    "scheduleMaxBatches": 4,
    "mergeTimeoutMs": 1200000
  }
  ```

  | Key | Default | Meaning |
  | --- | --- | --- |
  | `storePath` | none | The Private Store: `--store` of `run` and `lists sync`, and the store the Panel shows. Other commands take `--store`. |
  | `publicRepoPath` | none | The public repository's local clone: `--public` of `run` and `lists sync`. |
  | `publicRepo` | none | Its `owner/name`, for `gh` (the PR, `init github`) and the check that the store never pushes to it. |
  | `siteUrl` | none | The public site, linked from the README; never guessed from `publicRepo`. |
  | `readme.title` | 技术收藏 | The published README's title. |
  | `portalCss` | none | The Portal's `local-tools.css`, inlined by `site build` instead of `src/site/default.css`. Leave it out without the Portal: a file that does not exist fails `site build` and `run`. |
  | `collectX` | `true` | `false`: `run` skips `collect-x` (the step shows as `skipped`); X Items already in the store are still published. |
  | `schedulePush` | `false` | `true`: the LaunchAgent's `run` pushes; otherwise it carries `--no-push`. |
  | `scheduleMaxBatches` | none | The LaunchAgent's `run --max-batches`. |
  | `mergeTimeoutMs` | 1200000 (20 min) | How long `run` waits for the public PR to merge. |

  `schedulePush` and `scheduleMaxBatches` are written into the plist, so run `schedule install` again after changing them.

- The store's own `config.json`, inside the Private Store and committed with it, sets only the Classifier: `{schemaVersion, classifier: {command, timeoutMs}}` (see [Classifier](#classifier)).

## Commands

```sh
pnpm starsieve collect github --store <dir>          # every star via gh; rerunning is idempotent
pnpm starsieve collect x --store <dir> [--signal likes|bookmarks|all] [--known-stop 20] [--max-scrolls 40]
pnpm starsieve backfill x --store <dir> [--signal likes|bookmarks|all] [--max-scrolls 400]
pnpm starsieve categories init --store <dir>         # default Category Table, only if none exists
pnpm starsieve categories set --store <dir> --file <json> [--reclassify]  # replace the table; --reclassify makes unlocked Classifier Classifications pending again
pnpm starsieve pending --store <dir> --limit 25 [--source github|x]  # next Batch (JSON)
pnpm starsieve classify --store <dir> --limit 25 [--source github|x] # run the Classifier on one Batch, then apply
pnpm starsieve apply --store <dir> --file batch.json # the only write path for Classifications
pnpm starsieve override <id> --store <dir> [--category X] [--tags a,b] [--summary S] [--visibility public|private]
pnpm starsieve override <id> --store <dir> --unskip  # take a Skipped Item back; the next X collection stores it as pending
pnpm starsieve publish --store <dir> --out <dir> [--dry-run]
pnpm starsieve check --store <dir>
pnpm starsieve list --store <dir> [--q <words>] [--category <name>] [--source github|x] [--visibility public|private] [--needs-review] [--limit 50]  # read-only search
pnpm starsieve site build --store <dir> --out <dir> [--css <local-tools.css>]  # the public site: one index.html
pnpm starsieve run [--store <dir>] [--public <clone>] [--no-push] [--pr-dry-run] [--dry-run] [--max-batches N]
pnpm starsieve lists sync [--store <dir>] [--public <clone>] [--dry-run]
pnpm starsieve init data --private <clone> --public <clone> [--store <dir>] [--force]
pnpm starsieve init github --dry-run [--repo owner/name]
pnpm starsieve schedule install|uninstall|status
```

Every command takes `--json`; the output carries `schemaVersion`. Exit codes: 0 done, 1 failed, 2 usage error.

## Store layout

The store is a plain directory meant to live in a private git repository. Every file is JSON with sorted keys, two-space indent and a trailing newline, so `git diff` stays small.

| File | Content |
| --- | --- |
| `items/github.json` | `{schemaVersion, items}`; Items sorted by `id` (`github:<owner>/<repo>`). `collect` refreshes Item fields and never deletes an Item that is no longer starred. |
| `items/x.json` | `{schemaVersion, items}`; X Items sorted by `id` (`x:<status id>`): `signals` (`like`, `bookmark`), `url`, `author`, `text`, `postedAt` (when the post was written; X shows no like time), `collectedAt`, `hasMedia`, `textEmpty`. A post seen again only gains a Signal; its text stays. |
| `skipped.json` | `{schemaVersion, skipped}`; Skipped Items: a map from id to `{skippedAt}`. Their text is deleted from `items/x.json`; collecting them again only counts them as known. |
| `backfill.json` | `{schemaVersion, x: {like, bookmark}}`; the last Backfill reach per list: `startedAt`, `updatedAt`, `scrolls`, `seen`, `added`, `earliestPostedAt`, `reachedEnd`, `finished`. |
| `classifications.json` | `{schemaVersion, classifications}`; a map from Item id to its Classification: `category`, `tags`, `summary`, `visibility`, `needsReview`, `locked`, `by` (`classifier`, `owner`, or `collector` for a private repository's star), `inputHash`. |
| `categories.json` | The Category Table: `{schemaVersion, categories: [{name, description}]}`. Its order is the order of sections in the published README. `categories init` writes the default table only when there is none; `categories set --file` replaces it after checking it (`schemaVersion` 1, unique non-empty names, `未分类` present, at most 32 Categories, the GitHub Lists limit). With `--reclassify` it also deletes every unlocked `classifier` Classification, so those Items are pending again; Locked and `collector` Classifications and Skipped Items stay, and Locked ones whose Category left the table are listed as `staleLocked` for `override`. |
| `config.json` | Optional. `{schemaVersion, classifier: {command, timeoutMs}}`: the Classifier only; machine settings live in `~/.config/starsieve/config.json` (see [Configuration](#configuration)). |
| `publish-state.json` | Written by `publish` (not by `--dry-run`): the hash of the last Public Projection and its `contentHash` (without star counts), used by `check`. |
| `owner-kept.json` | `{schemaVersion, kept}`: X posts the owner took back with `override --unskip`, by id. `apply` never skips them again. |
| `heartbeat.json` | Written by `run`: `lastAttemptAt`, `lastSuccessAt`, `result`, `nothingNew` and each step's result. |
| `.starsieve-write.lock.<pid>.<uuid>` | The store lock's claim files; exist only while a write is in progress (see below); `run` leaves them out of every store commit. |

Nothing else is written; `pending` and failed `classify` runs leave the store unchanged.

Every read-modify-write of the store (`apply`, also inside `classify`; `override` and `override --unskip`, also from the Panel; the merge step of `collect github` and `collect x`) holds the store lock `.starsieve-write.lock`, waiting up to 30 s for another process to finish. A process claims a lock by creating its own file `<lock>.<pid>.<uuid>` and holds it when no other live process has a claim there; a dead process's claim is removed by its exact name, so two processes taking over the same stale lock never both get it. A claim older than 10 s whose pid now belongs to a process started over 10 s after the claim (a recycled pid, checked with `ps -o etime=`) counts as dead. When claims meet, the earliest one keeps looking and the others withdraw and retry after a jittered pause, so one of them always gets the lock. `apply` reads `classifications.json` again under the lock, so an owner edit made while the Classifier was running is kept, and a Locked entry is never overwritten. The lock holds only file reads and writes, never the Classifier or the browser.

## X collection

`collect x` and `backfill x` drive ego-browser with a fixed script (ADR 0003): each step is one `ego-browser nodejs` call on a task space created on the `Default` profile and finished at the end, even on failure. Likes are read from `x.com/i/history/likes`, bookmarks from `x.com/i/history`. A redirect to onboarding or login, or a page that shows neither posts nor an empty list, is an error (exit 1), never "nothing new". `goto` is retried 3 times.

- `collect x` reads from the top and stops after `--known-stop` known posts in a row, after 5 scrolls with nothing new, or at `--max-scrolls`. Known is counted per list: a post stored with that list's Signal, or a Skipped Item (a liked post is still new on the bookmarks list, where it gains the bookmark Signal). It saves once per list.
- `backfill x` ignores known posts, saves every 10 scrolls, and records its reach in `backfill.json`. Ctrl-C stops it between scrolls and saves.

X shows long posts truncated, so `text` can be a preview. An X Article has no post text of its own; when the post shows an Article card (`article-cover-image`), the card's title and summary become `text` (after the post text, if any), so it is not `textEmpty`. Posts stored before this change keep their stored text.

`override <id> --unskip` removes the id from `skipped.json` and records it in `owner-kept.json`. The post's text was deleted when it was skipped, so nothing else comes back at once: the next `collect x` or `backfill x` that reads the post stores it again as a new, pending Item. When the Classifier then answers `keep: false` for an owner-kept post, `apply` keeps it with Needs Review (category `未分类`, private unless the answer says otherwise) instead of skipping it.

## Batches and apply

`pending` prints a Batch of one Source (`--source`, or else the Source of the newest pending Item): `batchId`, `source`, and for each Item its `id`, `inputHash` and the input the Classifier sees (GitHub: `id`, `name`, `url`, `description`, `language`, `topics`; X: `id`, `source`, `url`, `author`, `text`, `textEmpty`, `hasMedia`, `postedAt`). `inputHash` is sha256 over that input, so star-count changes and new Signals never stale a Batch. Stars of private repositories are never pending: `collect github` gives them a private `collector` Classification (category `未分类`), and they never reach a prompt. `batchId` is derived from the (id, inputHash) pairs, so it needs no stored state.

`apply --file` takes the Batch plus the answer: `{schemaVersion, batchId, items: [{id, inputHash}], classifications: [{id, category, tags, summary, visibility, needsReview}]}`. It rejects the whole file when `schemaVersion` is not 1, `batchId` does not match its `items`, or there is no Category Table. Per entry:

- id not in the store, not in the Batch, or repeated: rejected.
- Locked: skipped, never overwritten.
- `inputHash` differs from the Item now: rejected.
- category not in the Category Table: kept as `未分类` with `needsReview`.
- more than 6 tags: the first 6 are kept.
- summary: links and HTML removed, then capped at 80 characters (code points).
- visibility missing or not `public`/`private`: `private`.
- X Item without a boolean `keep`: rejected. `keep: false`: it becomes a Skipped Item (`status: skippedItem`); `keep` on a GitHub Item is ignored.
- X Item with `textEmpty`: always `private` and `needsReview`.

## Classifier

`classify` writes the Batch into a prompt, runs the configured command in a new empty temporary workspace whose `.cursor/cli.json` denies `Shell(*)`, `Read(**)` and `Write(**)` (ADR 0001), and reads one JSON object from stdout. A timeout, a non-zero exit or unparsable output is an error and writes nothing. The error for unparsable output gives only its length, the first 12 hex digits of its sha256 and the kind of failure, never the text (it can hold post text and ends up in the log and the Heartbeat); the output itself is saved to `~/Library/Logs/starsieve/classify-unparsed-*.txt`, readable only by the owner (mode 600), and the error names that file. The runner, not the agent, supplies `batchId` and `inputHash` to `apply`. The X prompt adds the rule that only technical posts (programming, AI, developer tools, design engineering) are kept, asks for `keep` on every post, and tells the agent that a post with no text gets `needsReview` and `private`.

The default command, overridable in `config.json`:

```json
{
  "schemaVersion": 1,
  "classifier": {
    "command": ["cursor-agent", "-p", "--model", "grok-4.7-medium", "--mode", "ask", "--sandbox", "enabled",
                "--trust", "--workspace", "{workspace}", "--output-format", "text", "{prompt}"],
    "timeoutMs": 900000
  }
}
```

`{prompt}`, `{workspace}` and `{store}` are replaced in each argument. Without `{prompt}` the prompt goes to stdin. The command runs with the temporary workspace as its working directory, so use absolute paths for scripts.

The sandbox comes from cursor-agent itself: it reads the workspace's `.cursor/cli.json`, and starsieve only writes that file. Another agent CLI ignores it, so before you put one in `command`, give it its own mode with no tools (no shell, no file reads or writes) through its flags or config; starsieve cannot check that it has one. `grok-4.7-medium` is only the default model: `command` in the store's `config.json` replaces the whole default command, model included.

## Publish

`publish` writes `items.json` and a `README.md` catalog to `--out`, grouped by Category in table order, newest star (or post) first. An Item is included only when it has a Classification whose Visibility is `public`, and for a star only when its repository is public (`repoPrivate` is `false`); an owner override cannot make a private repository's star public. A GitHub Item also carries `stargazers`; every Item carries `needsReview` and `addedAt` (star time; for X, when starsieve first saw it). An X Item is published as `url`, `author`, `postedAt`, `addedAt`, `category`, `tags`, `summary` and `needsReview` only, never its text; Skipped Items are never published. Only allowlisted fields are written and there are no run timestamps, so publishing twice gives identical files. Star counts change daily, so they alone never count as something new to publish (`contentHash` leaves them out); they are refreshed whenever something else is published. `--dry-run` prints the number of public Items and the difference from what `--out` holds, and writes nothing.

The README is in Chinese: the title, the counts, a link to the online catalog, a contents list with each Category's count, then one section per Category with a link back to the contents. Each Item is one list entry: `[owner/repo](url) — Summary<br><sub>language · Tags</sub>` (the Summary without a final full stop; at most 3 Tags, the first kept; the language is left out when the first Tag already names it), or `X · [@author](url) — Summary<br><sub>Tags</sub>` for a post. Without a Summary the dash is left out, and without language and Tags the second line is. It shows no star counts, so a day where only star counts moved leaves it unchanged. Two optional keys in `~/.config/starsieve/config.json` set it, and `publish` and `run` both read them:

```json
{ "readme": { "title": "技术收藏" }, "siteUrl": "https://<owner>.github.io/<repo>/" }
```

`readme.title` defaults to 技术收藏. Without `siteUrl` the README leaves out the online-catalog link; it is never guessed from `publicRepo`, since a repository name does not prove Pages is on.

## Panel and public site

One page renders both (`src/panel`). The Panel is the Local Tools Portal's `kind: "panel"` entry: `src/panel/index.ts` exports `createPanelHandler({ basePath, allowedHosts, theme, readOnly, lang })`, and `/api/health` answers `{ app: "starsieve", version }`. It shows every Item of the store named by `storePath` in `~/.config/starsieve/config.json`, with filters by Source, Category and Tag, search, and sorting by recently added or by stars. Edits call the same functions as `starsieve override` and `override --unskip` (the "Skipped" tab); `readOnly` hides them and refuses every write. Writes also need the page's Origin and its per-instance token.

```json
{ "storePath": "~/path/to/stars-private", "portalCss": "~/path/to/local-tools.css" }
```

`portalCss` is optional; see `site build` below.

`site build` writes `index.html` from the Public Projection only (the filter `publish` uses), read-only, with its data inline so it opens from `file://`. Its stylesheet is inlined: the Portal's `local-tools.css` from `--css` or `portalCss` when one is set, else `src/site/default.css`, a trimmed copy of it (tokens and the `.lt-*` components the page uses). So the site builds without the Portal; only the Panel needs it. The site sorts by recently added or by stars and marks Items that need review ("待确认").

## Daily run

`run` is the whole pipeline, one step after another; each step's result goes into `heartbeat.json` and the log `~/Library/Logs/starsieve/run-YYYYMMDD.log`. Only one run at a time (the lock `run.lock` next to the logs, taken the same way as the store lock below, trying for up to 1 s: a run whose process is gone is taken over). `--store` and `--public` default to `storePath` and `publicRepoPath` in `~/.config/starsieve/config.json`.

1. `check`: the store, the private repository it lives in and the public clone. The store must not be inside the public clone, its repository must not be the public clone's, and none of its `origin` URLs, fetch or push (`pushurl` included), may be the public repository (the same URL as one of the public clone's `origin` URLs, or the `publicRepo` slug, in any letter case). The store's JSON must also pass `check`. When anything in this step fails, the run stops and nothing in the store is committed or pushed: the Heartbeat is only written to the store, or not written at all when the store is inside the public clone (any file there could end up in a public commit).
2. `collect-github`, `collect-x`: a failure (also a logged-out X) fails the run, but the run goes on and that Source is not published: its public Items stay as the public branch has them, except those the store no longer has as public (made private, skipped, gone), which are removed. With `"collectX": false` in the config, `collect-x` is `skipped` and X is not collected.
3. `classify`: Batches of 25 until nothing is pending or `--max-batches` (`0`: classify nothing).
4. `publish`, `site`: on branch `starsieve/YYYYMMDD` of the public clone (an open starsieve PR's branch, or an unpushed local branch, is reused), `data/items.json`, `README.md` and `docs/index.html`. Nothing is written when only star counts changed.
5. `private`: commits the store (the Heartbeat is committed at the end) and pushes.
6. `public`: commits the branch and pushes it. Before the push, commits that no remote has seen yet (more than one, from earlier `--no-push` runs) are squashed into one commit holding the current projection, on top of the base or of the branch as already pushed, so an Item published locally and taken back before the push never reaches GitHub. The step fails instead, leaving the branch as it is and pushing nothing, when those commits change files outside `data/`, `README.md` and `docs/` (squashing would drop them), or when the local branch and the pushed one have diverged; sort the branch out by hand, then run again. What was already pushed cannot be taken back: an Item made private after its branch was pushed stays in that branch's history (the PR is squash-merged, so not in main's).
7. `pr`: `gh pr create` and `gh pr merge --auto --squash` (`publicRepo` in the config names the repository). Only an open PR the owner opened (`--author @me`) from a branch of the public repository itself is reused, never a fork's. Before auto-merge, the PR's head must be the commit this run pushed (`gh pr view --json headRefOid`), and the merge carries `--match-head-commit` with it; otherwise the step fails and nothing is merged.
8. `wait-merge`: polls the PR up to `mergeTimeoutMs` (20 min); a timeout is not a failure.
9. `lists-sync`: see below; runs on whatever main holds, so a PR that merged after a timeout is synced by the next run.
10. `heartbeat`: writes the result, commits and pushes it (only after the whole `check` step passed; see step 1). With nothing new collected, classified or published, this is the only change, and the run reports "nothing new".

`--no-push` commits both clones locally and pushes nothing; `--pr-dry-run` pushes both but only prints the PR commands. With either, and with `--dry-run` (which only prints the plan), Lists are only planned. Any failure exits 1.

After a failure, the public clone goes back to the branch it was on. Of the run's own uncommitted files, only those still holding exactly what the run wrote are undone; commits stay on the day branch. Any other change in the clone (an edit the owner made meanwhile, even to a file the run wrote) is kept, and the step `restore-public` fails listing it; when a kept change stops git from switching back, the clone stays on the day branch.

Known limits (accepted; the public clone is generated and not meant to be edited by hand):

- Rollback checks each file right before restoring it, but another process saving that file, or staging it, in the instant between that check and the write can still lose that save. Git has no compare-and-swap on the working tree to close it.
- A lock claim whose pid is reused by a long-lived process within about 2 s of the claim is not recognised as dead (`ps` reports start times in whole seconds), so writers wait and fail with `LockedError` until that process exits; remove the stale `<lock>.<pid>.<uuid>` file by hand.
- A file in the public clone that became a symbolic link is never rolled back; it is listed as kept.

## GitHub Lists

`lists sync` reads every list and its members with `gh api graphql` (`viewer.lists`, all pages; any failed read stops before a write), takes the GitHub Items on the public repository's main that the store still says are public, and adds each to the list named after its Category. Missing lists are created with `createUserList` for Categories that have GitHub Items; past 32 lists it stops with an error before writing. `updateUserListsForItem` replaces a repository's whole membership, so it is always sent the lists the repository is in now plus the Category's list: nothing is ever removed. The lists are read again right before each mutation request (up to 20 repositories), and the membership comes from that read, so a list the owner added a repository to after planning is kept. This narrows the window to one request; it does not close it. `--dry-run` prints the plan.

## Data repositories and schedule

`init data` writes, without pushing:

- public: `.github/workflows/check.yml` (job `check`, on PRs to main) and `.github/scripts/validate.mjs`, a zero-dependency check of `data/items.json` (schemaVersion, allowlisted fields only, no Visibility, private-repository marks or X text, Summary length) and of the changed paths (only `data/`, `README.md`, `docs/`). CI runs the base branch's copy of the script.
- private: `.github/workflows/heartbeat.yml`, every 6 hours, and `.github/scripts/heartbeat-check.mjs`: an issue when `lastSuccessAt` is older than 48 hours (one at a time), closed after the next success.

`init github --dry-run` prints the `gh api` commands for the public repository: auto-merge, branch protection on main requiring `check`, Pages from main `/docs`.

`schedule install` writes `~/Library/LaunchAgents/io.github.starsieve.plist` (daily 08:17, not at load, the login shell's PATH, logs in `~/Library/Logs/starsieve/`) and loads it with `launchctl bootstrap`. A job left under the old label `com.adonis.starsieve` is booted out and its plist removed first; `schedule status` and `schedule uninstall` also find it. Its command carries `--no-push` until `schedulePush` is `true` in the config, and `--max-batches` from `scheduleMaxBatches`; install again after changing either.

## Agent Skill

`skills/starsieve/SKILL.md` is the Agent Skill for this CLI. It only routes natural-language requests to `starsieve` commands with `--json` (for example "find that MCP server I starred" becomes `list --store <s> --q "mcp server" --json`); it never reads or edits store files itself, so every capability is a CLI command first. Its `metadata.version` follows the `version` in `package.json`.

## Development

```sh
pnpm test
```

Tests use `node:test`. `classify` tests run `src/testing/fake-agent.js` instead of a real agent CLI.
