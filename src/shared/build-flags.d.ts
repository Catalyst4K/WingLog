/**
 * Build-time constants injected via electron.vite.config.ts's `define` (esbuild/rollup
 * replaces the identifier at build time, not a runtime lookup) — see
 * docs/plans/public-release-v1.md's cloud-sync decision. Ambient only: there's no runtime
 * value to import, `__WINGLOG_CLOUD_SYNC_ENABLED__` is just a global identifier the bundler
 * substitutes with a literal `true`/`false` wherever it's referenced, in both the main
 * process (src/main/index.ts) and the renderer (SettingsView.tsx).
 */
declare const __WINGLOG_CLOUD_SYNC_ENABLED__: boolean
