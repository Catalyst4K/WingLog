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
    expect(getOnlineNetworkSettings(db)).toEqual({
      network: null,
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
  })

  it('keeps BeyondATC while online only when asked to, and refuses anything but a boolean', () => {
    expect(getOnlineNetworkSettings(db).keepBeyondAtcOnline).toBe(false)
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: true,
      simTrafficButton: true
    })
    expect(getOnlineNetworkSettings(db).keepBeyondAtcOnline).toBe(true)
    for (const bad of ['true', 1, null, undefined]) {
      expect(() =>
        setOnlineNetworkSettings(db, {
          network: 'vatsim',
          vatsimCid: null,
          ivaoVid: null,
          keepBeyondAtcOnline: bad,
          simTrafficButton: true
        })
      ).toThrow('Invalid setting')
    }
    expect(getOnlineNetworkSettings(db).keepBeyondAtcOnline).toBe(true)
  })

  it('offers the sim traffic button until it is switched off, refusing anything but a boolean and saving nothing then', () => {
    const settings = {
      network: null,
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: false
    }
    setOnlineNetworkSettings(db, settings)
    expect(getOnlineNetworkSettings(db).simTrafficButton).toBe(false)
    for (const bad of ['false', 0, null, undefined]) {
      expect(() =>
        setOnlineNetworkSettings(db, { ...settings, network: 'vatsim', simTrafficButton: bad })
      ).toThrow('Invalid setting')
    }
    expect(getOnlineNetworkSettings(db)).toMatchObject({ network: null, simTrafficButton: false })
    setOnlineNetworkSettings(db, { ...settings, simTrafficButton: true })
    expect(getOnlineNetworkSettings(db).simTrafficButton).toBe(true)
  })

  it('keeps offering the sim traffic button on an install from before the setting existed', () => {
    // Nothing stored under the key: the button stays, as it was before the switch was added.
    setSetting(db, 'onlineNetwork', 'vatsim')
    expect(getOnlineNetworkSettings(db).simTrafficButton).toBe(true)
  })

  it('stores and reads a network and its member numbers', () => {
    setOnlineNetworkSettings(db, {
      network: 'ivao',
      vatsimCid: '1234567',
      ivaoVid: '654321',
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    expect(getOnlineNetworkSettings(db)).toEqual({
      network: 'ivao',
      vatsimCid: '1234567',
      ivaoVid: '654321',
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
  })

  it('clears a member number sent as null or empty, and the network sent as null', () => {
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: '1',
      ivaoVid: '2',
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    setOnlineNetworkSettings(db, {
      network: null,
      vatsimCid: '',
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    expect(getOnlineNetworkSettings(db)).toEqual({
      network: null,
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
  })

  it.each(['1234567890123', 'abc', '12 34', '-5', '1e5', '١٢٣', 12345, {}])(
    'refuses the member number %j',
    (bad) => {
      expect(() =>
        setOnlineNetworkSettings(db, {
          network: 'vatsim',
          vatsimCid: bad,
          ivaoVid: null,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
      ).toThrow('Invalid member number')
      expect(() =>
        setOnlineNetworkSettings(db, {
          network: 'ivao',
          vatsimCid: null,
          ivaoVid: bad,
          keepBeyondAtcOnline: false,
          simTrafficButton: true
        })
      ).toThrow('Invalid member number')
    }
  )

  it.each(['poscon', '', undefined, 5])('refuses the network %j', (bad) => {
    expect(() =>
      setOnlineNetworkSettings(db, {
        network: bad,
        vatsimCid: null,
        ivaoVid: null,
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      })
    ).toThrow('Invalid network')
  })

  it.each([null, undefined, 'vatsim', 3])('refuses settings that are not an object: %j', (bad) => {
    expect(() => setOnlineNetworkSettings(db, bad)).toThrow('Invalid online network settings')
  })

  it('stores nothing when a later field is refused', () => {
    setOnlineNetworkSettings(db, {
      network: 'vatsim',
      vatsimCid: '111',
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
    expect(() =>
      setOnlineNetworkSettings(db, {
        network: 'ivao',
        vatsimCid: '222',
        ivaoVid: 'x',
        keepBeyondAtcOnline: false,
        simTrafficButton: true
      })
    ).toThrow()
    expect(getOnlineNetworkSettings(db)).toEqual({
      network: 'vatsim',
      vatsimCid: '111',
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
  })

  it('ignores a stored value that is not a valid network or member number', () => {
    setSetting(db, 'onlineNetwork', 'poscon')
    setSetting(db, 'vatsimCid', 'not-a-number')
    expect(getOnlineNetworkSettings(db)).toEqual({
      network: null,
      vatsimCid: null,
      ivaoVid: null,
      keepBeyondAtcOnline: false,
      simTrafficButton: true
    })
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

  it('are all off by default', () => {
    expect(getTrafficSwitches(db)).toEqual({ networkOn: false, simOn: false, atcOn: false })
  })

  it('are remembered', () => {
    setTrafficSwitches(db, { networkOn: true, simOn: false, atcOn: false })
    expect(getTrafficSwitches(db)).toEqual({ networkOn: true, simOn: false, atcOn: false })
    setTrafficSwitches(db, { networkOn: false, simOn: true, atcOn: true })
    expect(getTrafficSwitches(db)).toEqual({ networkOn: false, simOn: true, atcOn: true })
  })
})
