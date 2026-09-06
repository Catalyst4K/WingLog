# Flightdeck

Electron + React + TypeScript desktop app for tracking flights in Microsoft Flight
Simulator 2024: fleet management, SimBrief dispatch, live SimConnect tracking, and a
logbook with landing analysis. Runs locally against a local SQLite database.

**All development documentation for this project — architecture, data model, milestone
history, the decision log, and design docs for ongoing work — lives in the private
`flightdeck-backend` repo, not here.** Read its `PLAN.md` and `docs/decisions.md` in full
before doing any non-trivial work; this file only carries what's needed to make routine
code changes in *this* repo day to day. `flightdeck-backend` needs to be cloned (or
otherwise readable) alongside this repo to follow that instruction — if it isn't
available, ask before assuming a default rather than guessing at unrecorded context.

This repo's own `docs/` folder holds nothing but user-facing content (or is currently
empty) — no development history, decisions, or plans belong here. If you're about to
write a design doc or record a decision, it goes in `flightdeck-backend`'s `docs/plans/`
or `docs/decisions.md`, never here — see "Starting a new piece of work" below.

## Starting a new piece of work

This is a working app, not a from-scratch build. Ongoing feature work is organized as
design docs (in `flightdeck-backend`, see above), not numbered milestones:

1. Check `flightdeck-backend`'s `PLAN.md` §10 and `git branch -a` here for the current
   list of `plan/<name>` branches. If the user's request matches one, read its plan doc
   (`flightdeck-backend/docs/plans/<name>.md`) in full before touching code — it carries
   context (what's verified against real data, what's still open) that isn't repeated
   anywhere else.
2. For a genuinely new feature with no existing plan: write one, following the shape of
   the existing plans (context, what's confirmed vs. assumed, implementation, open
   questions), in `flightdeck-backend`'s `docs/plans/<name>.md` — before writing
   production code, same spike-first discipline as the M1/M6 rule below, generalised to
   any undocumented external system (a third-party API, an undocumented file format), not
   just SimConnect. The `plan/<name>` feature branch itself is created off `develop` (see
   "Branching" below) and built in *this* repo, exactly as always — only the design doc's
   location is different.
3. One plan, one branch, one PR into `develop`. Don't mix unrelated changes into a plan
   branch.
4. A plan branch merging into `develop` is progress, not the finish line — its design doc
   doesn't move yet, since `develop` can carry work that hasn't reached a release. A plan
   only counts as shipped once `develop`'s changes actually reach `main` on a release cut
   (see "Branching" below); that's the point its design doc moves from
   `flightdeck-backend/docs/plans/` to nowhere — it just stays there, done. Nothing about
   a shipped plan's doc needs to come back to this repo.

## Branching

Adopted 2026-09-04 (`flightdeck-backend`'s `docs/decisions.md` has the full reasoning) to
keep `main` a clean release history instead of every finished plan landing on it
individually:

- **`main`** — releases only. Requires a pull request to merge into (still solo: 0
  required approvals, so merging your own PR is enough) and is protected against
  force-push/deletion, same as before. The only things that should ever merge into `main`
  are `develop` or `fixes`, batched up as a release.
- **`develop`** — where finished feature work lands first. Every `plan/<name>` branch
  targets `develop`, not `main`. Direct pushes/merges into `develop` are still fine (no
  required PR there) — that's the low-friction, solo-dev workflow this project has always
  used, just one branch removed from `main` now.
- **`fixes`** — the equivalent branch for bug fixes: a `fix/<name>` branch per fix,
  targeting `fixes`, same direct-push workflow as `develop`. Kept separate from `develop`
  so a batch of bug fixes can go out as its own release without waiting on whatever
  feature work happens to be in flight on `develop`.
- **Cutting a release** means opening a PR from `develop` (or `fixes`) into `main` once a
  meaningful batch is ready, merging it, and *then* moving every plan doc that just
  reached `main` out of `flightdeck-backend/docs/plans/`, per step 4 above. Tag the merge
  commit on `main` if it corresponds to a version bump.
- Plan branches already open before this date (`plan/backend-service`,
  `plan/sid-star-selection`) were **not** retargeted onto `develop` — not worth the churn
  mid-flight. They still merge straight into `main` (via a PR, now required) when done.
  Every plan branch created from here on targets `develop`.

The M1/M6 rule generalises: for anything depending on a real external system whose
behaviour isn't documented — SimConnect, SimBrief's JSON schema, GSX's receipt files, a
future Navigraph integration — write a throwaway script or read real captured data first,
confirm actual behaviour, *then* build the production version. Don't build any of it from
assumptions. Log anything surprising in `flightdeck-backend`'s matching `docs/*-notes.md`
file (`simconnect-notes.md`, `simbrief-notes.md`, and so on) as you find it.

## Commands (once scaffolded)

```
npm run dev          # electron-vite dev
npm run build         # production build
npm run test           # vitest
npm run lint            # eslint
npm run typecheck        # tsc --noEmit
npm run db:generate       # drizzle-kit generate, from src/main/db/schema.ts
npm run db:migrate         # apply migrations
```

## Layout

```
src/main/       Electron main process. Sim connector, DB, SimBrief client, IPC handlers.
src/preload/    contextBridge exposure only — no logic here.
src/renderer/   React UI. Never imports from src/main except via src/shared types.
src/shared/     Types and constants used by both main and renderer.
scripts/        One-off spikes and data import scripts (e.g. OurAirports import).
docs/           User-facing content only, or empty — see the note at the top of this file.
```

## Rules

- The renderer never touches the filesystem, network, or SimConnect directly. Every
  side effect crosses a typed IPC channel defined in `src/shared/ipc.ts`.
- SimVar names, units, and per-aircraft-type overrides live only in
  `src/main/sim/simvars.ts`. Don't scatter SimVar strings through the codebase.
- Every schema change is a Drizzle migration, generated via `npm run db:generate`.
  Never hand-edit `flightdeck.db` or a migration file after it's been applied.
- Anything that sends data off the machine, stores credentials, or introduces an account
  or a server is a **decision, not an implementation detail**. Propose it, get agreement,
  and record it in `flightdeck-backend`'s `docs/decisions.md` before building it. Nothing
  is ruled out — but nothing arrives by accident either, and the default stays local. The
  backend-service credential broker is the first case of this actually happening — SimBrief
  and Navigraph access built in rather than every user requesting their own key — not a
  hypothetical the rule is guarding against anymore.
- Prefer a boring, working implementation over a clever one. This is a personal tool
  flown solo, not a platform.
- Convert units at the IPC boundary (SI internally, aviation units only at the UI layer)
  — don't let sim-native and SI units mix inside the same layer.

## Security

**The GitHub repo is public** (`github.com/Catalyst4K/flightdeck`), and the app is
distributed as an installable binary. Both mean mistakes here are visible and shipped, so
treat security as part of finishing a change rather than a separate pass.

Before committing or pushing:

- **Never commit secrets.** No API keys, tokens, cookies, or credentials — not in source,
  not in test fixtures, not in a `docs/` note, not in a commit message. Real cases already
  live in this project: the SimBrief username, and the Navigraph OAuth tokens the SID/STAR
  work will need. Those belong in the `app_setting` table at runtime, never in the repo.
  The backend service's own credentials (the SimBrief signing key, the Navigraph
  `client_secret`) are a stricter case of the same rule: they never touch *this* repo at
  all, in any form — not as a value, and not as platform env vars either, since this repo
  isn't where that service lives. See the backend-service paragraph below.
- **A third party's protected mechanism is not "a secret" in the API-key sense, but treat
  it the same way.** SimBrief's real request-signing scheme is deliberately not documented
  in this repo — not in prose, not in code, not even in a "throwaway" spike. A working
  implementation of a keyed signature scheme discloses it more completely than any
  paraphrase would, so "it's just code, not a description" is not an exception — a real
  case of exactly this mistake happened and was corrected (`flightdeck-backend`'s
  `docs/decisions.md`, 2026-09-04). If a future spike needs to exercise a mechanism like
  this, run it locally, capture only the safe findings in `flightdeck-backend`'s matching
  `docs/*-notes.md`, and don't commit the script itself here.
- **Check what a broad `git add` actually staged** (`git status` after it) and read any
  file whose name doesn't obviously explain its contents.
- **Scrub personal data out of test fixtures.** Real OFPs carry a SimBrief pilot ID; real
  GSX receipts carry tail numbers, airports and prices. Fixtures should be trimmed and
  anonymised, not pasted whole.

When touching anything that crosses a trust boundary, actively look for the vulnerability
rather than assuming there isn't one:

- **External data is data, never code.** OFP JSON, GSX receipt JSON, imported CSVs and
  SimConnect strings are all third-party input. No `eval`, no `new Function`, no
  `innerHTML`/`dangerouslySetInnerHTML` with it. Parse defensively — a malformed field
  should degrade, not throw or execute.
- **URLs handed to `shell.openExternal`.** Dispatch builds SimBrief URLs from user input
  and DB values; anything interpolated must be `encodeURIComponent`'d, and the scheme must
  be `https:` — never pass through a URL derived from third-party data without checking
  its scheme, since `file:` and other schemes can do real damage.
- **File paths from outside the app.** Import/export dialogs and the planned GSX receipts
  reader all take paths that didn't come from us. Resolve them and confirm they're inside
  the directory you expect before reading or writing.
- **Queries go through Drizzle's query builder**, which parameterises. If you ever reach
  for raw `sql`` `` with a runtime value in it, that's the moment to stop and ask why.
- **The renderer is not a security boundary.** `sandbox: false` is set on the
  `BrowserWindow` (needed for the preload), so a renderer compromise is serious. Keep
  every side effect behind a typed IPC channel that validates its input in the main
  process — the renderer's checks are for the user's benefit, not the app's safety. Never
  load remote content into a window.
- **New dependencies are supply chain.** Prefer few, well-known packages. Check
  `npm audit` when adding one, and keep `package-lock.json` committed. A dependency that
  wants postinstall scripts or network access at build time deserves scrutiny.

**A second trust boundary exists: the backend-service Flightdeck talks to over HTTPS**
(a credential broker for SimBrief and Navigraph, living in its own private repo,
`flightdeck-backend` — not this one). It changes how a couple of the rules above apply:
- The base URL is one constant (matching the `simvars.ts` discipline above), always
  `https:`, never sprinkled through the codebase.
- Its responses are external data like any other third-party input — parse them
  defensively, same as OFP/GSX JSON.
- Nothing about its implementation, secrets, or deployment belongs in this repo. If you're
  ever asked to change how Flightdeck talks to it, that's a change to `src/main/backend/`
  calling an existing deployed endpoint — not a reason to touch, vendor, or inline anything
  from the other repo.

For the repo itself, these are worth having on and are free for public repos: Dependabot
alerts, secret scanning with push protection, and branch protection on `main`, `develop`
and `fixes` blocking force-push and branch deletion. `main` also requires a pull request
to merge into it (0 required approvals — still solo, just a forced PR+diff step instead
of a plain push), matching the branching model above; `develop`/`fixes` deliberately don't
require a PR, since that's where day-to-day `plan/<name>`/`fix/<name>` branches merge and
this is developed solo, pushing directly from more than one machine — see
`scripts/github-repo-security.sh` for the full rationale on both. Note that GitHub Actions
workflows here run on `pull_request` from forks — never add a workflow that exposes
secrets to fork PRs (`pull_request_target` with a checkout of the PR head is the classic
mistake).

If you find something, say so plainly and fix it or flag it — don't quietly work around it.

## Testing

Vitest. Anything that depends on a running sim sits behind `SimConnectService` — write
unit tests against a mock of that interface, don't require a live sim to run `npm test`.
The phase-detection state machine and the landing-analysis maths (crosswind, centreline
offset, distance-from-threshold) need real test coverage — they're easy to get subtly
wrong and hard to eyeball.

`better-sqlite3` is a native module and `npm install` rebuilds it once, for Electron's
Node ABI (via `postinstall`) — not the system Node ABI. That's why `npm test` and
`npm run db:migrate` run through `electron` in `ELECTRON_RUN_AS_NODE=1` mode instead of
plain `node`/`tsx`: it's the same binary the app ships with, so there's only one build of
the module to keep track of. Don't "simplify" these scripts back to bare `vitest`/`tsx` —
that reintroduces an ABI mismatch and the native module fails to load.
