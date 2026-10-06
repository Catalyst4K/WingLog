import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { WingLogApi } from '@shared/ipc'
import { DevBuildBadge } from './DevBuildBadge'
import { diagMap } from './diag'

describe('DevBuildBadge', () => {
  it('shows DEV in the dev build', () => {
    render(<DevBuildBadge isDevBuild />)
    expect(screen.getByText('DEV')).toBeInTheDocument()
  })

  it('shows nothing in a normal build, which is what tests see by default', () => {
    const { container } = render(<DevBuildBadge />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('diagMap', () => {
  function withDiagLog(diagLog: ReturnType<typeof vi.fn>): void {
    window.winglog = { diagLog } as unknown as WingLogApi
  }

  it('sends a map line with its data to main in the dev build', () => {
    const diagLog = vi.fn().mockResolvedValue(undefined)
    withDiagLog(diagLog)
    diagMap('taxi route traced', { points: 51, end: [109.3963393, 18.3016817] }, true)
    expect(diagLog).toHaveBeenCalledWith('map', 'taxi route traced {"points":51,"end":[109.3963393,18.3016817]}')
  })

  it('sends nothing in a normal build', () => {
    const diagLog = vi.fn().mockResolvedValue(undefined)
    withDiagLog(diagLog)
    diagMap('taxi route traced', { points: 51 })
    expect(diagLog).not.toHaveBeenCalled()
  })

  it('never throws: unserialisable data is noted, a failed send is ignored', async () => {
    const diagLog = vi.fn().mockRejectedValue(new Error('no main process'))
    withDiagLog(diagLog)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => diagMap('taxi route re-routed', circular, true)).not.toThrow()
    expect(diagLog).toHaveBeenCalledWith('map', 'taxi route re-routed (unserialisable data)')
    await Promise.resolve()
  })
})
