import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { GSX_ROUTINE_SERVICES, type GsxRoutineService } from '@shared/gsx-routines'
import type { GsxRoutineNote, GsxRoutineSkipReason, GsxRoutineStopReason } from '@shared/gsx-routine-progress'
import i18n from './i18n'
import { describeNote, routineName, serviceLabel } from './gsx-routine-text'

const t = i18n.t.bind(i18n) as unknown as TFunction

const STOP_REASONS: GsxRoutineStopReason[] = [
  'cancelled',
  'gsx-disconnected',
  'aircraft-moved',
  'departure',
  'menu-failed',
  'gsx-has-no-plan',
  'no-planned-weight'
]
const SKIP_REASONS: GsxRoutineSkipReason[] = ['not-offered', 'dropped', 'bypassed']

describe('serviceLabel', () => {
  it('words every service a routine can ask for', () => {
    expect(GSX_ROUTINE_SERVICES.map((service) => serviceLabel(t, service))).toEqual([
      'Deboarding',
      'Catering',
      'Refueling',
      'Boarding',
      'Jetway',
      'GPU',
      'Lavatory',
      'Water',
      'Cleaning'
    ])
  })
})

describe('describeNote', () => {
  const service: GsxRoutineService = 'Catering'
  const notes: [GsxRoutineNote, string][] = [
    [{ code: 'starting' }, 'Starting…'],
    [{ code: 'opening-menu', service }, "Opening GSX's menu to ask for Catering…"],
    [{ code: 'asking', service }, 'Asking GSX for Catering…'],
    [{ code: 'waiting-for-stage', services: ['Catering', 'Refueling'] }, 'Waiting for: Catering, Refueling.'],
    [
      { code: 'waiting-for-pilot', menu: 'Select refueling level' },
      'Waiting for you: Select refueling level'
    ],
    [{ code: 'waiting-for-fuel-entry', gapKg: null }, 'Waiting for the fuel to be entered before boarding.'],
    [{ code: 'waiting-for-fuel-entry', gapKg: 8200 }, 'Waiting for the fuel: 8200 kg off the target.'],
    [{ code: 'waiting-for-payload-entry' }, 'Waiting for the payload to be entered before refueling.'],
    [{ code: 'entry-timed-out' }, 'A data entry took too long, so the routine went on without it.'],
    [{ code: 'following', services: ['Boarding'] }, 'Waiting for: Boarding.'],
    [{ code: 'following', services: [] }, 'Starting…'],
    [{ code: 'stalled', services: ['Cleaning'] }, 'Still waiting for: Cleaning after 30 minutes.'],
    [{ code: 'finished' }, 'Routine finished.']
  ]

  it.each(notes)('words %j', (note, expected) => {
    expect(describeNote(t, note)).toBe(expected)
  })

  it.each(SKIP_REASONS)('words a service skipped because %s', (reason) => {
    const text = describeNote(t, { code: 'skipped', service: 'GPU', reason })
    expect(text).toMatch(/^Skipped GPU: /)
    expect(text).not.toContain('gsxRoutines')
  })

  it.each(STOP_REASONS)('words a routine stopped because %s', (reason) => {
    const text = describeNote(t, { code: 'stopped', reason })
    expect(text).toMatch(/^Routine (stopped|cancelled)/)
    expect(text).not.toContain('gsxRoutines')
  })
})

describe('routineName', () => {
  it('words the three built-ins in the pilot’s language, by mark or by id', () => {
    expect(routineName(t, { id: 'builtin-fenix-departure', name: 'x', builtIn: 'fenix-departure' })).toBe(
      'Departure'
    )
    expect(routineName(t, { id: 'builtin-arrival', name: 'Arrival' })).toBe('Arrival')
    expect(routineName(t, { id: 'builtin-turnaround-clean', name: 'Turnaround clean' })).toBe(
      'Turnaround clean'
    )
  })

  it('shows a name the pilot gave an example as they typed it', () => {
    expect(routineName(t, { id: 'builtin-arrival', name: 'My arrival' })).toBe('My arrival')
  })

  it('leaves a routine of the pilot’s own as they typed it', () => {
    expect(routineName(t, { id: 'abc-123', name: 'My Heavy Turn' })).toBe('My Heavy Turn')
  })
})
