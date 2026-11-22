# Store everything privately first; publish only a filtered projection

Every Item goes to the Private Store first. `starsieve publish` builds the Public Projection before anything is pushed: only Items with Visibility public, minus stars of private repositories, with X Items reduced to link, author handle, post time, Category, Summary and Tags (never the post text). A PR to the public repository is public the moment it is pushed and git history cannot be cleaned reliably, so the filter must run before the push. The required check on the PR is only a second line of defense.

## Considered Options

- Commit everything to one repository and filter at render time: rejected, raw X data and private-repo stars would be public in git history.
- Rely on the PR check to reject private Items: rejected, the PR branch is already public when the check runs.
