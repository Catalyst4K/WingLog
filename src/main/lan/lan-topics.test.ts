import { describe, expect, it } from 'vitest'
import type { LiveSnapshot } from '@shared/live'
import { LAN_TOPICS, lanTopicsOf } from './lan-topics'

describe('lanTopicsOf', () => {
  it('keeps the topics a device is sent and drops the others', () => {
    const snapshot = {
      simConnectionStatus: { connected: true },
      settingsChanged: { x: 1 }
    } as unknown as LiveSnapshot
    const topics = lanTopicsOf(snapshot)
    expect(LAN_TOPICS).toContain('simConnectionStatus')
    expect(topics).toEqual({ simConnectionStatus: { connected: true } })
  })

  it('is empty when the hub has no value yet', () => {
    expect(lanTopicsOf({})).toEqual({})
  })
})
