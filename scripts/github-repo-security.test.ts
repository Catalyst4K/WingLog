import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LATEST_RELEASE_URL } from '../src/main/updates/update-check'

describe('github-repo-security.sh', () => {
  it('applies the settings to the public WingLog repo when no repo is named', () => {
    const script = readFileSync(resolve(__dirname, 'github-repo-security.sh'), 'utf8')
    const defaultRepo = script.match(/^REPO="\$\{1:-([^}]+)\}"$/m)?.[1]
    // The same repo the app's update check reads its releases from.
    const appRepo = LATEST_RELEASE_URL.match(/\/repos\/([^/]+\/[^/]+)\//)?.[1]
    expect(appRepo).toBe('Catalyst4K/WingLog')
    expect(defaultRepo).toBe(appRepo)
  })
})
