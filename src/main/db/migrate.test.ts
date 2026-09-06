import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb } from './client'
import { migrateDb } from './migrate'

// Regression coverage for the packaged-app bug where migrateDb's cwd-relative default
// silently found no migrations at all once launched outside a terminal with cwd=project
// root — see electron-builder.yml and src/main/index.ts for the fix (an explicit,
// app.getAppPath()-derived migrationsFolder). Both call shapes need to keep working:
// scripts/db-migrate.ts and every other test rely on the cwd-relative default.
describe('migrateDb', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('applies migrations using the cwd-relative default', () => {
    migrateDb(':memory:')
  })

  it('applies migrations using an explicit absolute migrationsFolder, as the packaged app does', () => {
    migrateDb(':memory:', join(process.cwd(), 'drizzle'))
  })

  it('leaves a usable, persisted database behind with the explicit-path call shape', () => {
    // migrateDb closes its own sqlite handle, so open a fresh one against the same file
    // to confirm the schema actually landed rather than just not throwing — a real file,
    // since a fresh :memory: connection would be a distinct, unrelated database.
    tempDir = mkdtempSync(join(tmpdir(), 'winglog-migrate-test-'))
    const dbPath = join(tempDir, 'winglog.db')
    migrateDb(dbPath, join(process.cwd(), 'drizzle'))
    const { sqlite, db } = createDb(dbPath)
    expect(() => db.run(`select 1 from aircraft limit 1`)).not.toThrow()
    sqlite.close()
  })
})
