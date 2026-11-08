import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useDataChanged } from './use-data-changed'

function Probe(props: { reload: () => void }): null {
  useDataChanged(props.reload)
  return null
}

describe('useDataChanged', () => {
  it('reads again each time the main process says a sync changed the data, with the latest function', () => {
    let fire: () => void = () => {}
    const unsubscribe = vi.fn()
    window.winglog = {
      onDataChanged: vi.fn((listener: () => void) => {
        fire = listener
        return unsubscribe
      })
    } as unknown as typeof window.winglog
    const first = vi.fn()
    const second = vi.fn()
    const { rerender, unmount } = render(<Probe reload={first} />)
    fire()
    expect(first).toHaveBeenCalledTimes(1)
    rerender(<Probe reload={second} />)
    fire()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('does nothing where the api has no such event (a test double, a host)', () => {
    window.winglog = {} as unknown as typeof window.winglog
    expect(() => render(<Probe reload={vi.fn()} />)).not.toThrow()
  })
})
