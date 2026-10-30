import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SimConnectConstants, SimConnectPeriod, SimObjectType } from 'node-simconnect'
import type { SimTrafficRecord } from '../sim/simvars'
import { TRAFFIC_VARS } from '../sim/simvars'
import { openSimTrafficLink } from './sim-traffic-link'

/** A response buffer that reads values from lists, in the order TRAFFIC_VARS packs them. */
function buffer(values: { numbers: number[]; ints: number[]; strings: string[] }): never {
  const numbers = [...values.numbers]
  const ints = [...values.ints]
  const strings = [...values.strings]
  return {
    readFloat64: () => numbers.shift(),
    readInt32: () => ints.shift(),
    readString32: () => strings.shift(),
    readString256: () => strings.shift()
  } as never
}

function fakeHandle() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    addToDataDefinition: vi.fn(),
    requestDataOnSimObject: vi.fn(),
    requestDataOnSimObjectType: vi.fn(),
    close: vi.fn()
  })
}

const sweepReply = (requestID: number, objectID: number, entryNumber: number, outOf: number, id: string) => ({
  requestID,
  objectID,
  entryNumber,
  outOf,
  data: buffer({ numbers: [51.47, -0.45, 120, 270, 5], ints: [1], strings: [id, 'FSLTL_A320'] })
})

describe('openSimTrafficLink', () => {
  async function open() {
    const handle = fakeHandle()
    const onUser = vi.fn()
    const onSweep = vi.fn()
    const onLost = vi.fn()
    const link = await openSimTrafficLink({ onUser, onSweep, onLost }, (() =>
      Promise.resolve({ recvOpen: {}, handle })) as never)
    return { handle, link, onUser, onSweep, onLost }
  }

  it("declares the eight traffic fields in order and asks for the user's aircraft every second", async () => {
    const { handle } = await open()
    expect(handle.addToDataDefinition.mock.calls.map((c) => c[1])).toEqual(TRAFFIC_VARS.map((v) => v.name))
    expect(handle.requestDataOnSimObject).toHaveBeenCalledWith(
      10,
      1,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.SECOND
    )
  })

  it('asks for every aircraft within 200 km when a sweep is requested', async () => {
    const { handle, link } = await open()
    link.requestSweep()
    expect(handle.requestDataOnSimObjectType).toHaveBeenCalledWith(11, 1, 200_000, SimObjectType.AIRCRAFT)
  })

  it("reports the user's object id, and a sweep only when its last record arrives", async () => {
    const { handle, onUser, onSweep } = await open()
    handle.emit('simObjectData', { requestID: 10, objectID: 7 })
    handle.emit('simObjectData', { requestID: 99, objectID: 8 })
    expect(onUser.mock.calls).toEqual([[7]])
    handle.emit('simObjectDataByType', sweepReply(11, 7, 1, 2, 'N1'))
    expect(onSweep).not.toHaveBeenCalled()
    handle.emit('simObjectDataByType', sweepReply(99, 8, 1, 1, 'IGNORED'))
    handle.emit('simObjectDataByType', sweepReply(11, 9, 2, 2, 'UAL9'))
    const records = onSweep.mock.calls[0][0] as SimTrafficRecord[]
    expect(records.map((r) => [r.objectId, r.atcId])).toEqual([
      [7, 'N1'],
      [9, 'UAL9']
    ])
    expect(records[1]).toMatchObject({
      latitude: 51.47,
      longitude: -0.45,
      onGround: true,
      title: 'FSLTL_A320'
    })
    // The next sweep starts empty.
    handle.emit('simObjectDataByType', sweepReply(11, 5, 1, 1, 'DAL5'))
    expect(onSweep.mock.calls[1][0]).toHaveLength(1)
  })

  it('reports a lost connection on quit and on close, and closes the handle on request', async () => {
    const { handle, link, onLost } = await open()
    handle.emit('quit')
    handle.emit('close')
    expect(onLost).toHaveBeenCalledTimes(2)
    link.close()
    expect(handle.close).toHaveBeenCalled()
  })

  it('rejects when the sim cannot be reached', async () => {
    await expect(
      openSimTrafficLink({ onUser: vi.fn(), onSweep: vi.fn(), onLost: vi.fn() }, (() =>
        Promise.reject(new Error('no sim'))) as never)
    ).rejects.toThrow('no sim')
  })
})
