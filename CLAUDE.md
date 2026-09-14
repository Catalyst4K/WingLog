# WingLog

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
or `docs/decisions.md`, never here — see `flightdeck-backend`'s `CLAUDE.md` ("WingLog's
plan-doc workflow") for the full workflow.

## Working conventions

The plan-doc workflow (how a new piece of work gets designed and branched), the full
branching model (`main`/`develop`/`fixes`/`fix/<name>`), and the two-machine sync protocol
all live in `flightdeck-backend`'s `CLAUDE.md` now, not here (moved 2026-09-13 — see
`flightdeck-backend`'s `docs/decisions.md` for why). They're cross-repo process — how this
project gets worked on — not something specific to this codebase, and keeping a second copy
here would be exactly the drift risk that file's own Security cross-reference already avoids
in the other direction. **Read it and treat its rules as binding here too**, the same way
that file already treats this file's Security section as binding there.

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

`npm run package:win` builds the installer into `release/`. It's well over the file-sending
size limit — don't attempt to send it in chat. Once it's built, just point to the
directory (`release/`) rather than trying to deliver the file itself.

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
  Never hand-edit `winglog.db` or a migration file after it's been applied.
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
- **Don't hand work off to a session on the other machine unless you've been asked to, for
  that specific piece of work.** Work sometimes runs in parallel across two machines (see
  `flightdeck-backend`'s `CLAUDE.md`, "Working across two machines"), and delegating is
  genuinely useful — but "hand this batch off" is authorisation for that batch, not a
  standing arrangement to keep doing it. Finish the plan or the investigation, report back,
  and let the delegation be an explicit choice each time.

## Spike-first discipline

For anything depending on a real external system whose behaviour isn't documented —
SimConnect, SimBrief's JSON schema, GSX's receipt files, a future Navigraph integration —
write a throwaway script or read real captured data first, confirm actual behaviour, *then*
build the production version. Don't build any of it from assumptions. Log anything
surprising in `flightdeck-backend`'s matching `docs/*-notes.md` file (`simconnect-notes.md`,
`simbrief-notes.md`, and so on) as you find it. (The original M1/M6 milestones this rule is
named for are long since done; the discipline they set outlived them.)

## Security

**The GitHub repo is public** (`github.com/Catalyst4K/WingLog`), and the app is
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

**A second trust boundary exists: the backend-service WingLog talks to over HTTPS**
(a credential broker for SimBrief and Navigraph, living in its own private repo,
`flightdeck-backend` — not this one). It changes how a couple of the rules above apply:
- The base URL is one constant (matching the `simvars.ts` discipline above), always
  `https:`, never sprinkled through the codebase.
- Its responses are external data like any other third-party input — parse them
  defensively, same as OFP/GSX JSON.
- Nothing about its implementation, secrets, or deployment belongs in this repo. If you're
  ever asked to change how WingLog talks to it, that's a change to `src/main/backend/`
  calling an existing deployed endpoint — not a reason to touch, vendor, or inline anything
  from the other repo.

For the repo itself, these are worth having on and are free for public repos: Dependabot
alerts, secret scanning with push protection, and branch protection on `main`, `develop`
and `fixes` blocking force-push and branch deletion. `main` also requires a pull request
to merge into it (0 required approvals — still solo, just a forced PR+diff step instead
of a plain push), matching the branching model in `flightdeck-backend`'s `CLAUDE.md`;
`develop`/`fixes` deliberately don't require a PR, since that's where day-to-day
`plan/<name>`/`fix/<name>` branches merge and this is developed solo, pushing directly from
more than one machine — see `scripts/github-repo-security.sh` for the full rationale on
both. Note that GitHub Actions workflows here run on `pull_request` from forks — never add
a workflow that exposes secrets to fork PRs (`pull_request_target` with a checkout of the
PR head is the classic mistake).

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

**Three layers, per `flightdeck-backend`'s `docs/plans/test-coverage.md`** (100% of
business logic is the target; see that plan for the current real number and the exclusion
list — Electron bootstrap, preload, vendored `components/ui/**`):

- **Unit** (`vitest.config.ts`'s `'unit'` project, `node` environment, `*.test.ts`) — the
  original main-process/shared/pure-logic suite described above.
- **Renderer integration** (the `'renderer'` project, `jsdom`, `*.test.tsx`) — real React
  components rendered with `@testing-library/react`, mocking only `window.winglog` (the one
  seam the renderer is allowed to cross per this file's own Rules section) — never mock a
  child component or a hook just to isolate one, since that stops testing the real wiring.
- **Acceptance** (`e2e/*.spec.ts`, Playwright, `npm run test:e2e`) — drives the real built
  app (`npm run build`'s `out/`), never the dev server. Every test launches its own isolated
  instance via `e2e/launch-app.ts`'s `launchApp()`, which passes `--user-data-dir` pointed
  at a fresh temp directory — **never launch Electron for a test any other way**: the
  project root directory must be the first arg (not the entry script path — that breaks
  `app.getAppPath()` and crashes migration), and the launching environment must not have
  `ELECTRON_RUN_AS_NODE` set (leaks in from a shell that ran `npm test` earlier and breaks
  the Electron launch with a cryptic `bad option` error) — `launchApp()` already handles
  both, so use it rather than calling `_electron.launch()` directly.

`npm run test:coverage` runs the unit + renderer suites with coverage and checks the
threshold in `vitest.config.ts` — a ratchet, raised as real coverage improves, not the
100% target itself; never lower it to make a red build green.

**Going forward (rule as of 2026-09-12 — see `flightdeck-backend`'s `docs/decisions.md`):
every new feature and every fix carries its own tests in the right layer(s) above, written
as part of the same branch, not backfilled later.** `test-coverage.md` exists to close the
gap from years of code that shipped without this; the rule here is what keeps that gap from
reopening. Before writing code, identify which layer(s) the change actually needs — most
changes need only one:

- **Pure logic** (a calculation, a parser, a state-machine transition, a formatter, a new
  IPC handler's validation) → a unit test with real representative values for the case at
  hand, not placeholders — the standard this file already asks of the phase-detection state
  machine and the landing-analysis maths above.
- **A renderer component's rendering or interaction, new or changed** → a renderer
  integration test, mocking only `window.winglog` per the rule above.
- **A new or changed user-facing flow** → a Playwright acceptance test, new or extended.

A change spanning more than one layer (e.g. a new IPC channel backing a new UI control)
needs a test in each layer it touches. This applies equally to a `plan/<name>` branch and a
`fix/<name>` branch — a fix with no regression test is exactly the kind of gap this rule
exists to prevent. The coverage ratchet in `vitest.config.ts` is the backstop, not the
target: it only proves nothing dropped, not that the right things were tested, so use the
judgement above rather than writing tests to satisfy the number.

**Run the full suite only at a real checkpoint (rule as of 2026-09-13 — see
`flightdeck-backend`'s `docs/decisions.md`).** The rule above is about what gets *written* —
every change still needs its own real, relevant tests, every time. This rule is about how
often the *whole* suite gets *re-run*: during day-to-day iteration on a change, run only the
test file(s) actually relevant to what changed, not a full `npm test` / `npm run
test:coverage` across all 80+ files each time. Run the complete battery —
`typecheck` + `lint` + `test` + `test:coverage` + `build` — at a real checkpoint instead:
opening or updating a PR, merging a branch, running `npm run package:win`, or cutting a
release. If genuinely unsure whether a change is small enough to skip the full battery,
run it rather than guess wrong on something that gates a release.
