import { describe, expect, it } from 'vitest'
import type { NavdataProcedureOption, ProcedureSelection } from './ipc'
import {
  starLastIdent,
  suggestApproach,
  transitionsFor,
  type ApproachSuggestionInput
} from './approach-suggestion'
import { emptyProcedureSelection } from './procedure-selection'
import { VECTORS_TRANSITION, type Waypoint } from './route'

const proc = (identifier: string, transition: string | null = null): NavdataProcedureOption => ({
  identifier,
  transition
})

/** Nothing chosen, a list of approaches in, no STAR known, nothing cleared. */
function input(over: Partial<ApproachSuggestionInput> = {}): ApproachSuggestionInput {
  return {
    airports: { depIcao: 'ZGGG', arrIcao: 'ZJSY', ofpJson: null },
    selection: emptyProcedureSelection(),
    options: [proc('ILS X 08', 'SY400'), proc('ILS Z 08', 'SY498')],
    starEnd: null,
    cleared: false,
    suggested: null,
    ...over
  }
}

const chosen = (over: Partial<ProcedureSelection>): ProcedureSelection => ({
  ...emptyProcedureSelection(),
  ...over
})

describe('suggestApproach: picking when nothing is chosen', () => {
  it('picks an approach, the first ILS, and says it was the suggestion', () => {
    expect(suggestApproach(input())).toEqual({ patch: { approachIdent: 'ILS X 08' }, suggested: 'ILS X 08' })
  })

  it('prefers the approach the STAR leads into (ZJSY: UPRS2C ends at SY498, the entry to ILS Z 08, not ILS X 08)', () => {
    expect(suggestApproach(input({ starEnd: 'SY498' }))?.patch).toEqual({ approachIdent: 'ILS Z 08' })
  })

  it('does nothing before the airport list is in, or when it is empty', () => {
    expect(suggestApproach(input({ options: null }))).toBeNull()
    expect(suggestApproach(input({ options: [] }))).toBeNull()
  })

  it('does nothing when the pilot cleared the approach for this plan and airport', () => {
    expect(suggestApproach(input({ cleared: true }))).toBeNull()
  })

  it('never picks the synthetic Visual approach over a real one, but does when it is all there is', () => {
    expect(
      suggestApproach(input({ options: [proc('Visual 08'), proc('RNP 08')] }))?.patch.approachIdent
    ).toBe('RNP 08')
    expect(suggestApproach(input({ options: [proc('Visual 08')] }))?.patch.approachIdent).toBe('Visual 08')
  })

  it("restricts the pick to the OFP's planned arrival runway when one is set", () => {
    const ofpJson = JSON.stringify({ api_params: { destrwy: '26' }, general: {} })
    const options = [proc('ILS 08'), proc('ILS 26')]
    expect(
      suggestApproach(input({ options, airports: { depIcao: 'ZGGG', arrIcao: 'ZJSY', ofpJson } }))?.patch
    ).toEqual({
      approachIdent: 'ILS 26'
    })
  })

  it("does not restrict an alternate's approach to the planned destination runway", () => {
    const ofpJson = JSON.stringify({ api_params: { destrwy: '26' }, general: {} })
    const result = suggestApproach(
      input({
        options: [proc('ILS 08')],
        airports: { depIcao: 'ZGGG', arrIcao: 'ZJSY', ofpJson },
        selection: chosen({ arrivalIcao: 'ZGSZ' })
      })
    )
    expect(result?.patch).toEqual({ approachIdent: 'ILS 08' })
  })

  it('picks nothing when the planned runway has no approach', () => {
    const ofpJson = JSON.stringify({ api_params: { destrwy: '26' }, general: {} })
    expect(
      suggestApproach(
        input({ options: [proc('ILS 08')], airports: { depIcao: 'ZGGG', arrIcao: 'ZJSY', ofpJson } })
      )
    ).toBeNull()
  })

  it('does not pick when an approach is already chosen, by the pilot or from an earlier plan', () => {
    expect(
      suggestApproach(
        input({ selection: chosen({ approachIdent: 'ILS Z 08', approachTransition: 'SY498' }) })
      )
    ).toBeNull()
  })
})

describe('suggestApproach: keeping the suggestion joined to the STAR', () => {
  it('swaps the approach WingLog suggested when the STAR end arrives after it', () => {
    const result = suggestApproach(
      input({ selection: chosen({ approachIdent: 'ILS X 08' }), suggested: 'ILS X 08', starEnd: 'SY498' })
    )
    expect(result).toEqual({
      patch: { approachIdent: 'ILS Z 08', approachTransition: 'SY498' },
      suggested: 'ILS Z 08'
    })
  })

  it('never swaps an approach the pilot chose', () => {
    expect(
      suggestApproach(
        input({ selection: chosen({ approachIdent: 'ILS X 08' }), suggested: null, starEnd: 'SY498' })
      )
    ).toBeNull()
    expect(
      suggestApproach(
        input({ selection: chosen({ approachIdent: 'ILS X 08' }), suggested: 'ILS Z 08', starEnd: 'SY498' })
      )
    ).toBeNull()
  })

  it('does not swap when no approach for its runway starts where the STAR ends', () => {
    expect(
      suggestApproach(
        input({ selection: chosen({ approachIdent: 'ILS X 08' }), suggested: 'ILS X 08', starEnd: 'ZZZZZ' })
      )
    ).toBeNull()
  })

  it('keeps Vectors, which was chosen on purpose, whatever the STAR ends at', () => {
    expect(
      suggestApproach(
        input({
          selection: chosen({ approachIdent: 'ILS X 08', approachTransition: VECTORS_TRANSITION }),
          suggested: 'ILS X 08',
          starEnd: 'SY498'
        })
      )
    ).toBeNull()
  })
})

describe('suggestApproach: joining the approach to the STAR with its transition', () => {
  it("fills the transition named after the STAR's last fix", () => {
    const result = suggestApproach(
      input({ selection: chosen({ approachIdent: 'ILS Z 08' }), suggested: null, starEnd: 'SY498' })
    )
    expect(result).toEqual({ patch: { approachTransition: 'SY498' }, suggested: null })
  })

  it("does nothing when the STAR's last fix is not one of the approach's transitions, or there is no STAR", () => {
    const selection = chosen({ approachIdent: 'ILS Z 08' })
    expect(suggestApproach(input({ selection, starEnd: 'NOPE' }))).toBeNull()
    expect(suggestApproach(input({ selection, starEnd: null }))).toBeNull()
  })

  it('never overwrites a transition already set', () => {
    expect(
      suggestApproach(
        input({
          selection: chosen({ approachIdent: 'ILS Z 08', approachTransition: 'OTHER' }),
          starEnd: 'SY498'
        })
      )
    ).toBeNull()
  })
})

describe('suggestApproach: reaching the end by applying each change in turn', () => {
  it('picks, then swaps to the connecting approach, then joins it, and then stops', () => {
    let selection = emptyProcedureSelection()
    let suggested: string | null = null
    const steps: Partial<ProcedureSelection>[] = []
    // The STAR end is known from the start here; a pick that ignored it would be swapped on the way.
    for (let i = 0; i < 6; i++) {
      const next = suggestApproach(input({ selection, suggested, starEnd: 'SY498' }))
      if (!next) break
      steps.push(next.patch)
      selection = { ...selection, ...next.patch }
      suggested = next.suggested
    }
    expect(steps).toEqual([{ approachIdent: 'ILS Z 08' }, { approachTransition: 'SY498' }])
    expect(selection).toMatchObject({ approachIdent: 'ILS Z 08', approachTransition: 'SY498' })
  })
})

describe('starLastIdent and transitionsFor', () => {
  const waypoint = (ident: string, segment: Waypoint['segment']): Waypoint =>
    ({ ident, segment, lat: 0, lon: 0 }) as Waypoint

  it("gives the STAR's last waypoint, or null when the route has no STAR", () => {
    expect(
      starLastIdent([
        waypoint('A', 'sid'),
        waypoint('B', 'star'),
        waypoint('C', 'star'),
        waypoint('D', 'approach')
      ])
    ).toBe('C')
    expect(starLastIdent([waypoint('A', 'sid')])).toBeNull()
    expect(starLastIdent([])).toBeNull()
  })

  it("lists an approach's own named transitions, each once", () => {
    const options = [
      proc('ILS Z 08', 'SY498'),
      proc('ILS Z 08', 'SY498'),
      proc('ILS Z 08', null),
      proc('ILS X 08', 'SY400')
    ]
    expect(transitionsFor(options, 'ILS Z 08')).toEqual(['SY498'])
    expect(transitionsFor(options, null)).toEqual([])
  })
})
