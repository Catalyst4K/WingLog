import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AppCapabilities, SimConnectionStatus } from '@shared/ipc'
import { Tabs } from '@/components/ui/tabs'
import { AppHeader } from './AppHeader'
import { CapabilitiesProvider } from './capabilities'

const CONNECTED: SimConnectionStatus = {
  state: 'connected',
  simConnectVersion: '0.4.2'
} as SimConnectionStatus

function renderHeader(capabilities: AppCapabilities, simStatus: SimConnectionStatus): void {
  window.winglog = {
    appGetCapabilities: vi.fn(() => Promise.resolve(capabilities)),
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

describe('AppHeader connection badge', () => {
  it('shows the sim connection on the host', async () => {
    renderHeader({ runMode: 'host', canHostSim: true, multiDevice: false }, CONNECTED)
    expect(await screen.findByText('SimConnect: connected')).toBeInTheDocument()
    expect(screen.queryByText('Sim PC: not connected')).not.toBeInTheDocument()
  })

  it('shows that the sim PC is not connected on a client, whatever its own sim connection says', async () => {
    renderHeader({ runMode: 'client', canHostSim: false, multiDevice: true }, CONNECTED)
    expect(await screen.findByText('Sim PC: not connected')).toBeInTheDocument()
    expect(screen.queryByText(/SimConnect/)).not.toBeInTheDocument()
  })
})
