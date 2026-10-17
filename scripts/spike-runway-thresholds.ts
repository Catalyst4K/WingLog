/**
 * Live probe: does MSFS's RUNWAY facility record carry a displaced threshold? Tries each candidate sub-record (PRIMARY_THRESHOLD,
 * SECONDARY_THRESHOLD, blast pads, overruns) one definition at a time on a connection of its own and prints what the sim accepts and
 * returns, for ENBR (the sim's runway is the whole strip, OurAirports lists a 270 m displaced threshold) and WSSS (the sim's 20R leaves
 * the displaced part out). Needs MSFS running with an aircraft loaded. Read-only; touches no database.
 *
 * Usage: npm run spike:runway-thresholds
 */
import {
  FacilityDataType,
  Protocol,
  type RawBuffer,
  type RecvFacilityData,
  type SimConnectConnection
} from 'node-simconnect'
import { openSimConnect } from '../src/main/sim/open-simconnect'

const AIRPORTS = ['ENBR', 'WSSS']
const WAIT_MS = 6_000
/** Candidate sub-records of RUNWAY and the fields tried inside each. */
const SUB_RECORDS = [
  'PRIMARY_THRESHOLD',
  'SECONDARY_THRESHOLD',
  'PRIMARY_BLASTPAD',
  'SECONDARY_BLASTPAD',
  'PRIMARY_OVERRUN',
  'SECONDARY_OVERRUN'
]
const SUB_FIELDS = ['LENGTH', 'WIDTH']

interface Outcome {
  accepted: boolean
  text: string
}

function tryDefinition(
  handle: SimConnectConnection,
  defId: number,
  icao: string,
  sub: string
): Promise<Outcome> {
  return new Promise((resolve) => {
    let exception: string | null = null
    const values: number[] = []
    const records: string[] = []
    const done = (): void => {
      clearTimeout(timer)
      handle.removeListener('facilityData', onData)
      handle.removeListener('facilityDataEnd', onEnd)
      handle.removeListener('exception', onException)
      resolve(
        exception
          ? { accepted: false, text: `refused: ${exception}` }
          : {
              accepted: true,
              text: [`${records.length} records`, ...records].join(String.fromCharCode(10) + '    ')
            }
      )
    }
    const onData = (recv: RecvFacilityData): void => {
      if (recv.userRequestId !== defId) return
      // Each nested record arrives as a message of its own, typed by its record. Print the type and the floats it holds.
      const d: RawBuffer = recv.data
      const floats: number[] = []
      try {
        for (let i = 0; i < 12; i++) floats.push(d.readFloat32())
      } catch {
        // end of the record
      }
      values.push(recv.type)
      records.push(
        `type ${FacilityDataType[recv.type] ?? recv.type} item ${recv.itemIndex}/${recv.listSize}: ${floats.map((f) => (Number.isFinite(f) ? f.toFixed(2) : String(f))).join(' ')}`
      )
    }
    const onEnd = (recv: { userRequestId: number }): void => {
      if (recv.userRequestId === defId) done()
    }
    const onException = (e: { exception: number }): void => {
      exception = `exception ${e.exception}`
      done()
    }
    const timer = setTimeout(done, WAIT_MS)
    handle.on('facilityData', onData)
    handle.on('facilityDataEnd', onEnd)
    handle.on('exception', onException)
    for (const name of [
      'OPEN AIRPORT',
      'ICAO',
      'OPEN RUNWAY',
      'LATITUDE',
      'LONGITUDE',
      'HEADING',
      'LENGTH',
      'WIDTH'
    ]) {
      handle.addToFacilityDefinition(defId, name)
    }
    handle.addToFacilityDefinition(defId, `OPEN ${sub}`)
    for (const field of SUB_FIELDS) handle.addToFacilityDefinition(defId, field)
    handle.addToFacilityDefinition(defId, `CLOSE ${sub}`)
    for (const name of ['CLOSE RUNWAY', 'CLOSE AIRPORT']) handle.addToFacilityDefinition(defId, name)
    handle.requestFacilityData(defId, defId, icao)
  })
}

async function main(): Promise<void> {
  const { handle } = await openSimConnect('WingLog runway threshold probe', Protocol.SunRise)
  try {
    let defId = 9100
    for (const icao of AIRPORTS) {
      for (const sub of SUB_RECORDS) {
        const outcome = await tryDefinition(handle, defId++, icao, sub)
        console.log(`${icao} ${sub.padEnd(20)} ${outcome.accepted ? 'accepted' : 'REFUSED '} ${outcome.text}`)
      }
    }
  } finally {
    handle.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
