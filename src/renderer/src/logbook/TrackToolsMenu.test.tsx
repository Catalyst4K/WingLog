import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WingLogApi } from '@shared/ipc'
import { TrackToolsMenu } from './TrackToolsMenu'

describe('TrackToolsMenu', () => {
  it('gathers clean up and fill gaps (and keep capture, in the dev build) behind one Track tools button', async () => {
    window.winglog = {
      devCaptureKept: vi.fn().mockResolvedValue(false)
    } as unknown as WingLogApi
    const user = userEvent.setup()
    render(<TrackToolsMenu flightId={7} onCleaned={vi.fn()} estimate={[]} onEstimateChanged={vi.fn()} />)
    // Closed: none of the three tools is on the page.
    expect(screen.queryByRole('button', { name: /clean up/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Track tools' }))
    expect(await screen.findByRole('button', { name: /clean up/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /fill gaps/i })).toBeInTheDocument()
  })
})
