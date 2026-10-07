import { describe, expect, it } from 'vitest'
import type { GsxRemoteMenuState } from '@shared/ipc'
import { gsxMenuSignature, gsxPromptState, isImportantGsxMenu } from './gsx-remote-importance'

function menu(overrides: Partial<GsxRemoteMenuState> = {}): GsxRemoteMenuState {
  return {
    menuShown: true,
    searchActive: false,
    searchSession: 0,
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
    expect(
      isImportantGsxMenu(menu({ title: 'Interrupt pushback?', entries: ['Yes', 'No', 'Cameras ▶'] }))
    ).toBe(false)
  })

  it('does not flag the boarding-related tug-attach follow-up by a near-miss title', () => {
    expect(isImportantGsxMenu(menu({ title: 'Attach pushback tug?', entries: ['Yes', 'No'] }))).toBe(false)
  })

  it('does not flag a matching title while the menu is closed (stale entries)', () => {
    expect(
      isImportantGsxMenu(
        menu({
          menuShown: false,
          title: 'Select refueling level',
          entries: [' 35% - 14700 USGAL / 44674 kg']
        })
      )
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

describe('gsxPromptState', () => {
  const pushback = menu({ title: 'Select pushback direction', entries: ['Left', 'Right'] })

  it('opens the global prompt for an important menu when the GSX tab is not showing', () => {
    expect(gsxPromptState(pushback, false, null)).toEqual({ open: true, menuKey: gsxMenuSignature(pushback) })
  })

  it('stays closed on the GSX tab, where the menu is answered in place, but still names the menu', () => {
    expect(gsxPromptState(pushback, true, null)).toEqual({ open: false, menuKey: gsxMenuSignature(pushback) })
  })

  it('stays closed for the menu the user dismissed, and opens again for a different one', () => {
    const dismissed = gsxMenuSignature(pushback)
    expect(gsxPromptState(pushback, false, dismissed).open).toBe(false)
    const fuel = menu({ title: 'Select refueling level', entries: ['50%', '100%'] })
    expect(gsxPromptState(fuel, false, dismissed).open).toBe(true)
  })

  it('has no menu key for an unimportant menu or before GSX has sent one', () => {
    expect(gsxPromptState(menu({ title: 'Select handler', entries: ['A'] }), false, null)).toEqual({
      open: false,
      menuKey: null
    })
    expect(gsxPromptState(null, false, null)).toEqual({ open: false, menuKey: null })
  })
})
