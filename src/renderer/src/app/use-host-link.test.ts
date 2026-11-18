import { describe, expect, it } from 'vitest'
import type { HostLinkState } from '@shared/ipc'
import { hostLinkLight } from './use-host-link'

describe('hostLinkLight', () => {
  it('is green when connected and off when nothing is paired', () => {
    expect(hostLinkLight('connected')).toBe('green')
    expect(hostLinkLight('unpaired')).toBe('off')
  })

  it.each<HostLinkState>([
    'connecting',
    'offline',
    'wrong-code',
    'pair-again',
    'certificate-changed',
    'not-secure'
  ])('is amber while the link is %s: something is paired, but it is not working', (state) => {
    expect(hostLinkLight(state)).toBe('amber')
  })
})
