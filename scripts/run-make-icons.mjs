/**
 * Starts `make-icons.ts` in Electron with ELECTRON_RUN_AS_NODE cleared: a shell that ran `npm test` leaves it set, and
 * Electron would then start as plain Node and fail on `import { app } from 'electron'`.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import electronPath from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electronPath, ['scripts/make-icons.ts'], { stdio: 'inherit', env })
process.exit(result.status ?? 1)
