/**
 * The renderer's one way to reach the main process for queries and local actions
 * (coding-standards.md §9): every call goes through `winglogApi()`, so the transport behind
 * `window.winglog` is swapped in one place when the app talks to another device's host (v2.x).
 * Live state and the remote-safe commands go through `LiveClient` instead.
 *
 * Looks `window.winglog` up on every call rather than capturing it once, so renderer tests that
 * replace the mock between tests keep working.
 */
import type { WingLogApi } from '@shared/ipc'

/**
 * The typed API of the main process.
 *
 * @returns The preload's `WingLogApi`.
 */
export function winglogApi(): WingLogApi {
  return window.winglog
}
