import { describe, expect, it } from 'vitest'
import type { GsxRemoteMenuState } from '@shared/ipc'
import { EMPTY_MENU } from './GsxRemoteService'
import {
  decideFollowUp,
  findEntry,
  isAdditionalServicesMenu,
  isEntryDisabled,
  isMainMenu,
  isRefuelingLevelMenu
} from './routine-menu'

function menu(
  title: string,
  entries: string[],
  disabled: boolean[] = [],
  menuShown = true
): GsxRemoteMenuState {
  return { ...EMPTY_MENU, menuShown, title, entries, disabled }
}

const NOTHING_SAID = { answerGsxChoice: false, pickBlockFuel: false, followsOwnPick: false }

describe('which menu is open', () => {
  it('knows the main menu by its title, at any airport', () => {
    expect(isMainMenu(menu('Activate Services at VHHH/Hong Kong', []))).toBe(true)
    expect(isMainMenu(menu('Additional Services', []))).toBe(false)
  })

  it('knows the Additional Services submenu', () => {
    expect(isAdditionalServicesMenu(menu('Additional Services', []))).toBe(true)
    expect(isAdditionalServicesMenu(menu('Activate Services at EGLL/London Heathrow', []))).toBe(false)
  })

  it('knows the refuelling level menu', () => {
    expect(isRefuelingLevelMenu(menu('Select refueling level', []))).toBe(true)
    expect(isRefuelingLevelMenu(menu('Select handling operator', []))).toBe(false)
  })

  it('says none is open when GSX is not showing a menu, whatever its last title was', () => {
    const closed = menu('Activate Services at EGLL/London Heathrow', [], [], false)
    expect(isMainMenu(closed)).toBe(false)
    expect(isAdditionalServicesMenu({ ...closed, title: 'Additional Services' })).toBe(false)
    expect(isRefuelingLevelMenu({ ...closed, title: 'Select refueling level' })).toBe(false)
  })
})

describe('finding an entry', () => {
  const entries = ['Request Catering service', 'Request Refueling', 'Request Refueling later']

  it('matches the whole label, not the start of one', () => {
    expect(findEntry(menu('x', entries), 'Request Refueling')).toBe(1)
  })

  it('does not find a label that is not there', () => {
    expect(findEntry(menu('x', entries), 'Request Boarding')).toBe(-1)
    expect(findEntry(menu('x', entries), 'Request')).toBe(-1)
  })

  it('reads greyed-out entries, and treats a missing flag as not greyed out', () => {
    const greyed = menu('x', entries, [false, true])
    expect(isEntryDisabled(greyed, 1)).toBe(true)
    expect(isEntryDisabled(greyed, 0)).toBe(false)
    expect(isEntryDisabled(greyed, 2)).toBe(false)
  })
})

describe('decideFollowUp', () => {
  const level = menu('Select refueling level', [
    ' 50% - 30870 USGAL / 93815 kg [DEFUEL]',
    ' 72% - BLOCK FUEL from Simbrief - 61740 USGAL / 187631 kg',
    '100% - 85750 USGAL / 260000 kg'
  ])

  it('picks the block fuel entry only when the routine stores that choice', () => {
    expect(decideFollowUp(level, { ...NOTHING_SAID, pickBlockFuel: true })).toEqual({
      kind: 'pick',
      index: 1,
      label: ' 72% - BLOCK FUEL from Simbrief - 61740 USGAL / 187631 kg'
    })
    expect(decideFollowUp(level, NOTHING_SAID)).toEqual({ kind: 'wait', title: 'Select refueling level' })
  })

  it('does not answer the refuelling level with GSX’s own choice', () => {
    const withDefault = menu('Select refueling level', ['50%', '72% [GSX choice]'])
    expect(
      decideFollowUp(withDefault, { answerGsxChoice: true, pickBlockFuel: false, followsOwnPick: true })
    ).toEqual({
      kind: 'wait',
      title: 'Select refueling level'
    })
  })

  it.each([
    ['there is no block fuel entry (GSX has no plan)', menu('Select refueling level', ['50%', '100%'])],
    [
      'the block fuel entry is greyed out',
      menu('Select refueling level', ['72% - BLOCK FUEL from Simbrief'], [true])
    ],
    [
      'the block fuel entry would defuel',
      menu('Select refueling level', ['72% - BLOCK FUEL from Simbrief [DEFUEL]'])
    ]
  ])('leaves the level to the pilot when %s', (_label, shown) => {
    expect(decideFollowUp(shown, { ...NOTHING_SAID, pickBlockFuel: true })).toEqual({
      kind: 'wait',
      title: 'Select refueling level'
    })
  })

  it('picks GSX’s own default on a menu that follows the routine’s pick, when asked to', () => {
    const operators = menu('Select catering operator', ['Gate Gourmet', 'DNATA Catering [GSX choice]'])
    expect(
      decideFollowUp(operators, { answerGsxChoice: true, pickBlockFuel: false, followsOwnPick: true })
    ).toEqual({
      kind: 'pick',
      index: 1,
      label: 'DNATA Catering [GSX choice]'
    })
  })

  it.each([
    [
      'the routine does not answer for GSX',
      { answerGsxChoice: false, pickBlockFuel: false, followsOwnPick: true }
    ],
    [
      'the menu did not follow the routine’s pick',
      { answerGsxChoice: true, pickBlockFuel: false, followsOwnPick: false }
    ]
  ])('waits when %s', (_label, context) => {
    const operators = menu('Select catering operator', ['Gate Gourmet', 'DNATA Catering [GSX choice]'])
    expect(decideFollowUp(operators, context)).toEqual({ kind: 'wait', title: 'Select catering operator' })
  })

  it('waits when the default is greyed out or the menu has none', () => {
    const context = { answerGsxChoice: true, pickBlockFuel: false, followsOwnPick: true }
    expect(decideFollowUp(menu('Select handling operator', ['A [GSX choice]'], [true]), context).kind).toBe(
      'wait'
    )
    expect(decideFollowUp(menu('Select handling operator', ['A', 'B']), context).kind).toBe('wait')
  })

  it('never answers the pushback tug question, even right after a pick', () => {
    const tug = menu('Attach Pushback Tug now?', ['Yes', 'No [GSX choice]'])
    expect(
      decideFollowUp(tug, { answerGsxChoice: true, pickBlockFuel: true, followsOwnPick: true }).kind
    ).toBe('wait')
  })
})
