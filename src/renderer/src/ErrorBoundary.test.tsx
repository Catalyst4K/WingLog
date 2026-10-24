import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from './ErrorBoundary'
import { RenderErrorContext } from './render-error'

/** Draws, or throws when told to. */
function Part({ explode }: { explode: boolean }): React.JSX.Element {
  if (explode) throw new Error('boom in the part')
  return <p>the part</p>
}

afterEach(() => {
  vi.restoreAllMocks()
})

// React logs a caught render error to the console; the tests below expect those.
function quiet(): void {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

describe('ErrorBoundary', () => {
  it('draws what it guards when nothing fails', () => {
    render(
      <ErrorBoundary name="track">
        <Part explode={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('the part')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a message and a Reload button in place of a part that throws, and the rest of the page carries on', () => {
    quiet()
    render(
      <div>
        <p>the header</p>
        <ErrorBoundary name="track">
          <Part explode />
        </ErrorBoundary>
        <p>the footer</p>
      </div>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong showing this.')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByText('the part')).not.toBeInTheDocument()
    expect(screen.getByText('the header')).toBeInTheDocument()
    expect(screen.getByText('the footer')).toBeInTheDocument()
  })

  it('tells the reporter which part failed, with the error and the component that threw', () => {
    quiet()
    const report = vi.fn()
    render(
      <RenderErrorContext.Provider value={report}>
        <ErrorBoundary name="map">
          <Part explode />
        </ErrorBoundary>
      </RenderErrorContext.Provider>
    )
    expect(report).toHaveBeenCalledTimes(1)
    const [name, error] = report.mock.calls[0] as [string, Error]
    expect(name).toBe('map')
    expect(error.message).toContain('boom in the part')
    expect(error.message).toContain('Part')
  })

  it('writes to main.log through the window API when no reporter is provided', () => {
    quiet()
    const log = vi.fn().mockResolvedValue(undefined)
    window.winglog = { appLogRendererError: log } as unknown as typeof window.winglog
    render(
      <ErrorBoundary name="logbook">
        <Part explode />
      </ErrorBoundary>
    )
    expect(log).toHaveBeenCalledWith('render: logbook', expect.stringContaining('boom in the part'))
  })

  it('still shows the message when the reporter itself throws', () => {
    quiet()
    render(
      <RenderErrorContext.Provider
        value={() => {
          throw new Error('the log is gone')
        }}
      >
        <ErrorBoundary name="track">
          <Part explode />
        </ErrorBoundary>
      </RenderErrorContext.Provider>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('draws the part again when the reset key changes, as moving to another page does, and not before', () => {
    quiet()
    const { rerender } = render(
      <ErrorBoundary name="logbook" resetKey="logbook">
        <Part explode />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // The same page drawn again stays failed.
    rerender(
      <ErrorBoundary name="logbook" resetKey="logbook">
        <Part explode={false} />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    rerender(
      <ErrorBoundary name="fleet" resetKey="fleet">
        <Part explode={false} />
      </ErrorBoundary>
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('the part')).toBeInTheDocument()
  })

  it('reloads the page when Reload is pressed', async () => {
    quiet()
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, reload }, configurable: true })
    try {
      render(
        <ErrorBoundary name="track">
          <Part explode />
        </ErrorBoundary>
      )
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true })
    }
  })
})
