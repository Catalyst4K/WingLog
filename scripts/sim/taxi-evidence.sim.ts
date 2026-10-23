/**
 * `npm run sim -- taxi-evidence`: for winglog-backend's docs/plans/taxi-routing-rules.md, step 2. Matches every recorded taxi
 * onto the taxi network as it was flown (taxi-evidence.ts) and reads off the taxiway names actually driven, then compares them
 * with the clearance: followed (every cleared name driven, in order), partly, or not. Writes release/sim/taxi/evidence.json
 * (gitignored).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { boxTaxiClearance } from '../../src/renderer/src/taxi-clearance'
import { openUserDb } from './local-data'
import { simOutputDir } from './report'
import { loadFlownNetwork, loadTaxiScenarios, verdictOf } from './taxi-evidence'

it('matches every recorded taxi to the network as flown', () => {
  const { db, close } = openUserDb()
  try {
    const results = loadTaxiScenarios(db).map((sc) => {
      const clearance = boxTaxiClearance(sc.boxes)
      const cleared = clearance?.taxiways ?? []
      const { verdict, driven } = verdictOf(sc, loadFlownNetwork(sc.icao))
      const names = driven.map((d) => d.name)
      return {
        id: sc.id,
        icao: sc.icao,
        cleared,
        end: clearance?.holdingPoint ?? clearance?.stand ?? clearance?.holdShortRunway ?? null,
        driven: driven.map((d) => `${d.name} ${Math.round(d.m)}m`),
        verdict,
        notCleared: [...new Set(names.filter((n) => !cleared.includes(n)))]
      }
    })
    writeFileSync(join(simOutputDir('taxi'), 'evidence.json'), JSON.stringify(results, null, 2))
    for (const r of results)
      process.stdout.write(
        `EVIDENCE ${r.id.padEnd(10)} ${r.icao} ${r.verdict.padEnd(9)} cleared [${r.cleared.join(', ')}] -> driven ${r.driven.join(' > ')}\n`
      )
  } finally {
    close()
  }
})
