import { describe, expect, it } from 'vitest'
import type { GsxRemoteMenuState } from '@shared/ipc'
import { gsxMenuSignature, isImportantGsxMenu } from './gsx-remote-importance'

function menu(overrides: Partial<GsxRemoteMenuState> = {}): GsxRemoteMenuState {
  return {
    title: '',
    header: '',
    subtitle: '',
    entries: [],
    icons: [],
    disabled: [],
    layout: 'list',
    ...overrides
  }
}

describe('isImportantGsxMenu', () => {
  it('flags the real confirmed fuel-amount menu', () => {
    expect(
      isImportantGsxMenu(
        menu({
          title: 'Select refueling level',
          header: 'Select refueling level',
          entries: [' 35% - 14700 USGAL / 44674 kg', 'Custom refueling using default Fuel menu']
        })
      )
    ).toBe(true)
  })

  it('flags the real confirmed pushback-direction menu', () => {
    expect(
      isImportantGsxMenu(
        menu({
          title: 'Select pushback direction',
          header: 'Select pushback direction',
          entries: ['RED - Facing South onto B9', 'BLUE - Facing East onto B7']
        })
      )
    ).toBe(true)
  })

  it('does not flag the top-level ground-services menu', () => {
    expect(
      isImportantGsxMenu(
        menu({
          title: '',
          header: '',
          entries: ['Request Deboarding', 'Request Catering service', 'Prepare for Push-back and Departure']
        })
      )
    ).toBe(false)
  })

  it('does not flag an empty menu', () => {
    expect(isImportantGsxMenu(menu())).toBe(false)
  })

  it('does not flag an unrelated confirmation dialog (e.g. "Interrupt pushback?")', () => {
    expect(isImportantGsxMenu(menu({ title: 'Interrupt pushback?', entries: ['Yes', 'No', 'Cameras ▶'] }))).toBe(
      false
    )
  })

  it('does not flag the boarding-related tug-attach follow-up by a near-miss title', () => {
    expect(
      isImportantGsxMenu(menu({ title: 'Attach pushback tug?', entries: ['Yes', 'No'] }))
    ).toBe(false)
  })
})

describe('gsxMenuSignature', () => {
  it('differs for menus with different entries, same for identical ones', () => {
    const a = menu({ title: 'Select pushback direction', entries: ['RED', 'BLUE'] })
    const b = menu({ title: 'Select pushback direction', entries: ['RED', 'BLUE'] })
    const c = menu({ title: 'Select pushback direction', entries: ['RED', 'GREEN'] })
    expect(gsxMenuSignature(a)).toBe(gsxMenuSignature(b))
    expect(gsxMenuSignature(a)).not.toBe(gsxMenuSignature(c))
  })
})
