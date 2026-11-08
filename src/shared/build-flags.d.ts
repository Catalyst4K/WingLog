/**
 * Build-time constants injected via electron.vite.config.ts's `define` (esbuild/rollup
 * replaces the identifier at build time, not a runtime lookup) — see
 * docs/plans/public-release-v1.md's cloud-sync decision. Ambient only: there's no runtime
 * value to import, `__WINGLOG_CLOUD_SYNC_ENABLED__` is just a global identifier the bundler
 * substitutes with a literal `true`/`false` wherever it's referenced, in both the main
 * process (src/main/index.ts) and the renderer (SettingsView.tsx). Decided by
 * resolve-build-flags.ts: on under `electron-vite dev` and in the dev build, off in releases.
 */
declare const __WINGLOG_CLOUD_SYNC_ENABLED__: boolean

/** True under `electron-vite dev` and in the dev build, false in a release: the multi-device work (a run mode, a link to the sim PC's
 *  WingLog, LAN sync) is unreachable until it ships. Decided by resolve-build-flags.ts, like the cloud sync flag. */
declare const __WINGLOG_MULTI_DEVICE__: boolean

/** True only in the dev build (`npm run package:win:dev`): diagnostic logging to `diag.log`,
 *  the full flight capture, and a DEV badge (winglog-backend robustness/dev-build.md). */
declare const __WINGLOG_DEV_BUILD__: boolean
