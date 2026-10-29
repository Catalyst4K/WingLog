/**
 * The ATC coverage areas shipped with WingLog (`resources/atc-areas.json`, refreshed by `npm run data:atc-areas`), parsed on first use
 * rather than at launch: a session that never draws the ATC layer shouldn't pay for ~2.5 MB of shapes (as for the airport list).
 * Plan: winglog-backend docs/plans/online-atc-map.md, D1.
 */
import { lazy } from '@shared/lazy'
import atcAreasRaw from '../../../resources/atc-areas.json?raw'
import { parseAreaData, type AreaData } from './atc-areas'

/** @returns The bundled areas, or null when the file cannot be read (the layer then says it is unavailable). */
export const bundledAtcAreas = lazy((): AreaData | null => parseAreaData(atcAreasRaw))
