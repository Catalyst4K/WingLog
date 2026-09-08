import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type AircraftUpdate,
  type AltitudeUnit,
  type DispatchOpenSimBriefParams,
  type WingLogApi,
  type GsxSettings,
  type LandingThresholds,
  type NavdataProcedureKind,
  type NewAircraft,
  type NewFlight,
  type ProcedureSelection,
  type SimConnectionStatus,
  type SimTelemetry,
  type Theme,
  type TrackPoint,
  type WeightUnit,
  type WindSpeedUnit
} from '@shared/ipc'

const api: WingLogApi = {
  aircraftList: () => ipcRenderer.invoke(IpcChannels.aircraftList),
  aircraftCreate: (aircraft: NewAircraft) => ipcRenderer.invoke(IpcChannels.aircraftCreate, aircraft),
  aircraftUpdate: (aircraft: AircraftUpdate) => ipcRenderer.invoke(IpcChannels.aircraftUpdate, aircraft),
  aircraftDelete: (id: number) => ipcRenderer.invoke(IpcChannels.aircraftDelete, id),
  aircraftReplace: (retiredId: number, replacementId: number) =>
    ipcRenderer.invoke(IpcChannels.aircraftReplace, retiredId, replacementId),
  aircraftImport: () => ipcRenderer.invoke(IpcChannels.aircraftImport),
  aircraftExport: () => ipcRenderer.invoke(IpcChannels.aircraftExport),
  getSimConnectionStatus: () => ipcRenderer.invoke(IpcChannels.simConnectionStatusGet),
  onSimTelemetry: (listener: (telemetry: SimTelemetry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, telemetry: SimTelemetry): void => listener(telemetry)
    ipcRenderer.on(IpcChannels.simTelemetry, handler)
    return () => ipcRenderer.removeListener(IpcChannels.simTelemetry, handler)
  },
  onSimConnectionStatus: (listener: (status: SimConnectionStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: SimConnectionStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.simConnectionStatus, handler)
    return () => ipcRenderer.removeListener(IpcChannels.simConnectionStatus, handler)
  },
  flightList: () => ipcRenderer.invoke(IpcChannels.flightList),
  flightCreate: (flight: NewFlight) => ipcRenderer.invoke(IpcChannels.flightCreate, flight),
  flightCancel: (id: number) => ipcRenderer.invoke(IpcChannels.flightCancel, id),
  flightDelete: (id: number) => ipcRenderer.invoke(IpcChannels.flightDelete, id),
  dispatchFetchOfp: () => ipcRenderer.invoke(IpcChannels.dispatchFetchOfp),
  dispatchOpenSimBrief: (params: DispatchOpenSimBriefParams) =>
    ipcRenderer.invoke(IpcChannels.dispatchOpenSimBrief, params),
  dispatchOpenSimBriefAirframes: (airframeId: string | null) =>
    ipcRenderer.invoke(IpcChannels.dispatchOpenSimBriefAirframes, airframeId),
  dispatchOpenOfpPdf: (ofpJson: string) => ipcRenderer.invoke(IpcChannels.dispatchOpenOfpPdf, ofpJson),
  settingsGetSimbriefUsername: () => ipcRenderer.invoke(IpcChannels.settingsGetSimbriefUsername),
  settingsSetSimbriefUsername: (username: string) =>
    ipcRenderer.invoke(IpcChannels.settingsSetSimbriefUsername, username),
  dispatchGenerateOfp: (params: DispatchOpenSimBriefParams) =>
    ipcRenderer.invoke(IpcChannels.dispatchGenerateOfp, params),
  dispatchLoginSimbrief: () => ipcRenderer.invoke(IpcChannels.dispatchLoginSimbrief),
  dispatchSimbriefLoginStatus: () => ipcRenderer.invoke(IpcChannels.dispatchSimbriefLoginStatus),
  dispatchLogoutSimbrief: () => ipcRenderer.invoke(IpcChannels.dispatchLogoutSimbrief),
  dispatchFetchSimbriefUsername: () => ipcRenderer.invoke(IpcChannels.dispatchFetchSimbriefUsername),
  dispatchGenerationAvailable: () => ipcRenderer.invoke(IpcChannels.dispatchGenerationAvailable),
  settingsGetWeightUnit: () => ipcRenderer.invoke(IpcChannels.settingsGetWeightUnit),
  settingsSetWeightUnit: (unit: WeightUnit) => ipcRenderer.invoke(IpcChannels.settingsSetWeightUnit, unit),
  settingsGetAltitudeUnit: () => ipcRenderer.invoke(IpcChannels.settingsGetAltitudeUnit),
  settingsSetAltitudeUnit: (unit: AltitudeUnit) =>
    ipcRenderer.invoke(IpcChannels.settingsSetAltitudeUnit, unit),
  settingsGetWindSpeedUnit: () => ipcRenderer.invoke(IpcChannels.settingsGetWindSpeedUnit),
  settingsSetWindSpeedUnit: (unit: WindSpeedUnit) =>
    ipcRenderer.invoke(IpcChannels.settingsSetWindSpeedUnit, unit),
  settingsGetTheme: () => ipcRenderer.invoke(IpcChannels.settingsGetTheme),
  settingsSetTheme: (theme: Theme) => ipcRenderer.invoke(IpcChannels.settingsSetTheme, theme),
  trackingStart: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackingStart, flightId),
  trackingStop: () => ipcRenderer.invoke(IpcChannels.trackingStop),
  trackingFinish: () => ipcRenderer.invoke(IpcChannels.trackingFinish),
  trackingGetActive: () => ipcRenderer.invoke(IpcChannels.trackingGetActive),
  trackPointList: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackPointList, flightId),
  onTrackingPoint: (listener: (point: TrackPoint) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, point: TrackPoint): void => listener(point)
    ipcRenderer.on(IpcChannels.trackingPoint, handler)
    return () => ipcRenderer.removeListener(IpcChannels.trackingPoint, handler)
  },
  logbookListCompletedFlights: () => ipcRenderer.invoke(IpcChannels.logbookListCompletedFlights),
  logbookGetStats: () => ipcRenderer.invoke(IpcChannels.logbookGetStats),
  logbookFleetStats: () => ipcRenderer.invoke(IpcChannels.logbookFleetStats),
  logbookImportCsv: () => ipcRenderer.invoke(IpcChannels.logbookImportCsv),
  logbookListInvoices: (flightId: number) => ipcRenderer.invoke(IpcChannels.logbookListInvoices, flightId),
  settingsGetGsx: () => ipcRenderer.invoke(IpcChannels.settingsGetGsx),
  settingsSetGsx: (settings: GsxSettings) => ipcRenderer.invoke(IpcChannels.settingsSetGsx, settings),
  settingsCheckGsxFirstLaunch: () => ipcRenderer.invoke(IpcChannels.settingsCheckGsxFirstLaunch),
  gsxBrowseFolder: () => ipcRenderer.invoke(IpcChannels.gsxBrowseFolder),
  gsxRescanFlight: (flightId: number) => ipcRenderer.invoke(IpcChannels.gsxRescanFlight, flightId),
  gsxAttachNotailReceipt: (flightId: number, jsonPath: string) =>
    ipcRenderer.invoke(IpcChannels.gsxAttachNotailReceipt, flightId, jsonPath),
  gsxOpenReceipt: (sourceHtmlPath: string) => ipcRenderer.invoke(IpcChannels.gsxOpenReceipt, sourceHtmlPath),
  logbookOpenOfpPdf: (flightId: number) => ipcRenderer.invoke(IpcChannels.logbookOpenOfpPdf, flightId),
  logbookGetLanding: (flightId: number) => ipcRenderer.invoke(IpcChannels.logbookGetLanding, flightId),
  logbookGreatCircleRoute: (depIcao: string, arrIcao: string) =>
    ipcRenderer.invoke(IpcChannels.logbookGreatCircleRoute, depIcao, arrIcao),
  fleetListLandings: (aircraftId: number) => ipcRenderer.invoke(IpcChannels.fleetListLandings, aircraftId),
  fleetListFlights: (aircraftId: number) => ipcRenderer.invoke(IpcChannels.fleetListFlights, aircraftId),
  settingsGetLandingThresholds: () => ipcRenderer.invoke(IpcChannels.settingsGetLandingThresholds),
  settingsSetLandingThresholds: (thresholds: LandingThresholds) =>
    ipcRenderer.invoke(IpcChannels.settingsSetLandingThresholds, thresholds),
  aircraftLookupByRegistration: (registration: string) =>
    ipcRenderer.invoke(IpcChannels.aircraftLookupByRegistration, registration),
  aircraftTypeSearch: (query: string) => ipcRenderer.invoke(IpcChannels.aircraftTypeSearch, query),
  simbriefAirframesForType: (icaoType: string) => ipcRenderer.invoke(IpcChannels.simbriefAirframesForType, icaoType),
  simbriefCreateCustomAirframe: (shareUrl: string) =>
    ipcRenderer.invoke(IpcChannels.simbriefCreateCustomAirframe, shareUrl),
  airportSearch: (query: string) => ipcRenderer.invoke(IpcChannels.airportSearch, query),
  airlineSearch: (query: string) => ipcRenderer.invoke(IpcChannels.airlineSearch, query),
  airlineFindByIcao: (icao: string) => ipcRenderer.invoke(IpcChannels.airlineFindByIcao, icao),
  weatherGetMetars: (icaoCodes: string[]) => ipcRenderer.invoke(IpcChannels.weatherGetMetars, icaoCodes),
  fxGetRate: (targetCurrency: string, date?: string) =>
    ipcRenderer.invoke(IpcChannels.fxGetRate, targetCurrency, date),
  authLogin: (email: string, password: string) => ipcRenderer.invoke(IpcChannels.authLogin, email, password),
  authSignup: (email: string, password: string, inviteCode: string) =>
    ipcRenderer.invoke(IpcChannels.authSignup, email, password, inviteCode),
  authLogout: () => ipcRenderer.invoke(IpcChannels.authLogout),
  syncNow: () => ipcRenderer.invoke(IpcChannels.syncNow),
  syncStatus: () => ipcRenderer.invoke(IpcChannels.syncStatus),
  appGetVersion: () => ipcRenderer.invoke(IpcChannels.appGetVersion),
  appOpenGithub: () => ipcRenderer.invoke(IpcChannels.appOpenGithub),
  navdataRefreshAirport: (icao: string) => ipcRenderer.invoke(IpcChannels.navdataRefreshAirport, icao),
  navdataHasAirport: (icao: string) => ipcRenderer.invoke(IpcChannels.navdataHasAirport, icao),
  navdataListRunways: (icao: string) => ipcRenderer.invoke(IpcChannels.navdataListRunways, icao),
  navdataListSids: (icao: string, runway?: string | null) =>
    ipcRenderer.invoke(IpcChannels.navdataListSids, icao, runway),
  navdataListStars: (icao: string, runway?: string | null) =>
    ipcRenderer.invoke(IpcChannels.navdataListStars, icao, runway),
  navdataListApproaches: (icao: string, runway?: string | null) =>
    ipcRenderer.invoke(IpcChannels.navdataListApproaches, icao, runway),
  navdataGetProcedureWaypoints: (
    icao: string,
    kind: NavdataProcedureKind,
    identifier: string,
    runway?: string | null,
    transition?: string | null
  ) => ipcRenderer.invoke(IpcChannels.navdataGetProcedureWaypoints, icao, kind, identifier, runway, transition),
  trackingSetProcedureSelection: (selection: ProcedureSelection) =>
    ipcRenderer.invoke(IpcChannels.trackingSetProcedureSelection, selection)
}

contextBridge.exposeInMainWorld('winglog', api)
