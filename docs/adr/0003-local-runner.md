# The daily run happens on the owner's Mac, and the browser is driven by a script, not by the model

X likes and bookmarks are read from the owner's logged-in browser profile (`Default` in ego-browser) at `x.com/i/history/likes` and `x.com/i/history`. Grok Bot can read them only through its paid X plugin and refuses to use a browser for personal X data, so the daily run moved to the Mac: a LaunchAgent runs `starsieve run` every day at 08:17, and a missed run starts on wake. The dedicated Grok Bot is no longer part of the pipeline.

Collection is a deterministic ego-browser script. The model never touches the logged-in X session, because post text is untrusted and a session that can post or send messages must not be steered by it.

Because everything runs under the owner's own `gh` login, GitHub Lists are synced by the CLI on the Mac after the public PR merges. No classic `user` token is stored in CI.

## Considered Options

- Grok Bot with the X plugin: rejected by the owner (paid X API credits).
- Grok Bot in the cloud with Lists synced from a CI secret: superseded, it only made sense while credentials lived on a shared cloud computer.
- Letting the agent browse X itself: rejected, prompt injection from post text could act through the logged-in session.

## Consequences

- No run on days the Mac stays off; the Heartbeat check in CI opens an issue after 48 hours.
- Collection must fail loudly when the profile is logged out (redirect to `/i/jf/onboarding`), never report "nothing new".
- The likes list has no cursor and is not ordered by post time. Daily collection stops after N consecutive known links; Backfill is a one-time long scroll that saves as it goes.
