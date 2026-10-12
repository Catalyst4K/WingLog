import { afterEach, describe, expect, it, vi } from 'vitest'

const { open } = vi.hoisted(() => ({ open: vi.fn(async () => ({})) }))
vi.mock('node-simconnect', () => ({ open }))

import { E2E_SIMCONNECT_PORT_ENV, e2eSimConnectOptions, openSimConnect } from './open-simconnect'

afterEach(() => {
  delete process.env[E2E_SIMCONNECT_PORT_ENV]
  open.mockClear()
})

describe('e2eSimConnectOptions', () => {
  it('asks for a remote connection to a valid port, and for nothing otherwise', () => {
    expect(e2eSimConnectOptions('51234')).toEqual({ remote: { host: '127.0.0.1', port: 51234 } })
    for (const bad of [undefined, '', 'abc', '0', '-5', '70000', '12.5'])
      expect(e2eSimConnectOptions(bad)).toBeUndefined()
  })
})

describe('openSimConnect', () => {
  it('opens the real sim the normal way without the override', async () => {
    await openSimConnect('WingLog', 1 as never)
    expect(open).toHaveBeenCalledWith('WingLog', 1, undefined)
  })

  it("points an e2e run at its own port, and lets a caller's own options win", async () => {
    process.env[E2E_SIMCONNECT_PORT_ENV] = '51234'
    await openSimConnect('WingLog', 1 as never)
    expect(open).toHaveBeenLastCalledWith('WingLog', 1, { remote: { host: '127.0.0.1', port: 51234 } })
    await openSimConnect('WingLog', 1 as never, { host: 'h', port: 1 })
    expect(open).toHaveBeenLastCalledWith('WingLog', 1, { host: 'h', port: 1 })
  })
})
