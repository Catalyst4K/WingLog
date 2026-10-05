import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { WingLogApi } from '@shared/ipc'
import { BeyondAtcView } from './BeyondAtcView'

function withWinglog(): void {
  window.winglog = {
    settingsGetBeyondAtc: vi.fn().mockResolvedValue({ enabled: false, host: 'localhost' }),
    beyondAtcGetStatus: vi.fn().mockResolvedValue({ state: 'disconnected', lastError: null }),
    onBeyondAtcStatus: vi.fn().mockReturnValue(() => {}),
    beyondAtcGetState: vi.fn().mockResolvedValue({
      facility: null,
      com2: null,
      callsign: null,
      commsState: null,
      progress: null,
      actions: [],
      autoTune: null,
      autoRespond: null,
      frequencies: []
    }),
    onBeyondAtcState: vi.fn().mockReturnValue(() => {}),
    beyondAtcGetStepClimb: vi.fn().mockResolvedValue({ enabled: false, nextStep: null, pendingAltitudeFt: null, waitingForClimbFt: null, pastTopOfDescent: false, last: null }),
    onBeyondAtcStepClimb: vi.fn(() => () => {}),
    beyondAtcGetArrival: vi.fn().mockResolvedValue(null),
    onBeyondAtcArrival: vi.fn(() => () => {}),
    beyondAtcSetStepClimb: vi.fn().mockResolvedValue(undefined),
    beyondAtcGetTranscript: vi.fn().mockResolvedValue([]),
    onBeyondAtcTranscript: vi.fn().mockReturnValue(() => {})
  } as unknown as WingLogApi
}

describe('BeyondAtcView', () => {
  it('renders a page title and the BeyondAtcPanel', async () => {
    withWinglog()
    render(<BeyondAtcView />)

    expect(screen.getByRole('heading', { name: 'BeyondATC' })).toBeInTheDocument()
    expect(await screen.findByText(/BeyondATC integration is off/)).toBeInTheDocument()
  })
})
