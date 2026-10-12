/**
 * Where GSX writes its receipts on this PC, to pre-fill Settings (the logic and its reasoning are in platform/paths.ts).
 */
import { gsxReceiptsDefaultPath } from '../platform/paths'
import { currentPlatform } from '../platform/platform'

/**
 * @returns The folder, or null off Windows or without `%APPDATA%`.
 */
export function defaultGsxReceiptsPath(): string | null {
  return gsxReceiptsDefaultPath(currentPlatform(), process.env)
}
