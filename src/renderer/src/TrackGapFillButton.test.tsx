import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WingLogApi } from '@shared/ipc'
import type { EstimatedStretch } from '@shared/track-gap-fill'
import { TrackGapFillButton } from './TrackGapFillButton'

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const STRETCH: EstimatedStretch = {
  coordinates: [
    [27.68, 44.21],
    [99.83, 42.21]
  ],
  lengthNm: 3100,
  fromTsUtc: '2026-10-16T01:49:43Z',
  toTsUtc: '2026-10-16T08:29:41Z'
}

function withApi(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    trackEstimateFill: vi.fn().mockResolvedValue({ outcome: 'filled', count: 1, lengthNm: 3100.4 }),
    trackEstimateGet: vi.fn().mockResolvedValue([STRETCH]),
    trackEstimateClear: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as WingLogApi
  window.winglog = api
  return api
}

describe('TrackGapFillButton', () => {
  beforeEach(() => {
    toast.success.mockReset()
    toast.info.mockReset()
    toast.error.mockReset()
  })

  it('fills the gaps, shows what it did, and hands the stretches to the map', async () => {
    const api = withApi()
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<TrackGapFillButton flightId={239} estimate={[]} onChanged={onChanged} />)
    await user.click(screen.getByRole('button', { name: 'Fill gaps from the flight plan' }))

    expect(api.trackEstimateFill).toHaveBeenCalledWith(239)
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith([STRETCH]))
    expect(toast.success).toHaveBeenCalledWith('Gaps filled: 1, about 3100 nm in all, dashed on the map.')
  })

  it('says so, and changes nothing, when there is no plan or no gap', async () => {
    const onChanged = vi.fn()
    const user = userEvent.setup()
    withApi({ trackEstimateFill: vi.fn().mockResolvedValue({ outcome: 'noRoute', count: 0, lengthNm: 0 }) })
    const { unmount } = render(<TrackGapFillButton flightId={1} estimate={[]} onChanged={onChanged} />)
    await user.click(screen.getByRole('button', { name: 'Fill gaps from the flight plan' }))
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('This flight has no flight plan route to follow.')
    )
    unmount()

    withApi({ trackEstimateFill: vi.fn().mockResolvedValue({ outcome: 'noGaps', count: 0, lengthNm: 0 }) })
    render(<TrackGapFillButton flightId={1} estimate={[]} onChanged={onChanged} />)
    await user.click(screen.getByRole('button', { name: 'Fill gaps from the flight plan' }))
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('There are no gaps to fill along the flight plan.')
    )
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('with stretches already there, the same button removes them', async () => {
    const api = withApi()
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(<TrackGapFillButton flightId={239} estimate={[STRETCH]} onChanged={onChanged} />)
    await user.click(screen.getByRole('button', { name: 'Remove estimated stretches' }))

    expect(api.trackEstimateClear).toHaveBeenCalledWith(239)
    expect(api.trackEstimateFill).not.toHaveBeenCalled()
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith([]))
    expect(toast.success).toHaveBeenCalledWith('Removed the estimated stretches.')
  })

  it('shows a failure instead of leaving the button stuck', async () => {
    withApi({ trackEstimateFill: vi.fn().mockRejectedValue(new Error('database is locked')) })
    const user = userEvent.setup()
    render(<TrackGapFillButton flightId={1} estimate={[]} onChanged={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Fill gaps from the flight plan' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('database is locked'))
    expect(screen.getByRole('button', { name: 'Fill gaps from the flight plan' })).toBeEnabled()
  })
})
