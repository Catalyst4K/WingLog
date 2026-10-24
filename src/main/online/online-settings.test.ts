import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, type WingLogDb } from '../db/client'
import { setSetting } from '../db/settings-repo'
import {
  getOnlineNetworkSettings,
  getPretendCallsign,
  getTrafficSwitches,
  setPretendCallsign,
  setOnlineNetworkSettings,
  setTrafficSwitches
} from './online-settings'

describe('online network settings', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('starts with no network and no member numbers', () => {
    expect(getOnlineNetworkSettings(db)).toEqual({ network: null, vatsimCid: null, ivaoVid: null })
  })

  it('stores and reads a network and its member numbers', () => {
    setOnlineNetworkSettings(db, { network: 'ivao', vatsimCid: '1234567', ivaoVid: '654321' })
    expect(getOnlineNetworkSettings(db)).toEqual({ network: 'ivao', vatsimCid: '1234567', ivaoVid: '654321' })
  })

  it('clears a member number sent as null or empty, and the network sent as null', () => {
    setOnlineNetworkSettings(db, { network: 'vatsim', vatsimCid: '1', ivaoVid: '2' })
    setOnlineNetworkSettings(db, { network: null, vatsimCid: '', ivaoVid: null })
    expect(getOnlineNetworkSettings(db)).toEqual({ network: null, vatsimCid: null, ivaoVid: null })
  })

  it.each(['1234567890123', 'abc', '12 34', '-5', '1e5', '١٢٣', 12345, {}])(
    'refuses the member number %j',
    (bad) => {
      expect(() =>
        setOnlineNetworkSettings(db, { network: 'vatsim', vatsimCid: bad, ivaoVid: null })
      ).toThrow('Invalid member number')
      expect(() => setOnlineNetworkSettings(db, { network: 'ivao', vatsimCid: null, ivaoVid: bad })).toThrow(
        'Invalid member number'
      )
    }
  )

  it.each(['poscon', '', undefined, 5])('refuses the network %j', (bad) => {
    expect(() => setOnlineNetworkSettings(db, { network: bad, vatsimCid: null, ivaoVid: null })).toThrow(
      'Invalid network'
    )
  })

  it.each([null, undefined, 'vatsim', 3])('refuses settings that are not an object: %j', (bad) => {
    expect(() => setOnlineNetworkSettings(db, bad)).toThrow('Invalid online network settings')
  })

  it('stores nothing when a later field is refused', () => {
    setOnlineNetworkSettings(db, { network: 'vatsim', vatsimCid: '111', ivaoVid: null })
    expect(() => setOnlineNetworkSettings(db, { network: 'ivao', vatsimCid: '222', ivaoVid: 'x' })).toThrow()
    expect(getOnlineNetworkSettings(db)).toEqual({ network: 'vatsim', vatsimCid: '111', ivaoVid: null })
  })

  it('ignores a stored value that is not a valid network or member number', () => {
    setSetting(db, 'onlineNetwork', 'poscon')
    setSetting(db, 'vatsimCid', 'not-a-number')
    expect(getOnlineNetworkSettings(db)).toEqual({ network: null, vatsimCid: null, ivaoVid: null })
  })
})

describe('the dev "Pretend I am this pilot" callsign', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('starts empty, and stores and clears a callsign', () => {
    expect(getPretendCallsign(db)).toBeNull()
    setPretendCallsign(db, 'BAW-123_A')
    expect(getPretendCallsign(db)).toBe('BAW-123_A')
    setPretendCallsign(db, '')
    expect(getPretendCallsign(db)).toBeNull()
    setPretendCallsign(db, 'X')
    setPretendCallsign(db, null)
    expect(getPretendCallsign(db)).toBeNull()
  })

  it.each(['has space', 'way-too-long-callsign', '<img>', 5, {}])('refuses %j', (bad) => {
    expect(() => setPretendCallsign(db, bad)).toThrow('Invalid callsign')
  })

  it('ignores a stored value that is not a callsign', () => {
    setSetting(db, 'devPretendCallsign', 'bad value')
    expect(getPretendCallsign(db)).toBeNull()
  })
})

describe('traffic switches', () => {
  let db: WingLogDb

  beforeEach(() => {
    const created = createDb(':memory:')
    migrate(created.db, { migrationsFolder: 'drizzle' })
    db = created.db
  })

  it('are both off by default', () => {
    expect(getTrafficSwitches(db)).toEqual({ networkOn: false, simOn: false })
  })

  it('are remembered', () => {
    setTrafficSwitches(db, { networkOn: true, simOn: false })
    expect(getTrafficSwitches(db)).toEqual({ networkOn: true, simOn: false })
    setTrafficSwitches(db, { networkOn: false, simOn: true })
    expect(getTrafficSwitches(db)).toEqual({ networkOn: false, simOn: true })
  })
})
