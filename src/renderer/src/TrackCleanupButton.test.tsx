import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TrackCleanupSummary, TrackPoint, WingLogApi } from '@shared/ipc'
import { TrackCleanupButton } from './TrackCleanupButton'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
import { toast } from 'sonner'

function trackPoint(overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    id: 1,
    flightId: 42,
    tsUtc: '2026-09-13T12:00:00.000Z',
    latitude: 0,
    longitude: 0,
    altitudeM: 0,
    altitudeAglM: 0,
    indicatedAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    verticalSpeedMs: 0,
    headingTrueDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    phase: 'cruise',
    onGround: false,
    fuelKg: 0,
    gForce: 1,
    windSpeedMs: 0,
    windDirectionDeg: 0,
    resumeSegment: 0,
    simRate: 1,
    excludedReason: null,
    ...overrides
  }
}

function withWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    trackPointCleanup: vi.fn().mockResolvedValue({ excludedCount: 0, resegmentedCount: 0 } satisfies TrackCleanupSummary),
    trackPointList: vi.fn().mockResolvedValue([]),
    ...overrides
  } as unknown as WingLogApi
  window.winglog = api
  return api
}

describe('TrackCleanupButton', () => {
  it('renders nothing when the flight never resumed', () => {
    withWinglog()
    const { container } = render(<TrackCleanupButton flightId={42} hadResume={false} onCleaned={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the button when the flight did resume', () => {
    withWinglog()
    render(<TrackCleanupButton flightId={42} hadResume={true} onCleaned={vi.fn()} />)
    expect(screen.getByRole('button', { name: /clean up track/i })).toBeInTheDocument()
  })

  it('calls trackPointCleanup, re-fetches points, and reports what changed', async () => {
    const user = userEvent.setup()
    const cleaned = [trackPoint({ id: 1 }), trackPoint({ id: 2 })]
    const api = withWinglog({
      trackPointCleanup: vi.fn().mockResolvedValue({ excludedCount: 3, resegmentedCount: 1 }),
      trackPointList: vi.fn().mockResolvedValue(cleaned)
    })
    const onCleaned = vi.fn()
    render(<TrackCleanupButton flightId={42} hadResume={true} onCleaned={onCleaned} />)

    await user.click(screen.getByRole('button', { name: /clean up track/i }))

    await waitFor(() => expect(api.trackPointCleanup).toHaveBeenCalledWith(42))
    await waitFor(() => expect(onCleaned).toHaveBeenCalledWith(cleaned))
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('3 junk points excluded, 1 point re-segmented')
    )
  })

  it('reports nothing-to-clean-up without re-fetching when the pass found nothing', async () => {
    const user = userEvent.setup()
    const trackPointList = vi.fn().mockResolvedValue([])
    withWinglog({
      trackPointCleanup: vi.fn().mockResolvedValue({ excludedCount: 0, resegmentedCount: 0 }),
      trackPointList
    })
    const onCleaned = vi.fn()
    render(<TrackCleanupButton flightId={42} hadResume={true} onCleaned={onCleaned} />)

    await user.click(screen.getByRole('button', { name: /clean up track/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Nothing to clean up')))
    expect(onCleaned).not.toHaveBeenCalled()
    expect(trackPointList).not.toHaveBeenCalled()
  })

  it('shows a toast error and re-enables the button when the cleanup call fails', async () => {
    const user = userEvent.setup()
    withWinglog({ trackPointCleanup: vi.fn().mockRejectedValue(new Error('db locked')) })
    render(<TrackCleanupButton flightId={42} hadResume={true} onCleaned={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /clean up track/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('db locked'))
    expect(screen.getByRole('button', { name: /clean up track/i })).not.toBeDisabled()
  })
})
