/**
 * Cuts an anonymised, committable fixture out of a dev-build capture
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 1). The logic, and what it
 * replaces, is in src/main/sim/capture-slice.ts.
 *
 *   npm run fixture:from-capture -- <capture.ndjson> <out.ndjson> --scenario <name>
 *     [--from <s>] [--to <s>] [--streams beyondatc,gsx] [--replace FOUND=REPLACEMENT]...
 *     [--notes <text>]
 *
 * Check the BeyondATC transcript lines by eye before committing: a spoken callsign can't be
 * found by text.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { sliceCapture } from '../src/main/sim/capture-slice'
import { formatFlightFixture, parseFlightFixture, type CapturedLineEvent } from '../src/main/sim/flight-fixture'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    streams: { type: 'string' },
    replace: { type: 'string', multiple: true },
    notes: { type: 'string' }
  }
})

const [input, output] = positionals
if (!input || !output || !values.scenario) {
  process.stderr.write('Usage: fixture-from-capture <capture.ndjson> <out.ndjson> --scenario <name> [--from s] [--to s] [--streams beyondatc,gsx] [--replace FOUND=NEW]... [--notes text]\n')
  process.exit(1)
}

const seconds = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value) * 1000)
const streams = values.streams?.split(',').filter((s): s is CapturedLineEvent['type'] => s === 'beyondatc' || s === 'gsx')
const replacements = (values.replace ?? []).map((pair): [string, string] => {
  const sep = pair.indexOf('=')
  return [pair.slice(0, sep), pair.slice(sep + 1)]
})

const slice = sliceCapture(parseFlightFixture(readFileSync(input, 'utf8')), {
  fromMs: seconds(values.from),
  toMs: seconds(values.to),
  streams,
  replacements,
  scenario: values.scenario,
  notes: values.notes ?? `Anonymised slice of a dev-build capture (scripts/fixture-from-capture.ts).`
})
writeFileSync(output, formatFlightFixture(slice))
process.stdout.write(`${slice.events.length} events written to ${output}. Check the transcript lines by eye before committing.\n`)
