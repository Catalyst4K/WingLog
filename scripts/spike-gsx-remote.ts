/**
 * Throwaway spike for flightdeck-backend docs/plans/gsx-remote-control.md's Phase 0.
 *
 * Questions this answers, against a real running GSX Pro install:
 *   1. What's the Remote Control page's real port? 8090 is the port commonly cited in
 *      flight-sim community discussion, but that number is NOT verified anywhere in
 *      either repo — this script checks it live rather than designing against folklore.
 *   2. Is the page safely iframe-embeddable? Checks the response for X-Frame-Options and
 *      Content-Security-Policy: frame-ancestors, either of which could block framing.
 *   3. What does the page actually look like — a single static document, or one that
 *      pulls in its own JS/CSS assets and/or opens a websocket? This matters for whether
 *      Option B (a main-process proxy) is even feasible, since a proxy that only relays
 *      the top-level HTML won't survive contact with asset loading it doesn't also relay.
 *
 * Usage (MSFS + GSX Pro running, ideally mid-flight so GSX has spun up its services):
 *   npm run spike:gsx-remote
 *   npm run spike:gsx-remote -- --port 8091   (to try a different port)
 *
 * Log findings in flightdeck-backend's docs/gsx-notes.md (recreate it — see the plan
 * doc's "Confirmed" section, it's cited elsewhere but doesn't currently exist) before any
 * production code depends on the answers.
 */

const DEFAULT_CANDIDATE_PORTS = [8090, 8091, 8092];

function parsePortArg(): number | null {
  const idx = process.argv.indexOf('--port');
  if (idx === -1) return null;
  const value = Number(process.argv[idx + 1]);
  return Number.isFinite(value) ? value : null;
}

async function probePort(port: number): Promise<void> {
  const url = `http://localhost:${port}/`;
  console.log(`\n--- Probing ${url} ---`);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    console.log(`  unreachable: ${(err as Error).message}`);
    return;
  }

  console.log(`  status: ${response.status} ${response.statusText}`);
  console.log('  headers:');
  for (const [key, value] of response.headers.entries()) {
    console.log(`    ${key}: ${value}`);
  }

  const xfo = response.headers.get('x-frame-options');
  const csp = response.headers.get('content-security-policy');
  const frameAncestors = csp?.includes('frame-ancestors');
  console.log(
    `  embeddability: ${
      xfo || frameAncestors
        ? `BLOCKED — X-Frame-Options=${xfo ?? 'none'}, CSP frame-ancestors=${frameAncestors ?? false}`
        : 'no blocking header seen (still confirm by actually embedding, this is necessary but not sufficient)'
    }`,
  );

  const body = await response.text();
  console.log(`  body length: ${body.length} bytes`);
  console.log(`  looks like: ${body.trim().startsWith('<') ? 'HTML' : 'non-HTML (JSON? plain text?)'}`);

  const scriptSrcs = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const linkHrefs = [...body.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const hasWebSocket = /new\s+WebSocket\s*\(/.test(body) || /wss?:\/\//.test(body);
  console.log(`  external <script src>: ${scriptSrcs.length ? scriptSrcs.join(', ') : 'none found'}`);
  console.log(`  external <link href>: ${linkHrefs.length ? linkHrefs.join(', ') : 'none found'}`);
  console.log(`  references a websocket: ${hasWebSocket}`);
  console.log(`  first 500 chars of body:\n${body.slice(0, 500)}`);
}

export {} // forces module scope, avoiding a global-scope name clash with the sibling spike script

async function main() {
  const explicitPort = parsePortArg();
  const ports = explicitPort !== null ? [explicitPort] : DEFAULT_CANDIDATE_PORTS;

  console.log('GSX Remote Control spike — confirm MSFS + GSX Pro are running first.');
  console.log(`Trying port(s): ${ports.join(', ')}`);

  for (const port of ports) {
    await probePort(port);
  }
}

main();
