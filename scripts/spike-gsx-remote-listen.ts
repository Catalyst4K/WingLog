/**
 * Follow-up to scripts/spike-gsx-remote.ts (see that file for full context).
 *
 * That spike confirmed the live channel is a simple JSON-over-WebSocket protocol, but
 * couldn't see real `state` traffic — only the boot-time snapshot's *shape* from reading
 * `store.js`'s source. Before designing a `GsxRemoteService`/IPC schema for a native
 * (Option C) rebuild, this connects for real and logs every message GSX sends, so the
 * design is built against real payloads, not assumptions — same spike-first discipline as
 * the rest of this project.
 *
 * Usage (MSFS + GSX running, GSX Remote Client port known):
 *   npm run spike:gsx-remote-listen -- --port 8744
 * While it runs, open GSX's own menu / call in a ground service so real `state`/`prompts`
 * traffic shows up, not just the idle snapshot. Ctrl+C to stop.
 *
 * Log real payload shapes (or at least key structure, redacting nothing sensitive since
 * this is all local sim state) into flightdeck-backend's docs/gsx-notes.md.
 */

export {} // forces module scope, avoiding a global-scope name clash with the sibling spike script

function parsePortArg(): number {
  const idx = process.argv.indexOf('--port');
  const value = idx === -1 ? NaN : Number(process.argv[idx + 1]);
  if (!Number.isFinite(value)) {
    console.error('Usage: npm run spike:gsx-remote-listen -- --port <port>');
    process.exit(1);
  }
  return value;
}

const port = parsePortArg();
const url = `ws://localhost:${port}/`;
console.log(`Connecting to ${url} ...`);

const ws = new WebSocket(url);

ws.addEventListener('open', () => {
  console.log('OPEN — subscribing to state/prompts/toasts');
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['state', 'prompts', 'toasts'] }));
});

ws.addEventListener('message', (event) => {
  const raw = typeof event.data === 'string' ? event.data : String(event.data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`[unparseable message] ${raw.slice(0, 200)}`);
    return;
  }
  console.log(`\n[${new Date().toISOString()}]`);
  console.log(JSON.stringify(parsed, null, 2).slice(0, 4000));
});

ws.addEventListener('close', (event) => {
  console.log(`CLOSED — code=${event.code} reason=${event.reason}`);
  process.exit(0);
});

ws.addEventListener('error', (event) => {
  console.error('WS error', event);
});

process.on('SIGINT', () => {
  console.log('\nClosing...');
  ws.close();
  setTimeout(() => process.exit(0), 500);
});
