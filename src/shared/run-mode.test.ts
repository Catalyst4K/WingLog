import { describe, expect, it } from 'vitest'
import { appCapabilities, defaultRunMode, effectiveRunMode, parseRunMode } from './run-mode'

describe('parseRunMode', () => {
  it('reads the two modes and nothing else', () => {
    expect(parseRunMode('host')).toBe('host')
    expect(parseRunMode('client')).toBe('client')
    expect(parseRunMode('Host')).toBeNull()
    expect(parseRunMode('')).toBeNull()
    expect(parseRunMode(null)).toBeNull()
    expect(parseRunMode(undefined)).toBeNull()
  })
})

describe('defaultRunMode', () => {
  it('is the host where the sim can run and a client elsewhere', () => {
    expect(defaultRunMode(true)).toBe('host')
    expect(defaultRunMode(false)).toBe('client')
  })
})

describe('effectiveRunMode', () => {
  it('is always the host in a build without multi-device, whatever was stored or the platform', () => {
    expect(effectiveRunMode('client', false, true)).toBe('host')
    expect(effectiveRunMode(null, false, false)).toBe('host')
  })

  it('is always a client on a computer that cannot host the sim, even if host was stored', () => {
    expect(effectiveRunMode('host', true, false)).toBe('client')
    expect(effectiveRunMode(null, true, false)).toBe('client')
  })

  it('uses the stored choice on a computer that can host, and the default the first time', () => {
    expect(effectiveRunMode('client', true, true)).toBe('client')
    expect(effectiveRunMode('host', true, true)).toBe('host')
    expect(effectiveRunMode(null, true, true)).toBe('host')
  })
})

describe('appCapabilities', () => {
  it('reports the run mode with what it was decided from', () => {
    expect(appCapabilities('client', true, true)).toEqual({ runMode: 'client', canHostSim: true, multiDevice: true })
    expect(appCapabilities(null, true, false)).toEqual({ runMode: 'client', canHostSim: false, multiDevice: true })
    expect(appCapabilities('client', false, true)).toEqual({ runMode: 'host', canHostSim: true, multiDevice: false })
  })
})
