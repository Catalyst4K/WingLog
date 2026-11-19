import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from './client'
import {
  addLanDevice,
  findActiveLanDevice,
  listLanDevices,
  revokeLanDevice,
  revokeLanDevicesOfKind,
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
    expect(findActiveLanDevice(db, 'hash-a')).toEqual({ id, kind: 'screen' })
    expect(findActiveLanDevice(db, 'hash-b')).toBeNull()
    expect(findActiveLanDevice(db, '')).toBeNull()
  })

  it('lists devices without any token material, oldest first, with when each was last seen', () => {
    const db = freshDb()
    const a = addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    addLanDevice(db, 'Phone', 'hash-b', '2026-10-12T11:00:00.000Z')
    touchLanDevice(db, a, '2026-10-12T12:00:00.000Z')
    expect(listLanDevices(db)).toEqual([
      {
        id: a,
        kind: 'screen',
        name: 'iPad',
        createdAt: '2026-10-12T10:00:00.000Z',
        lastSeenAt: '2026-10-12T12:00:00.000Z'
      },
      {
        id: a + 1,
        kind: 'screen',
        name: 'Phone',
        createdAt: '2026-10-12T11:00:00.000Z',
        lastSeenAt: null
      }
    ])
  })

  it('keeps what a device is: a second screen unless it was paired as a twin', () => {
    const db = freshDb()
    const screen = addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    const twin = addLanDevice(db, 'WingLog on MAC', 'hash-b', '2026-10-12T10:05:00.000Z', 'twin')
    expect(findActiveLanDevice(db, 'hash-a')).toEqual({ id: screen, kind: 'screen' })
    expect(findActiveLanDevice(db, 'hash-b')).toEqual({ id: twin, kind: 'twin' })
    expect(listLanDevices(db).map((d) => [d.name, d.kind])).toEqual([
      ['iPad', 'screen'],
      ['WingLog on MAC', 'twin']
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

  it('revokes every twin at once and leaves the phones and the twins already revoked alone', () => {
    const db = freshDb()
    const phone = addLanDevice(db, 'iPad', 'hash-phone', '2026-10-12T10:00:00.000Z')
    addLanDevice(db, 'WingLog on MAC', 'hash-a', '2026-10-12T10:00:00.000Z', 'twin')
    const twinB = addLanDevice(db, 'WingLog on LAPTOP', 'hash-b', '2026-10-12T10:00:00.000Z', 'twin')
    revokeLanDevice(db, twinB, '2026-10-12T11:00:00.000Z')
    expect(revokeLanDevicesOfKind(db, 'twin', '2026-10-12T12:00:00.000Z')).toBe(1)
    expect(findActiveLanDevice(db, 'hash-a')).toBeNull()
    expect(findActiveLanDevice(db, 'hash-phone')).toEqual({ id: phone, kind: 'screen' })
    expect(listLanDevices(db).map((d) => d.id)).toEqual([phone])
    expect(revokeLanDevicesOfKind(db, 'twin', '2026-10-12T13:00:00.000Z')).toBe(0)
  })

  it('refuses two devices with the same token hash', () => {
    const db = freshDb()
    addLanDevice(db, 'iPad', 'hash-a', '2026-10-12T10:00:00.000Z')
    expect(() => addLanDevice(db, 'Other', 'hash-a', '2026-10-12T10:01:00.000Z')).toThrow()
  })
})
