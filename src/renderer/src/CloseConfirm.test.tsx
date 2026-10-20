import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { CloseConfirm } from './CloseConfirm'

/** Installs a window.winglog that lets a test fire the main process's close question. */
function setup() {
  let ask: () => void = () => undefined
  const unsubscribe = vi.fn()
  const api = {
    onCloseConfirmRequested: vi.fn((listener: () => void) => {
      ask = listener
      return unsubscribe
    }),
    closeConfirmAnswer: vi.fn(() => Promise.resolve()),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return { api, unsubscribe, ask: () => act(() => ask()) }
}

describe('CloseConfirm', () => {
  it('shows nothing until main asks', () => {
    setup()
    render(<CloseConfirm />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('asks in the app and answers close when the pilot chooses Close WingLog', async () => {
    const { api, ask } = setup()
    render(<CloseConfirm />)
    ask()
    expect(await screen.findByRole('alertdialog', { name: 'Close WingLog?' })).toBeInTheDocument()
    expect(screen.getByText(/the flight is kept and you can resume or discard it/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close WingLog' }))
    expect(api.closeConfirmAnswer).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('answers keep open from the Keep open button, and again the next time it is asked', async () => {
    const { api, ask } = setup()
    render(<CloseConfirm />)
    ask()
    await userEvent.click(await screen.findByRole('button', { name: 'Keep open' }))
    expect(api.closeConfirmAnswer).toHaveBeenLastCalledWith(false)
    ask()
    await userEvent.click(await screen.findByRole('button', { name: 'Keep open' }))
    expect(api.closeConfirmAnswer).toHaveBeenCalledTimes(2)
  })

  it('answers keep open on Escape', async () => {
    const { api, ask } = setup()
    render(<CloseConfirm />)
    ask()
    await screen.findByRole('alertdialog')
    await userEvent.keyboard('{Escape}')
    expect(api.closeConfirmAnswer).toHaveBeenCalledWith(false)
  })

  it('stops listening when it unmounts', () => {
    const { unsubscribe } = setup()
    render(<CloseConfirm />).unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
