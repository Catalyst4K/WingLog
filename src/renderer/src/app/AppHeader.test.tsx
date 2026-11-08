import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AppCapabilities, HostLinkStatus, SimConnectionStatus } from '@shared/ipc'
import { Tabs } from '@/components/ui/tabs'
import { AppHeader } from './AppHeader'
import { CapabilitiesProvider } from './capabilities'

const CONNECTED: SimConnectionStatus = { state: 'connected', simConnectVersion: '0.4.2' }

function renderHeader(
  capabilities: AppCapabilities,
  simStatus: SimConnectionStatus,
  link: HostLinkStatus = { state: 'unpaired', address: null, hostSim: null }
): void {
  window.winglog = {
    appGetCapabilities: vi.fn(() => Promise.resolve(capabilities)),
    hostLinkGetStatus: vi.fn(() => Promise.resolve(link)),
    onHostLinkStatus: vi.fn(() => () => {}),
    appLogRendererError: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.winglog
  render(
    <CapabilitiesProvider>
      <Tabs value="track">
        <AppHeader
          gsxRemoteEnabled={false}
          beyondAtcEnabled={false}
          onTabClick={vi.fn()}
          simStatus={simStatus}
        />
      </Tabs>
    </CapabilitiesProvider>
  )
}

const CLIENT: AppCapabilities = { runMode: 'client', canHostSim: false, multiDevice: true }

describe('AppHeader connection badge', () => {
  it('shows the sim connection on the host', async () => {
    renderHeader({ runMode: 'host', canHostSim: true, multiDevice: false }, CONNECTED)
    expect(await screen.findByText('SimConnect: connected')).toBeInTheDocument()
    expect(screen.queryByText(/Sim PC:/)).not.toBeInTheDocument()
  })

  it('shows that no sim PC is paired on a client, whatever its own sim connection says', async () => {
    renderHeader(CLIENT, CONNECTED)
    expect(await screen.findByText('Sim PC: not paired')).toBeInTheDocument()
    expect(screen.queryByText(/SimConnect/)).not.toBeInTheDocument()
  })

  it('shows the link to the sim PC on a client', async () => {
    renderHeader(CLIENT, CONNECTED, {
      state: 'connected',
      address: '192.168.1.20:5051',
      hostSim: 'connected'
    })
    expect(await screen.findByText('Sim PC: connected')).toBeInTheDocument()
  })

  it('shows a sim PC that cannot be reached', async () => {
    renderHeader(CLIENT, CONNECTED, {
      state: 'offline',
      address: '192.168.1.20:5051',
      hostSim: 'disconnected'
    })
    expect(await screen.findByText('Sim PC: not reachable')).toBeInTheDocument()
  })
})
