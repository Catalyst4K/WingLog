import { test } from '@playwright/test'

/**
 * Skips a multi-device test in a release-style build, where the run mode cannot be chosen, and fails it in the multi-device run
 * (`npm run test:e2e:multi` sets WINGLOG_E2E_MULTI=1): a run that was meant to launch clients must never go green by skipping every one of
 * them (a client that failed to start on every launch passed a whole e2e run that way, 2026-11-22).
 *
 * @param multiDevice Whether the built app has the multi-device flag (`appGetCapabilities().multiDevice`).
 */
export function skipWithoutMultiDevice(multiDevice: boolean): void {
  if (multiDevice) return
  if (process.env['WINGLOG_E2E_MULTI'] === '1') {
    throw new Error(
      'The multi-device run needs a build made with WINGLOG_MULTI_DEVICE=1, and this build has no such flag'
    )
  }
  test.skip(true, 'needs a build with WINGLOG_MULTI_DEVICE=1')
}
