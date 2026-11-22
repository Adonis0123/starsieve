---
name: starsieve
description: Use when the user asks about their GitHub stars or the technical X (Twitter) posts they liked or bookmarked, as sorted by starsieve. Covers finding a starred repo or saved post ("我 star 过哪些 agent 框架", "find that MCP server I starred"), moving an Item to another Category or fixing its tags or summary ("把这个改成 CLI 工具", "recategorize"), hiding one from the public list or making it public, taking back an X post that was skipped as non-technical, running the daily collect-classify-publish pipeline now, checking whether the daily run worked ("今天的 star 同步了吗", "heartbeat"), and syncing Categories to GitHub Lists. Drives the `starsieve` CLI with `--json`; never edits the store's JSON files by hand.
metadata:
  version: "0.1.0"
  requires:
    bins: [node, gh]
  cliHelp: pnpm --dir <starsieve> starsieve --help
---

# starsieve

starsieve keeps every GitHub star and technical X like or bookmark in a Private Store (a private git repository), classifies new ones with an agent CLI, and publishes a filtered Public Projection to a public repository with a site on GitHub Pages. Terms follow `<starsieve>/GLOSSARY.md`, where `<starsieve>` is the owner's clone of the starsieve repository (this file is `skills/starsieve/SKILL.md` in it).

Run the CLI as `pnpm --dir <starsieve> -s starsieve <command> --json`. Commands that take `--store` get it from `storePath` in `~/.config/starsieve/config.json`; `run` and `lists sync` read it themselves. That config file and the run logs are the only files you read directly.

## Hard rules

- **Change Items only through `starsieve override`.** Never edit `items/*.json`, `classifications.json`, `skipped.json` or any other store file; `override` validates the change and Locks it so the Classifier never overwrites it.
- **Never try to make a private repository's star public.** `publish` drops it even after an `override --visibility public`; do not look for another way.
- **Outward actions need the user's yes each time**: `run` without `--no-push` (it pushes both repositories, opens and auto-merges a PR), `lists sync` without `--dry-run` (writes GitHub Lists), `init github` commands, `schedule install` after setting `schedulePush: true`. Show the plan from `--dry-run` first.
- Never send a private Item's text or a private repository's name to another tool or model.

## Output and exit codes

- Every `--json` output has `schemaVersion: 1`.
- Exit codes: `0` done, `1` failed, `2` malformed command line. On `1`, report the `error` text as it is and the step it names; do not retry with other flags.

## What do you want to do

| The user wants to | Run |
|---|---|
| Find stars or saved posts by topic | `list --store <s> --q "<words>" --json` (every word must match; add `--category`, `--source github\|x`, `--needs-review`, `--limit`); the user can also browse the Panel, when they run the Local Tools Portal |
| Move an Item to another Category, change tags or summary | `override <id> --store <s> --category <name> [--tags a,b] [--summary "..."] --json` (an unknown Category fails with the list of valid names) |
| Hide an Item from the public list, or publish it | `override <id> --store <s> --visibility private\|public --json` |
| Take back an X post skipped as non-technical | `override <id> --store <s> --unskip --json`; the next `collect x` stores it again |
| Classify what is pending now | `classify --store <s> --limit 25 --json`, repeat while `check` shows pending |
| Run the whole daily pipeline now | `run --no-push --json` locally; real push only after the user's yes |
| Did today's run work? | `schedule status --json` (`lastExitCode`, `noPush`), then the tail of the newest `~/Library/Logs/starsieve/run-YYYYMMDD.log`; the private repository's CI opens an issue after 48 hours without a success |
| Sync Categories to GitHub Lists | `lists sync --dry-run --json`, show the plan, then without `--dry-run` after a yes |
| Collect older X posts | `backfill x --store <s> --json`; report its size first when it may pass 500 posts |

Item ids are `github:<owner>/<repo>` and `x:<status id>`. After an `override`, the change reaches the public site with the next `run`.
