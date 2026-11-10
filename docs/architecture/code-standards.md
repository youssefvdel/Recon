# Code standards — the rules the split follows

Mechanical rules first, because "best practice" without a number is an opinion.

## Size and shape

- **400 lines is the ceiling for a module**, 250 for a component. Beyond that the
  file is hiding more than one responsibility.
- **One exported concept per file.** If the filename needs "And", split it.
- **No barrel files.** Import from the module that owns the symbol; a barrel
  hides cycles and defeats tree-shaking.
- **No file imports from a sibling's internals.** If it needs it, the symbol
  belongs in a shared module with a name.

## Naming

- `sources/` — reads one external system, returns validated data or throws.
- `model/` — types and pure derivations over them. No I/O, no React.
- `cache/` — owns its prefix, derives its generation, evicts safely.
- `live/` — the match state machine. No rendering.
- `components/` — render a `Field<T>`; never fetch, never validate.

## Behaviour preservation (the split contract)

1. **Moves only.** A split commit may not change behaviour. If a bug is found on
   the way, fix it in a **separate** commit with its own test.
2. **Diff legibility.** A reviewer must be able to check the move by reading
   removed-vs-added, not by re-reading the app.
3. **No renaming during a move.** Rename later, separately, or the diff becomes
   unreadable.
4. **Exports stay stable until the last move of a series**, so the app compiles
   at every step.

## Errors

- Every external response goes through one validated reader. A parser accepts
  `Validated<T>`, never `unknown`.
- A failed read returns stale-marked data or an error — never a zero, never a
  default that looks like data.
- Errors carry a source and an `asOf`; "unknown" is a value, not an absence.

## State

- One `Field<T>` shape for data-bearing UI: `{ value, source, asOf, state,
  startedAt? }`. Pending has a deadline; it becomes `error` when it expires.
- No boolean flags named `loading`/`error` alongside the data they describe.

## Checks that must stay green after every split

`bun run build:ui`, `bun run lint`, every `scripts/*-check.ts`, and the grep
invariants from `judge-checklist.md` (C16–C22). A split that turns any of them
red is reverted, not "fixed forward".
