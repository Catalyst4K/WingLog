import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StorageStatus, WingLogApi } from '@shared/ipc'
import { StorageBanner } from './StorageBanner'

const GIB = 1024 ** 3

function withStatus(status: StorageStatus): { push: (next: StorageStatus) => void } {
  let listener: (status: StorageStatus) => void = () => {}
  window.winglog = {
    getStorageStatus: vi.fn().mockResolvedValue(status),
    onStorageStatus: vi.fn((l: (status: StorageStatus) => void) => {
      listener = l
      return () => {}
    })
  } as unknown as WingLogApi
  return { push: (next) => act(() => listener(next)) }
}

describe('StorageBanner', () => {
  it('shows nothing while there is plenty of room', async () => {
    withStatus({ freeBytes: 80 * GIB, level: 'ok', saveFailing: false })
    render(<StorageBanner />)
    await act(() => Promise.resolve())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('warns, with the figure, when the disk is running low', async () => {
    withStatus({ freeBytes: 3.46 * GIB, level: 'low', saveFailing: false })
    render(<StorageBanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your disk is running low (3.5 GB left). Free some space before a long flight.'
    )
  })

  it('goes urgent when it is almost full, and says what is happening when saving fails', async () => {
    const { push } = withStatus({ freeBytes: 0.4 * GIB, level: 'critical', saveFailing: false })
    render(<StorageBanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your disk is almost full (0.4 GB left)')

    push({ freeBytes: 0, level: 'critical', saveFailing: true })
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Your disk is full, so WingLog can't save the flight. It is keeping the track in memory and will save it as soon as there is room."
    )
  })

  it('goes away when space is freed', async () => {
    const { push } = withStatus({ freeBytes: 2 * GIB, level: 'low', saveFailing: false })
    render(<StorageBanner />)
    await screen.findByRole('alert')
    push({ freeBytes: 60 * GIB, level: 'ok', saveFailing: false })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
