/**
 * Makes the app's trace worker: the one place that names the worker's file, which electron-vite builds as a file of its own (`?modulePath`).
 * Electron bootstrap, covered by the acceptance tests rather than unit tests.
 */

import { sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { logger } from '../logging/logger'
import workerFile from './trace-worker?modulePath'
import { WorkerTraceRunner } from './worker-trace-runner'

/**
 * @returns A runner, its worker thread already starting.
 */
export function createTraceWorkerRunner(): WorkerTraceRunner {
  // Packaged, the file sits unpacked beside the archive (electron-builder.yml's asarUnpack): a worker is started from a real file.
  const file = workerFile.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  const runner = new WorkerTraceRunner(() => new Worker(file), logger)
  runner.warm()
  return runner
}
