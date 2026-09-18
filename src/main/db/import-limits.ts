/** Import files are read whole into memory; anything bigger than this isn't a fleet/logbook
 *  export. Checked with `stat` before reading, since the path comes from a native dialog
 *  but the file's contents are still untrusted. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024
