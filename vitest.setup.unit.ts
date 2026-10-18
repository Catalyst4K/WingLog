import log from 'electron-log/main'

// The unit suite runs under Electron's own binary, so electron-log would write to the real user's main.log: test input (a fake
// clearance, deliberately broken JSON) landed in the log the taxi simulation reads as Callum's flights. Tests get no log file.
log.transports.file.level = false
