import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WingLogApi } from '@shared/ipc'
import { KeepCaptureButton } from './KeepCaptureButton'

function mockApi(api: Partial<WingLogApi>): void {
  window.winglog = api as WingLogApi
}

describe('KeepCaptureButton', () => {
  it('keeps a flight’s capture in the dev build', async () => {
    const captureKeep = vi.fn().mockResolvedValue('kept')
    mockApi({ captureKeepState: vi.fn().mockResolvedValue('auto'), captureKeep })
    render(<KeepCaptureButton flightId={232} isDevBuild />)

    await userEvent.click(await screen.findByRole('button', { name: /keep capture/i }))

    expect(captureKeep).toHaveBeenCalledWith(232)
    expect(await screen.findByRole('button', { name: /capture kept/i })).toBeDisabled()
  })

  it('shows an already kept capture as kept', async () => {
    mockApi({ captureKeepState: vi.fn().mockResolvedValue('kept') })
    render(<KeepCaptureButton flightId={232} isDevBuild />)
    expect(await screen.findByRole('button', { name: /capture kept/i })).toBeDisabled()
  })

  it('shows nothing for a flight with no capture', async () => {
    const captureKeepState = vi.fn().mockResolvedValue('none')
    mockApi({ captureKeepState })
    const { container } = render(<KeepCaptureButton flightId={232} isDevBuild />)
    await waitFor(() => expect(captureKeepState).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing and asks nothing in a normal build, which is what tests see by default', () => {
    const captureKeepState = vi.fn()
    mockApi({ captureKeepState })
    const { container } = render(<KeepCaptureButton flightId={232} />)
    expect(container).toBeEmptyDOMElement()
    expect(captureKeepState).not.toHaveBeenCalled()
  })
})
