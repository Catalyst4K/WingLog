import { describe, expect, it, vi } from 'vitest'
import { atcCommands, dispatchCommand, gsxCommands } from './commands'

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
    expect(() => dispatchCommand(gsxCommands(() => undefined), 'gsx.toggleMenu', [])).not.toThrow()
  })
})

describe('dispatchCommand', () => {
  const table = gsxCommands(() => fakeGsx())

  it('refuses a name that is not in the table, whatever its type', () => {
    for (const name of ['atc.setAction', 'toString', '__proto__', 'constructor', '', 42, null, undefined, {}]) {
      expect(() => dispatchCommand(table, name, [])).toThrow('Unknown command')
    }
  })

  it('refuses arguments that are not a short list', () => {
    for (const args of ['x', null, undefined, { 0: 1 }, [1, 2, 3]]) {
      expect(() => dispatchCommand(table, 'gsx.search', args)).toThrow('Invalid command arguments')
    }
  })
})
