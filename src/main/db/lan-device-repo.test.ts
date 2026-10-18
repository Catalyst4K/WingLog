import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from './client'
import {
  addLanDevice,
  findActiveLanDevice,
  listLanDevices,
  revokeLanDevice,
  touchLanDevice
} from './lan-device-repo'

function freshDb() {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

describe('lan device repo', () => {
  it('finds a paired device by its token hash and not by anything else', () => {
    const db = freshDb()
    const id = addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    expect(findActiveLanDevice(db, 'hash-a')).toBe(id)
    expect(findActiveLanDevice(db, 'hash-b')).toBeNull()
    expect(findActiveLanDevice(db, '')).toBeNull()
  })

  it('lists devices without any token material, oldest first, with when each was last seen', () => {
    const db = freshDb()
    const a = addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    addLanDevice(db, 'Phone', 'hash-b', '2026-10-12T11:00:00.000Z')
    touchLanDevice(db, a, '2026-10-12T12:00:00.000Z')
    expect(listLanDevices(db)).toEqual([
      { id: a, name: 'iPad', createdAt: '2026-10-12T10:00:00.000Z', lastSeenAt: '2026-10-12T12:00:00.000Z' },
      { id: a + 1, name: 'Phone', createdAt: '2026-10-12T11:00:00.000Z', lastSeenAt: null }
    ])
  })

  it('stops a revoked device working at once and drops it from the list', () => {
    const db = freshDb()
    const id = addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    expect(revokeLanDevice(db, id, '2026-10-12T13:00:00.000Z')).toBe(true)
    expect(findActiveLanDevice(db, 'hash-a')).toBeNull()
    expect(listLanDevices(db)).toEqual([])
    expect(revokeLanDevice(db, id, '2026-10-12T14:00:00.000Z')).toBe(false)
    expect(revokeLanDevice(db, 999, '2026-10-12T14:00:00.000Z')).toBe(false)
  })

  it('refuses two devices with the same token hash', () => {
    const db = freshDb()
    addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    expect(() => addLanDevice(db, 'Other', 'hash-a', '2026-10-12T10:01:00.000Z')).toThrow()
  })
})
