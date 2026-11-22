# starsieve architecture overview (local runner)

目标设计快照，写于 2026-11-20，不随代码更新；与代码冲突时以代码为准，并报告不一致。取代 `2026-11-20-overview.md`。

## Components

| Name | Type | Responsibility | Code path |
|---|---|---|---|
| LaunchAgent | scheduler | Runs `starsieve run` daily at 08:17 on the Mac; a missed run starts on wake | `~/Library/LaunchAgents` (installed by `starsieve schedule install`, planned) |
| starsieve CLI | backend | `run` = check → collect → pending → classify → apply → publish → lists sync; plus `override`, `publish --dry-run`, `backfill x` | `src/cli` (planned) |
| X collector | backend | Deterministic ego-browser script on profile `Default`; asserts logged-in URL; stops after N consecutive known links | `src/collect/x` (planned) |
| GitHub collector | backend | Lists starred repos via the owner's `gh` login; marks stars of private repositories | `src/collect/github` (planned) |
| Classifier runner | backend | Writes one Batch into a prompt, runs the configured agent CLI in an empty workspace with all tools denied, parses stdout JSON | `src/classify` (planned) |
| starsieve Panel | frontend | One frontend: Portal Panel via `createPanelHandler` (all Items, edits call `override`) and the public static build (Public Projection only) | `src/panel` (planned) |
| starsieve Skill | agent skill | Routes natural language to CLI commands for any agent | `skill/` (planned) |
| `<owner>/stars-private` | private repo | Every Item, raw data, Skipped Item ids, Classifications, Category Table, Backfill reach, Heartbeat | GitHub |
| `<owner>/stars` | public repo | Public Projection JSON, generated README catalog, Pages site | GitHub |
| Required check workflow | CI | Second line of defense on the public PR: schema, only data files changed, no private Item; gates auto-merge | `stars/.github/workflows` (planned) |
| Heartbeat workflow | CI | Opens an issue when the last successful run is older than 48 hours | `stars-private/.github/workflows` (planned) |
| Local Portal | local gateway | Serves the Panel at a local address from the local Private Store clone | an entry in the Portal's `portal.json` |

## Relationships

| From | To | Action | Protocol / data |
|---|---|---|---|
| LaunchAgent | starsieve CLI | Starts the daily run | `launchd` StartCalendarInterval |
| starsieve CLI | X collector | Reads new likes and bookmarks from the top of each list | `ego-browser nodejs`, profile `Default` |
| starsieve CLI | GitHub collector | Reads new stars | `gh api user/starred` |
| starsieve CLI | Classifier runner | Hands one Batch of 25 Items | prompt text |
| Classifier runner | agent CLI | Runs with `--mode ask` and `.cursor/cli.json` denying Shell, Read, Write | `cursor-agent -p --model grok-4.7-medium` (configurable) |
| agent CLI | Classifier runner | Returns Classifications | one JSON object on stdout |
| starsieve CLI | stars-private | Commits Items, Classifications, Skipped Item ids, Heartbeat | git push |
| starsieve CLI | stars | `publish` filters before push, then opens a PR with auto-merge | git + `gh pr create` / `gh pr merge --auto` |
| stars PR | Required check | Validates before merge | GitHub Actions status check |
| starsieve CLI | GitHub Lists | After merge, reads existing membership and merges Categories; never deletes | GraphQL `updateUserListsForItem` with the owner's `gh` login |
| starsieve CLI | stars | `site build` on the Mac (needs the Portal CSS tokens), committed with the Public Projection; Pages only serves the built files | git + GitHub Pages (static) |
| Local Portal | stars-private clone | Reads all Items; Panel edits call `starsieve override` | file system + CLI |
| Heartbeat workflow | owner | Opens an issue when runs stop | GitHub issue notification |
