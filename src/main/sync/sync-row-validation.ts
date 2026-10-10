/**
 * Checks a pulled sync row's fields against the table's own columns before anything is written.
 *
 * A pulled row's `data` is JSON that crossed the network, from the account's other device or, if
 * the backend were compromised, from anyone. The `apply*` functions in sync-engine.ts used to
 * check two or three keys and cast the rest straight into the repo's insert. That let a row set
 * `id`, put a string in a number column, or plant any value in a text column
 * (`flight_invoice.source_html_path` is later handed to `shell.openPath`). The table definition
 * in schema.ts already says what every field must be, so this reads it from there rather than
 * keeping a second list that could drift.
 */
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { getTableColumns, getTableName } from 'drizzle-orm'

/** Longest accepted text value, in characters, for a column without its own limit below. */
const DEFAULT_MAX_TEXT_LENGTH = 65536

/** Columns that hold a whole JSON document (an OFP, a route polyline, a receipt). */
const LARGE_TEXT_LIMITS: Record<string, number> = {
  ofpJson: 16 * 1024 * 1024,
  flownRouteJson: 1024 * 1024,
  receiptJson: 1024 * 1024
}

/** Columns the sync engine sets itself, so a pulled row's own value for them is ignored. */
const ENGINE_COLUMNS = ['id', 'uuid', 'updatedAt'] as const

export type ValidatedRow = { ok: true; fields: Record<string, unknown> } | { ok: false; error: string }

/**
 * Checks one field's value against its column.
 *
 * @param key The column's property name.
 * @param column The column's definition.
 * @param column.dataType The Drizzle data type: string, number, boolean or custom.
 * @param column.notNull Whether null is refused.
 * @param column.enumValues The allowed values of an enum text column.
 * @param value The pulled value.
 * @returns The reason it was refused, or null when it is fine.
 */
function fieldProblem(
  key: string,
  column: { dataType: string; notNull: boolean; enumValues?: unknown },
  value: unknown
): string | null {
  if (value === null) return column.notNull ? `${key} must not be null` : null
  switch (column.dataType) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${key} must be a finite number`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${key} must be true or false`
    default: {
      if (typeof value !== 'string') return `${key} must be text`
      const allowed = column.enumValues as readonly string[] | undefined
      if (allowed && !allowed.includes(value)) return `${key} is not one of the allowed values`
      const limit = LARGE_TEXT_LIMITS[key] ?? DEFAULT_MAX_TEXT_LENGTH
      return value.length > limit ? `${key} is too long` : null
    }
  }
}

/**
 * Keeps the fields of a pulled row that belong to the table, refusing the row when one is the
 * wrong kind of value. Keys the table doesn't have are dropped, not refused, so a newer app
 * version's extra field doesn't stop an older one syncing. Integer columns also have to hold
 * whole numbers.
 *
 * @param table The table's Drizzle definition.
 * @param data The pulled row's parsed data.
 * @param own Further column names the engine sets itself (a parent reference it translates).
 * @returns The fields to write, or the reason the row was refused.
 */
export function validateSyncFields(
  table: SQLiteTable,
  data: Record<string, unknown>,
  own: readonly string[] = []
): ValidatedRow {
  const columns = getTableColumns(table)
  const fields: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(columns)) {
    if ((ENGINE_COLUMNS as readonly string[]).includes(key) || own.includes(key)) continue
    if (!Object.hasOwn(data, key)) continue
    const value = data[key]
    const problem =
      fieldProblem(key, column, value) ??
      (column.columnType === 'SQLiteInteger' && typeof value === 'number' && !Number.isSafeInteger(value)
        ? `${key} must be a whole number`
        : null)
    if (problem) return { ok: false, error: `invalid ${getTableName(table)} data: ${problem}` }
    fields[key] = value
  }
  return { ok: true, fields }
}
