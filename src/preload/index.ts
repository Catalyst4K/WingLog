import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type AircraftUpdate,
  type AltitudeUnit,
  type AppLanguage,
  type DataFormat,
  type DispatchOpenSimBriefParams,
  type WingLogApi,
  type GsxRemoteCommandBar,
  type GsxRemoteCommandId,
  type GsxRemoteConnectionStatus,
  type GsxRemoteGateInfo,
  type GsxRemoteMenuState,
  type GsxRemotePromptState,
  type GsxRemoteServiceStatus,
  type GsxRemoteSettings,
  type GsxSettings,
  type LandingDistanceUnit,
  type MaintenanceAddonSettings,
  type MapLanguage,
  type NavdataProcedureKind,
  type NewAircraft,
  type NewFlight,
  type ProcedureSelection,
  type SimConnectionStatus,
  type SimTelemetry,
  type StartFreeFlightInput,
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
  aircraftRetire: (id: number) => ipcRenderer.invoke(IpcChannels.aircraftRetire, id),
  aircraftUnretire: (id: number) => ipcRenderer.invoke(IpcChannels.aircraftUnretire, id),
  aircraftImport: (format?: DataFormat) => ipcRenderer.invoke(IpcChannels.aircraftImport, format),
  aircraftExport: (format?: DataFormat) => ipcRenderer.invoke(IpcChannels.aircraftExport, format),
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
  flightLinkAircraft: (flightId: number, aircraftId: number) =>
    ipcRenderer.invoke(IpcChannels.flightLinkAircraft, flightId, aircraftId),
  dispatchFetchOfp: () => ipcRenderer.invoke(IpcChannels.dispatchFetchOfp),
  dispatchGetInProgressFlight: () => ipcRenderer.invoke(IpcChannels.dispatchGetInProgressFlight),
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
  settingsGetMapLanguage: () => ipcRenderer.invoke(IpcChannels.settingsGetMapLanguage),
  settingsSetMapLanguage: (language: MapLanguage) =>
    ipcRenderer.invoke(IpcChannels.settingsSetMapLanguage, language),
  settingsGetAppLanguage: () => ipcRenderer.invoke(IpcChannels.settingsGetAppLanguage),
  settingsSetAppLanguage: (language: AppLanguage) =>
    ipcRenderer.invoke(IpcChannels.settingsSetAppLanguage, language),
  settingsGetSystemLocale: () => ipcRenderer.invoke(IpcChannels.settingsGetSystemLocale),
  settingsGetWindSpeedUnit: () => ipcRenderer.invoke(IpcChannels.settingsGetWindSpeedUnit),
  settingsSetWindSpeedUnit: (unit: WindSpeedUnit) =>
    ipcRenderer.invoke(IpcChannels.settingsSetWindSpeedUnit, unit),
  settingsGetLandingDistanceUnit: () => ipcRenderer.invoke(IpcChannels.settingsGetLandingDistanceUnit),
  settingsSetLandingDistanceUnit: (unit: LandingDistanceUnit) =>
    ipcRenderer.invoke(IpcChannels.settingsSetLandingDistanceUnit, unit),
  settingsGetTheme: () => ipcRenderer.invoke(IpcChannels.settingsGetTheme),
  settingsSetTheme: (theme: Theme) => ipcRenderer.invoke(IpcChannels.settingsSetTheme, theme),
  trackingStart: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackingStart, flightId),
  trackingStartFree: (input: StartFreeFlightInput) => ipcRenderer.invoke(IpcChannels.trackingStartFree, input),
  trackingGetFreeFlightPrefill: (input) => ipcRenderer.invoke(IpcChannels.trackingGetFreeFlightPrefill, input),
  trackingStop: () => ipcRenderer.invoke(IpcChannels.trackingStop),
  trackingFinish: () => ipcRenderer.invoke(IpcChannels.trackingFinish),
  trackingGetActive: () => ipcRenderer.invoke(IpcChannels.trackingGetActive),
  trackPointList: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackPointList, flightId),
  trackPointCleanup: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackPointCleanup, flightId),
  onTrackingPoint: (listener: (point: TrackPoint) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, point: TrackPoint): void => listener(point)
    ipcRenderer.on(IpcChannels.trackingPoint, handler)
    return () => ipcRenderer.removeListener(IpcChannels.trackingPoint, handler)
  },
  onTrackingPointsUpdated: (listener: (points: TrackPoint[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, points: TrackPoint[]): void => listener(points)
    ipcRenderer.on(IpcChannels.trackingPointsUpdated, handler)
    return () => ipcRenderer.removeListener(IpcChannels.trackingPointsUpdated, handler)
  },
  logbookListCompletedFlights: () => ipcRenderer.invoke(IpcChannels.logbookListCompletedFlights),
  logbookGetStats: () => ipcRenderer.invoke(IpcChannels.logbookGetStats),
  logbookFleetStats: () => ipcRenderer.invoke(IpcChannels.logbookFleetStats),
  logbookImportCsv: () => ipcRenderer.invoke(IpcChannels.logbookImportCsv),
  logbookImportJson: () => ipcRenderer.invoke(IpcChannels.logbookImportJson),
  logbookExport: (format: DataFormat) => ipcRenderer.invoke(IpcChannels.logbookExport, format),
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
  logbookListLandings: (flightId: number) => ipcRenderer.invoke(IpcChannels.logbookListLandings, flightId),
  logbookListAllLandings: () => ipcRenderer.invoke(IpcChannels.logbookListAllLandings),
  logbookGreatCircleRoute: (depIcao: string, arrIcao: string) =>
    ipcRenderer.invoke(IpcChannels.logbookGreatCircleRoute, depIcao, arrIcao),
  fleetListLandings: (aircraftId: number) => ipcRenderer.invoke(IpcChannels.fleetListLandings, aircraftId),
  fleetListFlights: (aircraftId: number) => ipcRenderer.invoke(IpcChannels.fleetListFlights, aircraftId),
  settingsGetMaintenanceAddon: () => ipcRenderer.invoke(IpcChannels.settingsGetMaintenanceAddon),
  settingsSetMaintenanceAddon: (settings: MaintenanceAddonSettings) =>
    ipcRenderer.invoke(IpcChannels.settingsSetMaintenanceAddon, settings),
  maintenanceAddonBrowseFolder: () => ipcRenderer.invoke(IpcChannels.maintenanceAddonBrowseFolder),
  fleetGetMaintenance: (aircraftId: number) => ipcRenderer.invoke(IpcChannels.fleetGetMaintenance, aircraftId),
  logbookListFlightScores: () => ipcRenderer.invoke(IpcChannels.logbookListFlightScores),
  aircraftLookupByRegistration: (registration: string) =>
    ipcRenderer.invoke(IpcChannels.aircraftLookupByRegistration, registration),
  aircraftTypeSearch: (query: string) => ipcRenderer.invoke(IpcChannels.aircraftTypeSearch, query),
  simbriefAirframesForType: (icaoType: string) => ipcRenderer.invoke(IpcChannels.simbriefAirframesForType, icaoType),
  simbriefCreateCustomAirframe: (shareUrl: string) =>
    ipcRenderer.invoke(IpcChannels.simbriefCreateCustomAirframe, shareUrl),
  airportSearch: (query: string) => ipcRenderer.invoke(IpcChannels.airportSearch, query),
  airportListAirfields: () => ipcRenderer.invoke(IpcChannels.airportListAirfields),
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
    ipcRenderer.invoke(IpcChannels.trackingSetProcedureSelection, selection),
  trackingSetDestination: (icao: string | null) => ipcRenderer.invoke(IpcChannels.trackingSetDestination, icao),
  trackingSetDeparture: (icao: string | null) => ipcRenderer.invoke(IpcChannels.trackingSetDeparture, icao),
  trackingGetOrphanedFlight: () => ipcRenderer.invoke(IpcChannels.trackingGetOrphanedFlight),
  trackingResumeOrphaned: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackingResumeOrphaned, flightId),
  trackingDiscardOrphaned: (flightId: number) => ipcRenderer.invoke(IpcChannels.trackingDiscardOrphaned, flightId),
  settingsGetGsxRemote: () => ipcRenderer.invoke(IpcChannels.settingsGetGsxRemote),
  settingsSetGsxRemote: (settings: GsxRemoteSettings) => ipcRenderer.invoke(IpcChannels.settingsSetGsxRemote, settings),
  gsxRemoteGetStatus: () => ipcRenderer.invoke(IpcChannels.gsxRemoteGetStatus),
  onGsxRemoteStatus: (listener: (status: GsxRemoteConnectionStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: GsxRemoteConnectionStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.gsxRemoteStatus, handler)
    return () => ipcRenderer.removeListener(IpcChannels.gsxRemoteStatus, handler)
  },
  gsxRemoteGetServices: () => ipcRenderer.invoke(IpcChannels.gsxRemoteGetServices),
  onGsxRemoteServices: (listener: (services: GsxRemoteServiceStatus[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, services: GsxRemoteServiceStatus[]): void => listener(services)
    ipcRenderer.on(IpcChannels.gsxRemoteServices, handler)
    return () => ipcRenderer.removeListener(IpcChannels.gsxRemoteServices, handler)
  },
  gsxRemoteGetGateInfo: () => ipcRenderer.invoke(IpcChannels.gsxRemoteGetGateInfo),
  onGsxRemoteGate: (listener: (gate: GsxRemoteGateInfo | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, gate: GsxRemoteGateInfo | null): void => listener(gate)
    ipcRenderer.on(IpcChannels.gsxRemoteGate, handler)
    return () => ipcRenderer.removeListener(IpcChannels.gsxRemoteGate, handler)
  },
  gsxRemoteGetMenu: () => ipcRenderer.invoke(IpcChannels.gsxRemoteGetMenu),
  onGsxRemoteMenu: (listener: (menu: GsxRemoteMenuState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, menu: GsxRemoteMenuState): void => listener(menu)
    ipcRenderer.on(IpcChannels.gsxRemoteMenu, handler)
    return () => ipcRenderer.removeListener(IpcChannels.gsxRemoteMenu, handler)
  },
  gsxRemoteGetPrompt: () => ipcRenderer.invoke(IpcChannels.gsxRemoteGetPrompt),
  onGsxRemotePrompt: (listener: (prompt: GsxRemotePromptState | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, prompt: GsxRemotePromptState | null): void => listener(prompt)
    ipcRenderer.on(IpcChannels.gsxRemotePrompt, handler)
    return () => ipcRenderer.removeListener(IpcChannels.gsxRemotePrompt, handler)
  },
  gsxRemoteGetCommandBar: () => ipcRenderer.invoke(IpcChannels.gsxRemoteGetCommandBar),
  onGsxRemoteCommandBar: (listener: (commandBar: GsxRemoteCommandBar) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, commandBar: GsxRemoteCommandBar): void => listener(commandBar)
    ipcRenderer.on(IpcChannels.gsxRemoteCommandBar, handler)
    return () => ipcRenderer.removeListener(IpcChannels.gsxRemoteCommandBar, handler)
  },
  gsxRemotePickMenu: (index: number) => ipcRenderer.invoke(IpcChannels.gsxRemotePickMenu, index),
  gsxRemoteToggleMenu: () => ipcRenderer.invoke(IpcChannels.gsxRemoteToggleMenu),
  gsxRemoteSubmitPrompt: (gen: number, text: string) => ipcRenderer.invoke(IpcChannels.gsxRemoteSubmitPrompt, gen, text),
  gsxRemoteCancelPrompt: (gen: number) => ipcRenderer.invoke(IpcChannels.gsxRemoteCancelPrompt, gen),
  gsxRemoteRunCommand: (id: GsxRemoteCommandId) => ipcRenderer.invoke(IpcChannels.gsxRemoteRunCommand, id)
}

contextBridge.exposeInMainWorld('winglog', api)
