import { SimConnectDataType, type RawBuffer } from 'node-simconnect'
import type { SimTelemetry } from '@shared/ipc'

/**
 * SimVar names, units and read order live only here — see CLAUDE.md. Units are chosen to
 * land in SI directly (meters, m/s, kg) so the main process never has to convert; the
 * renderer converts to aviation units for display, per docs/decisions.md §5.
 *
 * `SIMULATION RATE` (not `SIM RATE`) and metric unit strings are sim-confirmed against a
 * live MSFS 2024 session — see docs/simconnect-notes.md. Order here is the order
 * SimConnect packs the response in, and must match `addToDataDefinition` call order.
 */
export interface SimVarSpec<K extends keyof SimTelemetry> {
  key: K
  name: string
  unit: string | null
  dataType: SimConnectDataType
  read: (data: RawBuffer) => SimTelemetry[K]
}

const asBool = (data: RawBuffer): boolean => data.readInt32() === 1

export const SIM_VARS = [
  { key: 'latitude', name: 'PLANE LATITUDE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'longitude', name: 'PLANE LONGITUDE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  // PLANE ALTITUDE (true, GPS/inertial MSL altitude), not INDICATED ALTITUDE — the latter
  // is the altimeter's *displayed* reading, driven by the Kohlsman/barometric pressure
  // setting, and can read many thousands of feet off true altitude whenever that setting
  // hasn't been synced to local pressure (a real case: a logbook chart's y-axis extending
  // to -13,500ft — docs/decisions.md). PLANE ALTITUDE has no such dependency, so it's the
  // correct source for anything stored/plotted, not just displayed on a virtual altimeter.
  { key: 'altitudeM', name: 'PLANE ALTITUDE', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'altitudeAglM', name: 'PLANE ALT ABOVE GROUND', unit: 'meters', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'verticalSpeedMs', name: 'VERTICAL SPEED', unit: 'meters per second', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'indicatedAirspeedMs', name: 'AIRSPEED INDICATED', unit: 'meters per second', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'trueAirspeedMs', name: 'AIRSPEED TRUE', unit: 'meters per second', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  // The sim's own Mach number, not derived from IAS/altitude here — MACH is exactly what
  // an EFIS/ADC computes onboard, and deriving it ourselves would need an OAT reading we
  // don't otherwise record, so reading it directly is both simpler and more accurate.
  { key: 'machSpeed', name: 'AIRSPEED MACH', unit: 'mach', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'groundSpeedMs', name: 'GROUND VELOCITY', unit: 'meters per second', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'headingTrueDeg', name: 'PLANE HEADING DEGREES TRUE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'pitchDeg', name: 'PLANE PITCH DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'bankDeg', name: 'PLANE BANK DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'onGround', name: 'SIM ON GROUND', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
  { key: 'gForce', name: 'G FORCE', unit: 'GForce', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'fuelTotalKg', name: 'FUEL TOTAL QUANTITY WEIGHT', unit: 'kilograms', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'totalWeightKg', name: 'TOTAL WEIGHT', unit: 'kilograms', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'windSpeedMs', name: 'AMBIENT WIND VELOCITY', unit: 'meters per second', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'windDirectionDeg', name: 'AMBIENT WIND DIRECTION', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'engineCombustion1', name: 'ENG COMBUSTION:1', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
  { key: 'gearHandlePosition', name: 'GEAR HANDLE POSITION', unit: 'Percent Over 100', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'flapsHandleIndex', name: 'FLAPS HANDLE INDEX', unit: 'number', dataType: SimConnectDataType.INT32, read: (d) => d.readInt32() },
  // NOTE: word order corrected vs an earlier draft — confirmed against the MSFS 2024 SDK docs.
  { key: 'parkingBrakeOn', name: 'BRAKE PARKING POSITION', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
  { key: 'atcId', name: 'ATC ID', unit: null, dataType: SimConnectDataType.STRING32, read: (d) => d.readString32() },
  { key: 'atcModel', name: 'ATC MODEL', unit: null, dataType: SimConnectDataType.STRING32, read: (d) => d.readString32() },
  { key: 'title', name: 'TITLE', unit: null, dataType: SimConnectDataType.STRING128, read: (d) => d.readString128() },
  // NOTE: was 'SIM RATE' — sim-confirmed as NAME_UNRECOGNIZED in MSFS 2024, see
  // docs/simconnect-notes.md. 'SIMULATION RATE' is the correct name.
  { key: 'simRate', name: 'SIMULATION RATE', unit: 'number', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'slewActive', name: 'IS SLEW ACTIVE', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool }
] as const satisfies readonly SimVarSpec<keyof SimTelemetry>[]
