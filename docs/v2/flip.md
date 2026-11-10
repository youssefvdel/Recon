# The flip — one commit, in this order

The v2 shell lives behind `?v2=1` so the app kept working while it was built. The
flip is the commit that makes it *the* app and deletes the old one. Doing it in
two steps is how a repo ends up with two apps in it, so it is one commit and this
is the order inside it.

## Before touching anything

```
bun run verify                 # build + lint + 22 checks + pure rust + bun tests
bun run uicheck                # legacy pass AND v2 pass, per-route height + containers
```

`uicheck` must show **every v2 route passing**: `now`, `matches`, `prep`, the six
tools, `settings`. A route that reports `n/a (not a v2 destination)` means that
surface is not reachable yet — stop, do not flip.

## The commit

1. **Make v2 the default.** Drop the `?v2=1` gate in `src/main.tsx`; render
   `Shell` unconditionally.
2. **Delete the old shell with it** — `App.tsx`'s sidebar, the tab model, the
   legacy surfaces the v2 versions replace. Not "later": a route nobody can reach
   is dead code that still compiles, and dead code is where a second app grows.
3. **Delete the legacy route entries from `scripts/uicheck.ts`** (the
   `?fixture=lobby` pass) and drop the `old vs v2` comparison — there is only one
   app, so the comparison is now a lie.
4. **Keep the two exceptions honest**: `Overview`/`Now` is the only route allowed
   to exceed one viewport, and the allow-list entry must say why ("the feed is the
   page"), because the check's value is that the exception is written down.
5. **Grep before committing**: no `?v2`, no `Surface not built yet`, no import of a
   deleted component. A stale import is how the old shell comes back.

## After the flip

- `bun run uicheck` — one pass, every route green, no `n/a` left.
- `bun run verify` — still green.
- Screenshot the three destinations plus the tools sheet into `docs/v2/after/`.
- Cut the release. The flip is the first build where the app and the design are
  the same thing, so it is worth its own version number.

## Rollback

The tag before the flip is the rollback point. Say that in the release notes, so
nobody has to guess which build was the last one with the old shell.
