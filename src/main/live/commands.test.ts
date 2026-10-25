import { describe, expect, it, vi } from 'vitest'
import {
  atcCommands,
  dispatchCommand,
  gsxCommands,
  parseProcedureSelection,
  trackCommands,
  trafficCommands
} from './commands'

function fakeSession() {
  return {
    setAction: vi.fn(),
    setFrequency: vi.fn(),
    setFrequencyCom2: vi.fn(),
    setAutoTune: vi.fn(),
    setAutoRespond: vi.fn()
  }
}

function fakeGsx() {
  return {
    pickMenu: vi.fn(),
    search: vi.fn(),
    toggleMenu: vi.fn(),
    submitPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    runCommand: vi.fn()
  }
}

describe('atcCommands', () => {
  it('reaches the current session with the arguments as sent', () => {
    const session = fakeSession()
    const stepClimb = { setEnabled: vi.fn() }
    const table = atcCommands(() => session, stepClimb)
    dispatchCommand(table, 'atc.setAction', ['Request descent'])
    dispatchCommand(table, 'atc.setFrequency', ['121.900'])
    dispatchCommand(table, 'atc.setFrequencyCom2', ['118.500'])
    dispatchCommand(table, 'atc.setAutoTune', [true])
    dispatchCommand(table, 'atc.setAutoRespond', [false])
    expect(session.setAction).toHaveBeenCalledWith('Request descent')
    expect(session.setFrequency).toHaveBeenCalledWith('121.900')
    expect(session.setFrequencyCom2).toHaveBeenCalledWith('118.500')
    expect(session.setAutoTune).toHaveBeenCalledWith(true)
    expect(session.setAutoRespond).toHaveBeenCalledWith(false)
  })

  it('does nothing while BeyondATC is off, and reads the session afresh on every call', () => {
    const current: { session?: ReturnType<typeof fakeSession> } = {}
    const table = atcCommands(() => current.session, { setEnabled: vi.fn() })
    expect(() => dispatchCommand(table, 'atc.setAction', ['x'])).not.toThrow()
    const session = fakeSession()
    current.session = session
    dispatchCommand(table, 'atc.setAction', ['x'])
    expect(session.setAction).toHaveBeenCalledWith('x')
  })

  it('switches step climb only for a real boolean', () => {
    const stepClimb = { setEnabled: vi.fn() }
    const table = atcCommands(() => undefined, stepClimb)
    dispatchCommand(table, 'atc.setStepClimb', ['yes'])
    dispatchCommand(table, 'atc.setStepClimb', [1])
    expect(stepClimb.setEnabled).not.toHaveBeenCalled()
    dispatchCommand(table, 'atc.setStepClimb', [true])
    expect(stepClimb.setEnabled).toHaveBeenCalledWith(true)
  })
})

describe('gsxCommands', () => {
  it('reaches the service with the arguments as sent', () => {
    const service = fakeGsx()
    const table = gsxCommands(() => service)
    dispatchCommand(table, 'gsx.pickMenu', [2])
    dispatchCommand(table, 'gsx.search', ['A12'])
    dispatchCommand(table, 'gsx.toggleMenu', [])
    dispatchCommand(table, 'gsx.submitPrompt', [3, 'text'])
    dispatchCommand(table, 'gsx.cancelPrompt', [3])
    dispatchCommand(table, 'gsx.runCommand', ['refuel'])
    expect(service.pickMenu).toHaveBeenCalledWith(2)
    expect(service.search).toHaveBeenCalledWith('A12')
    expect(service.toggleMenu).toHaveBeenCalled()
    expect(service.submitPrompt).toHaveBeenCalledWith(3, 'text')
    expect(service.cancelPrompt).toHaveBeenCalledWith(3)
    expect(service.runCommand).toHaveBeenCalledWith('refuel')
  })

  it('does nothing while GSX Remote is off', () => {
    expect(() =>
      dispatchCommand(
        gsxCommands(() => undefined),
        'gsx.toggleMenu',
        []
      )
    ).not.toThrow()
  })
})

const SELECTION = {
  departureRunway: '02L',
  sidIdent: 'KAMI2A',
  sidTransition: null,
  starIdent: 'SIER7B',
  starTransition: 'LIMES',
  approachIdent: 'ILS 27L',
  approachTransition: null,
  arrivalIcao: null
}

describe('parseProcedureSelection', () => {
  it('accepts a full selection, filling in any field left out as null, and drops anything extra', () => {
    expect(parseProcedureSelection(SELECTION)).toEqual(SELECTION)
    expect(parseProcedureSelection({ sidIdent: 'X1', evil: 'x', __proto__: { a: 1 } })).toEqual({
      departureRunway: null,
      sidIdent: 'X1',
      sidTransition: null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    })
  })

  it('refuses anything that is not an object of short strings or nulls', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      5,
      [],
      { sidIdent: 5 },
      { sidIdent: 'x'.repeat(41) },
      { arrivalIcao: {} }
    ]) {
      expect(() => parseProcedureSelection(bad)).toThrow('Invalid procedure selection')
    }
  })
})

describe('trackCommands', () => {
  it('passes a checked selection to the tracking controller', () => {
    const controller = { setProcedureSelection: vi.fn() }
    const table = trackCommands(controller)
    dispatchCommand(table, 'track.setProcedureSelection', [SELECTION])
    expect(controller.setProcedureSelection).toHaveBeenCalledWith(SELECTION)
  })

  it('refuses a selection that is not valid, and does not reach the controller', () => {
    const controller = { setProcedureSelection: vi.fn() }
    expect(() =>
      dispatchCommand(trackCommands(controller), 'track.setProcedureSelection', [{ sidIdent: 7 }])
    ).toThrow('Invalid procedure selection')
    expect(controller.setProcedureSelection).not.toHaveBeenCalled()
  })

  it('has only the commands a second screen may send', () => {
    expect(Object.keys(trackCommands({ setProcedureSelection: vi.fn() }))).toEqual([
      'track.setProcedureSelection'
    ])
  })
})

describe('dispatchCommand', () => {
  const table = gsxCommands(() => fakeGsx())

  it('refuses a name that is not in the table, whatever its type', () => {
    for (const name of [
      'atc.setAction',
      'toString',
      '__proto__',
      'constructor',
      '',
      42,
      null,
      undefined,
      {}
    ]) {
      expect(() => dispatchCommand(table, name, [])).toThrow('Unknown command')
    }
  })

  it('refuses arguments that are not a short list', () => {
    for (const args of ['x', null, undefined, { 0: 1 }, [1, 2, 3]]) {
      expect(() => dispatchCommand(table, 'gsx.search', args)).toThrow('Invalid command arguments')
    }
  })
})

describe('trafficCommands', () => {
  it('passes a boolean to the feed service', () => {
    const feed = { setNetworkOn: vi.fn() }
    const table = trafficCommands(feed)
    dispatchCommand(table, 'traffic.setNetworkOn', [true])
    dispatchCommand(table, 'traffic.setNetworkOn', [false])
    expect(feed.setNetworkOn.mock.calls).toEqual([[true], [false]])
  })

  it.each([['true'], [1], [null], [undefined], [{}]])('refuses %j, and does not reach the feed', (value) => {
    const feed = { setNetworkOn: vi.fn() }
    expect(() => dispatchCommand(trafficCommands(feed), 'traffic.setNetworkOn', [value])).toThrow(
      'Invalid traffic switch'
    )
    expect(feed.setNetworkOn).not.toHaveBeenCalled()
  })

  it('has only the traffic switch', () => {
    expect(Object.keys(trafficCommands({ setNetworkOn: vi.fn() }))).toEqual(['traffic.setNetworkOn'])
  })
})
