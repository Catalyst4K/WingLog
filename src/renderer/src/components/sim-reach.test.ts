import { describe, expect, it } from 'vitest'
import type { HostLinkState } from '@shared/ipc'
import type { LanLinkState } from '@shared/lan-connection'
import { simReach, simReachLight } from './sim-reach'

const NOT_WORKING: (HostLinkState | LanLinkState)[] = [
  'connecting',
  'offline',
  'wrong-code',
  'pair-again',
  'certificate-changed',
  'not-secure',
  'starting',
  'needs-pairing'
]

describe('simReachLight', () => {
  it('is off when no sim PC is paired, whatever the sim says', () => {
    expect(simReachLight('unpaired', undefined)).toBe('off')
    expect(simReachLight('unpaired', 'connected')).toBe('off')
  })

  it.each(NOT_WORKING)(
    'is red when the link is %s, even if the last heard sim state was connected',
    (link) => {
      expect(simReachLight(link, 'connected')).toBe('red')
      expect(simReachLight(link, undefined)).toBe('red')
    }
  )

  it.each(['connecting', 'disconnected', undefined])(
    'is amber when connected to the sim PC and its sim is %s',
    (sim) => {
      expect(simReachLight('connected', sim)).toBe('amber')
    }
  )

  it('is green when connected to the sim PC and its sim is connected', () => {
    expect(simReachLight('connected', 'connected')).toBe('green')
  })
})

describe('simReach', () => {
  it('names where the chain breaks', () => {
    expect(simReach('unpaired', 'connected')).toBe('unpaired')
    expect(simReach('offline', 'connected')).toBe('no-pc')
    expect(simReach('connected', 'disconnected')).toBe('no-sim')
    expect(simReach('connected', 'connected')).toBe('ready')
  })
})
