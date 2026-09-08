import log from 'electron-log/main'

/**
 * Crash/error logging (PLAN.md §M7) — a rotating local file so a bug report can include
 * "what actually happened" instead of relying on the user having a terminal open.
 * electron-log's file transport rotates on its own once a file passes maxSize (renamed to
 * main.old.log, a fresh main.log started) — no extra rotation logic needed here. Writes to
 * app.getPath('logs') (Windows: %APPDATA%\WingLog\logs\main.log).
 *
 * Must run before anything else in the main process that could throw, so call this first
 * from index.ts, ahead of app.whenReady().
 */
export function initLogger(): void {
  log.transports.file.level = 'info'
  log.transports.console.level = 'info'
  // Routes uncaught exceptions and unhandled promise rejections in the main process to the
  // same file transport (electron-log's default logFn) — on top of the dialog.showErrorBox
  // path in index.ts's app.whenReady().catch(), which only covers startup failures before a
  // window exists. This covers everything after that.
  log.errorHandler.startCatching()

  // Replaces the global console with electron-log's, so existing console.log/warn/error
  // call sites throughout src/main (e.g. index.ts's legacy-userdata migration notice)
  // start writing to the log file automatically, without hunting them down individually.
  Object.assign(console, log.functions)
}
