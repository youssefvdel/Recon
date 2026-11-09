# Target architecture — the plan we build against

Written after the 2026-11-08 incident chain. Evidence lives in the sibling files
(`data-sources.md`, `frontend.md`, `runtime.md`, `ui.md`, `regressions.md`).

## The shape tonight's bugs point at

Every defect had the same parent: **a rule that was correct in one place, applied
where its assumptions did not hold.**

- A guard against unreadable Riot responses, used at every call site except one.
- A pause for the webview transport, applied to a transport with no webview.
- A cache generation rule, written in the module that did not own the key.
- A version comparator that assumed a fresh manifest list.

So the target is not "more tests". It is **fewer places where a rule can be
forgotten**: boundaries that validate, owners that prune, and transports decided
before their gates are consulted.

## Layers

```
UI (components)            renders the model, never a raw response
  ↑
model/                     Player, Match, Round — normalised, immutable
  ↑
sources/riot.ts            every local Riot read; validates before returning
sources/trn.ts             optional enrichment; marks privacy, never required
  ↑
cache/                     one store, one namespace per owner, quota-safe
```

### 1. `sources/riot.ts` — the authoritative source
Riot local wins every row of the capability matrix. Every read returns a
**validated value or throws**: `assertRiotOk` moves inside `readMmr()`,
`readMatchDetails()`, `readLiveMatch()` so a caller cannot skip it. A 4xx body is
an error object, never data.

### 2. `sources/trn.ts` — optional, never load-bearing
Tracker supplies precomputed aggregates and nothing else. It carries
`?source=overwolf-2` at one construction point, records
`metadata.privacy ∈ {public, ranked}` (anything else = private), and treats
404 as `missing`. If this module were deleted, the app would still show rank,
ACS, K/D, win%, HS%, rounds, and plants — slower, not broken.

### 3. `cache/` — namespaces with owners
Each module owns one prefix and prunes only its own generations. The live prefix
is exported from the same file that declares it, and a **generation constant is
declared next to the data it describes**. Writes go through one `writeLocalSafe`
that evicts and retries instead of throwing into a caller.

### 4. Transport decided before gates
`chooseTransport(path)` runs first; then the gates for *that* transport are
evaluated. A gate that does not apply to the chosen transport is never consulted,
so "the webview is paused" cannot silence the Rust path.

### 5. UI states are evidence
No spinner without an in-flight request, no lock without `privacy != public`, no
"live" dot without a live phase, no number without a source timestamp. The TS
column becomes: value, `no profile`, `private`, or a dash — each meaning one
thing.

## Migration, not rewrite

Order matters; each step is shippable on its own.

1. **Boundaries first** — move the Riot reads behind validated functions. No UI
   change, no behaviour change; this alone kills bug class (a).
2. **Cache ownership** — move TRN pruning into `trn.ts`, declare generations
   beside their data, route writes through the quota-safe helper. Kills (b).
3. **Transport-first gating** — introduce `chooseTransport`, then delete the
   duplicated transport checks. Kills (c).
4. **Split `tracker.ts`** (4358 lines) along the boundaries the map already
   names: live state, act stats, match details, caches. Pure moves, no rewrites.
5. **Then** the UI pass: one component per surface, states from the model.

Steps 1–3 are where the bugs live. Steps 4–5 are hygiene and should not start
until 1–3 are green.

## Invariants worth enforcing in CI

- Every external response passes through a validating reader (grep: no
  `riotGet(...)` result reaches a parser unvalidated).
- A live cache prefix never appears in a prune list (asserted at import).
- Transport is chosen before any gate (asserted in the check script).
- The updater never offers a version that is not strictly greater.
- The UI never renders "loading" without an in-flight request.

## What gets deleted

- The second rank home (`liveMmrCache` + persisted rank + TRN rank) — one source,
  one store.
- The duplicate transport-decision site.
- Dead "test seam" exports in `ipc.ts`.
- Superseded key generations still written by nothing.

## What we do not do

- No full rewrite: the bugs are structural, and a rewrite reproduces the same
  structures faster.
- No Tracker dependency for anything Riot already answers.
- No new data source until the three layer boundaries above exist.
