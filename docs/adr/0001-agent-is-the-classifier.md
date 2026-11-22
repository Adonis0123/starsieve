# Any agent CLI is the Classifier, run as a pure function with no tools

starsieve has no built-in LLM and holds no model API key. For each Batch the CLI writes the Items into the prompt, runs a configured agent CLI (first `cursor-agent -p --model grok-4.7-medium`), reads one JSON object from stdout, and passes it to `apply`. Swapping to `claude -p`, `codex exec` or another agent only changes configuration. We chose this because the owner wants "any AI" to do the work, GitHub Models was retired on 2026-07-30, and a deterministic CLI keeps the agent replaceable.

The Classifier reads untrusted post text, so it runs with every tool denied: an empty workspace whose `.cursor/cli.json` denies `Shell(*)`, `Read(**)` and `Write(**)`, plus `--mode ask`. Tested on 2026-11-20: `--sandbox enabled` alone still let the agent run `gh auth status`, `curl` and write outside the workspace; `--mode ask` blocked writes but not shell; the deny list blocked all three.

## Consequences

- `apply` is the only write path for Classifications (agent, CLI or Panel). It caps Summary length and strips links and HTML, because public Items are published automatically.
- Each Batch costs agent usage; 10 Items took 166 s with Grok 4.7 medium in the first test.
