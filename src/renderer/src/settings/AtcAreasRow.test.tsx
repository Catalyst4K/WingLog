import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AtcAreasCheck, AtcAreasStatus } from '@shared/ipc'
import { AtcAreasRow } from './AtcAreasRow'

const BUNDLED: AtcAreasStatus = {
  auto: true,
  source: 'bundled',
  vatspy: 'v2610.1',
  tracon: 'v1.2.13',
  checkedAt: null
}

function setup(status: AtcAreasStatus = BUNDLED, check?: AtcAreasCheck | Error) {
  const api = {
    atcAreasGetStatus: vi.fn(() => Promise.resolve(status)),
    atcAreasSetAuto: vi.fn((on: boolean) => Promise.resolve({ ...status, auto: on })),
    atcAreasCheckNow: vi.fn(() =>
      check instanceof Error
        ? Promise.reject(check)
        : Promise.resolve(check ?? { outcome: 'current', status })
    ),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

describe('AtcAreasRow', () => {
  it('shows nothing until the status is read, then the switch, the releases in use and that it was never checked', async () => {
    setup()
    render(<AtcAreasRow />)
    const group = await screen.findByRole('group', { name: 'Keep ATC areas up to date' })
    expect(within(group).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByText(/In use: VAT-Spy v2610\.1, TRACON v1\.2\.13 \(bundled with WingLog\)\./)
    ).toBeInTheDocument()
    expect(screen.getByText(/Not checked yet\./)).toBeInTheDocument()
    expect(screen.getByText(/It sends nothing but WingLog's version/)).toBeInTheDocument()
  })

  it('says a downloaded copy came from GitHub, and when it was last checked', async () => {
    setup({
      auto: true,
      source: 'downloaded',
      vatspy: 'v2611.1',
      tracon: 'v1.2.14',
      checkedAt: '2026-11-03T10:00:00.000Z'
    })
    render(<AtcAreasRow />)
    expect(
      await screen.findByText(
        /In use: VAT-Spy v2611\.1, TRACON v1\.2\.14 \(downloaded from GitHub\)\. Last checked/
      )
    ).toBeInTheDocument()
  })

  it('switches the automatic check off and shows the saved status', async () => {
    const api = setup()
    render(<AtcAreasRow />)
    const group = await screen.findByRole('group', { name: 'Keep ATC areas up to date' })
    await userEvent.click(within(group).getByRole('button', { name: 'Off' }))
    expect(api.atcAreasSetAuto).toHaveBeenCalledWith(false)
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
    )
  })

  it('Check now asks, shows it is checking meanwhile, and says it is already the newest', async () => {
    const api = setup()
    render(<AtcAreasRow />)
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    expect(api.atcAreasCheckNow).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Already the newest.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
  })

  it('Check now says what it updated to, and shows the new releases in use', async () => {
    setup(BUNDLED, {
      outcome: 'updated',
      status: {
        auto: true,
        source: 'downloaded',
        vatspy: 'v2611.1',
        tracon: 'v1.2.13',
        checkedAt: '2026-11-05T12:00:00.000Z'
      }
    })
    render(<AtcAreasRow />)
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Updated to VAT-Spy v2611.1, TRACON v1.2.13.')).toBeInTheDocument()
    expect(screen.getByText(/\(downloaded from GitHub\)/)).toBeInTheDocument()
  })

  it('Check now says when it could not check', async () => {
    setup(BUNDLED, { outcome: 'failed', status: BUNDLED })
    render(<AtcAreasRow />)
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Could not check. Try again later.')).toBeInTheDocument()
  })

  it('puts the button back when the call itself throws', async () => {
    const api = setup(BUNDLED, new Error('ipc broke'))
    render(<AtcAreasRow />)
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(api.appLogRendererError).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
  })
})
