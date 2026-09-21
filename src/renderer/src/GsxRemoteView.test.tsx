import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { WingLogApi } from '@shared/ipc'
import { GsxRemoteView } from './GsxRemoteView'

function withWinglog(): void {
  window.winglog = {
    settingsGetGsxRemote: vi.fn().mockResolvedValue({ enabled: false, host: 'localhost', port: 8744 }),
    gsxRemoteGetStatus: vi.fn().mockResolvedValue({ state: 'disconnected', lastError: null }),
    onGsxRemoteStatus: vi.fn().mockReturnValue(() => {}),
    onGsxRemoteServices: vi.fn().mockReturnValue(() => {}),
    onGsxRemoteMenu: vi.fn().mockReturnValue(() => {}),
    onGsxRemotePrompt: vi.fn().mockReturnValue(() => {})
  } as unknown as WingLogApi
}

describe('GsxRemoteView', () => {
  it('renders a page title and the GsxRemotePanel', async () => {
    withWinglog()
    render(<GsxRemoteView />)

    expect(screen.getByRole('heading', { name: 'Ground services' })).toBeInTheDocument()
    expect(await screen.findByText(/GSX Remote Control is off/)).toBeInTheDocument()
  })
})
