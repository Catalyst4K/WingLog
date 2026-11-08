import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AppCapabilities } from '@shared/ipc'
import { CapabilitiesProvider } from './capabilities'
import { HOST_CAPABILITIES, useCapabilities } from './capabilities-context'

function Probe(): React.JSX.Element {
  const { runMode, multiDevice } = useCapabilities()
  return <p>{`${runMode} ${multiDevice ? 'multi' : 'single'}`}</p>
}

function setup(answer: Promise<AppCapabilities>): void {
  window.winglog = {
    appGetCapabilities: vi.fn(() => answer),
    appLogRendererError: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.winglog
}

describe('capabilities', () => {
  it('is the host WingLog has always been until the main process answers', () => {
    setup(new Promise(() => {}))
    render(
      <CapabilitiesProvider>
        <Probe />
      </CapabilitiesProvider>
    )
    expect(screen.getByText('host single')).toBeInTheDocument()
    expect(HOST_CAPABILITIES).toEqual({ runMode: 'host', canHostSim: true, multiDevice: false })
  })

  it('then shows what this run is', async () => {
    setup(Promise.resolve({ runMode: 'client', canHostSim: false, multiDevice: true }))
    render(
      <CapabilitiesProvider>
        <Probe />
      </CapabilitiesProvider>
    )
    expect(await screen.findByText('client multi')).toBeInTheDocument()
  })

  it('is the host outside a provider', () => {
    render(<Probe />)
    expect(screen.getByText('host single')).toBeInTheDocument()
  })
})
