import { describe, expect, it } from 'vitest'
import { formatMaintenanceValue, maintenanceFieldLabelKey } from './fleet-maintenance-format'

describe('formatMaintenanceValue', () => {
  it('rounds a battery percentage to a whole number with a % suffix', () => {
    expect(formatMaintenanceValue('batteryPct', '97.234558')).toBe('97%')
    expect(formatMaintenanceValue('batteryEmergencyPct', '4.5')).toBe('5%')
  })

  it('rounds APU/engine hours to one decimal place with an "h" suffix', () => {
    expect(formatMaintenanceValue('apuHours', '1565.109009')).toBe('1565.1 h')
    expect(formatMaintenanceValue('engineHours', '7045.364258')).toBe('7045.4 h')
  })

  it('rounds a start-cycle count to a whole number with no suffix', () => {
    expect(formatMaintenanceValue('apuStartCycles', '4')).toBe('4')
  })

  it('rounds oil quantity and hydraulics reservoir to one decimal with no unit', () => {
    expect(formatMaintenanceValue('apuOilQuantity', '10.463158')).toBe('10.5')
    expect(formatMaintenanceValue('hydraulicsReservoir', '41.691605')).toBe('41.7')
  })

  it('does not add a trailing ".0" to an already-whole number (PMDG oil quantity)', () => {
    expect(formatMaintenanceValue('oilQuantity', '1854')).toBe('1854')
  })

  it('leaves an unrecognized field key exactly as given (PMDG wheel/fuel/hydraulics fields)', () => {
    expect(formatMaintenanceValue('wheelMain', '2')).toBe('2')
    expect(formatMaintenanceValue('fuelVolume', '10300.000000')).toBe('10300.000000')
  })

  it('returns the raw value unchanged if it is somehow not a finite number', () => {
    expect(formatMaintenanceValue('batteryPct', 'not-a-number')).toBe('not-a-number')
  })
})

describe('maintenanceFieldLabelKey', () => {
  it('maps hydraulicsReservoir index 1 to the Yellow system label', () => {
    expect(maintenanceFieldLabelKey('hydraulicsReservoir', 1)).toBe('fleetView.maintenance.fields.hydraulicsReservoirYellow')
  })

  it('maps hydraulicsReservoir index 2 to the Green system label', () => {
    expect(maintenanceFieldLabelKey('hydraulicsReservoir', 2)).toBe('fleetView.maintenance.fields.hydraulicsReservoirGreen')
  })

  it('falls back to the generic numbered label for an unexpected index', () => {
    expect(maintenanceFieldLabelKey('hydraulicsReservoir', 3)).toBe('fleetView.maintenance.fields.hydraulicsReservoir')
    expect(maintenanceFieldLabelKey('hydraulicsReservoir', undefined)).toBe('fleetView.maintenance.fields.hydraulicsReservoir')
  })

  it('leaves every other field key untouched', () => {
    expect(maintenanceFieldLabelKey('apuHours', undefined)).toBe('fleetView.maintenance.fields.apuHours')
    expect(maintenanceFieldLabelKey('batteryPct', 1)).toBe('fleetView.maintenance.fields.batteryPct')
  })
})
