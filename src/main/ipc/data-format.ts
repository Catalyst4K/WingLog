/**
 * The import/export file format a renderer asks for, checked in main: the renderer isn't a security
 * boundary.
 */
import type { DataFormat } from '@shared/ipc'

/**
 * Anything but 'csv' is the default, 'json', rather than an arbitrary string.
 *
 * @param format The renderer's value.
 * @returns 'csv' or 'json'.
 */
export function asDataFormat(format: unknown): DataFormat {
  return format === 'csv' ? 'csv' : 'json'
}
