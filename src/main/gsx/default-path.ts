import { win32 } from 'node:path'

/**
 * GSX is a Windows-only product, so this only ever resolves on win32 (docs/gsx-notes.md).
 * `%APPDATA%` (`process.env.APPDATA`) is the real environment variable Windows sets for
 * this, rather than assuming `~/AppData/Roaming` — a user with a redirected profile
 * folder would otherwise get a wrong, confidently-stated path. Only used to pre-fill
 * Settings' path field when it's empty; the field stays user-editable either way, since a
 * silently-wrong detected path is worse than an empty box (docs/decisions.md).
 *
 * Uses `path.win32.join` explicitly, not the ambient `path.join` — the latter follows
 * whatever OS the current Node process is actually running on, not the win32 path this
 * function always builds once it's past the platform guard above. In production the app
 * only ever runs this on a real Windows machine, where the two happen to coincide, but a
 * real CI run on Linux found the mismatch: `test-coverage.md`'s Phase 5 e2e check
 * (flightdeck-backend's docs/plans/public-release-v1.md, 2026-09-14) was the first time
 * this ever actually ran on a non-Windows machine, and the ambient `join` silently built a
 * forward-slash path while `process.platform` was faked to `'win32'` for the test.
 */
export function defaultGsxReceiptsPath(): string | null {
  if (process.platform !== 'win32') return null
  const appData = process.env.APPDATA
  if (!appData) return null
  return win32.join(appData, 'Virtuali', 'GSX', 'Receipts')
}
