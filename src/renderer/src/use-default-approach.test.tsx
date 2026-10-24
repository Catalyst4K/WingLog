import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { NavdataProcedureOption, ProcedureSelection, WingLogApi } from '@shared/ipc'
import { emptyProcedureSelection, type ProcedureAirports } from '@shared/procedure-selection'
import type { Waypoint } from '@shared/route'
import { resetUiMemory } from './ui-memory'
import { useDefaultApproach } from './use-default-approach'

const NO_WAYPOINTS: Waypoint[] = []

function proc(identifier: string, transition: string | null = null): NavdataProcedureOption {
  return { identifier, transition }
}

function withWinglog(approaches: (icao: string) => NavdataProcedureOption[]): WingLogApi {
  const api = {
    navdataRefreshAirport: vi.fn().mockResolvedValue(undefined),
    navdataListApproaches: vi.fn((icao: string) => Promise.resolve(approaches(icao)))
  } as unknown as WingLogApi
  window.winglog = api
  return api
}

/** The selection held as a view holds it, with the hook suggesting into it. */
function useSuggested(
  airports: ProcedureAirports | null,
  initial: ProcedureSelection = emptyProcedureSelection()
): {
  selection: ProcedureSelection
  setSelection: (next: ProcedureSelection) => void
} {
  const [selection, setSelection] = useState(initial)
  useDefaultApproach(airports, selection, setSelection, NO_WAYPOINTS)
  return { selection, setSelection }
}

describe('useDefaultApproach', () => {
  afterEach(() => resetUiMemory())

  it('does not suggest again an approach cleared on another screen, which arrives as a plain change of selection', async () => {
    withWinglog(() => [proc('ILS 07L'), proc('RNP 07L')])
    const airports: ProcedureAirports = { depIcao: 'ZBAA', arrIcao: 'VHHH', ofpJson: null }
    const { result } = renderHook(() => useSuggested(airports))
    await waitFor(() => expect(result.current.selection.approachIdent).toBe('ILS 07L'))

    // The phone's "None", as the PC announces it.
    act(() => result.current.setSelection({ ...result.current.selection, approachIdent: null }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.current.selection.approachIdent).toBeNull()
  })

  it('treats a switch to the alternate as a new airport, not a cleared approach', async () => {
    withWinglog((icao) => (icao === 'VMMC' ? [proc('ILS 34')] : [proc('ILS 07L')]))
    const airports: ProcedureAirports = { depIcao: 'ZBAA', arrIcao: 'VHHH', altnIcao: 'VMMC', ofpJson: null }
    const { result } = renderHook(() => useSuggested(airports))
    await waitFor(() => expect(result.current.selection.approachIdent).toBe('ILS 07L'))

    act(() =>
      result.current.setSelection({ ...result.current.selection, arrivalIcao: 'VMMC', approachIdent: null })
    )
    await waitFor(() => expect(result.current.selection.approachIdent).toBe('ILS 34'))
  })

  it('asks for nothing without a real arrival airport', async () => {
    const api = withWinglog(() => [proc('ILS 07L')])
    renderHook(() => useSuggested({ depIcao: 'EGLL', arrIcao: 'ZZZZ', ofpJson: null }))
    renderHook(() => useSuggested(null))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.navdataListApproaches).not.toHaveBeenCalled()
    expect(api.navdataRefreshAirport).not.toHaveBeenCalled()
  })

  it('falls back to no suggestion when the approach list cannot be read', async () => {
    const api = withWinglog(() => [])
    vi.mocked(api.navdataListApproaches).mockRejectedValue(new Error('no cache yet'))
    const { result } = renderHook(() => useSuggested({ depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: null }))
    await waitFor(() => expect(api.navdataRefreshAirport).toHaveBeenCalledWith('KJFK'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.current.selection.approachIdent).toBeNull()
  })
})
