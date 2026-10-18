import { describe, expect, it } from 'vitest'
import { resolveBuildFlags } from './resolve-build-flags'

describe('resolveBuildFlags', () => {
  it('turns cloud sync on under electron-vite dev', () => {
    expect(resolveBuildFlags('serve', {})).toEqual({ cloudSyncEnabled: true, devBuild: false })
  })

  it('turns cloud sync on in the dev build', () => {
    expect(resolveBuildFlags('build', { WINGLOG_DEV_BUILD: '1' })).toEqual({
      cloudSyncEnabled: true,
      devBuild: true
    })
  })

  it('keeps cloud sync off in a release build with no flags', () => {
    expect(resolveBuildFlags('build', {})).toEqual({ cloudSyncEnabled: false, devBuild: false })
  })

  it('does not treat other values of the flags as on', () => {
    expect(
      resolveBuildFlags('build', { WINGLOG_DEV_BUILD: 'true', WINGLOG_CLOUD_SYNC: '0' }).cloudSyncEnabled
    ).toBe(false)
  })

  it('lets a private build opt in with WINGLOG_CLOUD_SYNC=1', () => {
    expect(resolveBuildFlags('build', { WINGLOG_CLOUD_SYNC: '1' })).toEqual({
      cloudSyncEnabled: true,
      devBuild: false
    })
  })
})
