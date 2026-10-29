import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A fake VATSIM and IVAO feed for the acceptance tests: plain `node:http`, like the update server in updates.spec.ts. It records each
 * request (path, time, headers) and serves a small SYNTHETIC feed (invented callsigns, no real pilot) placed around a point, so no test
 * run ever reaches the real networks (launch-app.ts points both feeds at a closed port unless a test passes this server's addresses).
 */

/** One request the server received. */
export interface FeedRequest {
  path: '/vatsim' | '/ivao'
  atMs: number
  headers: Record<string, string | string[] | undefined>
}

/** Where the invented aircraft are put: the near ones around this point, the far one on the other side of the world. */
export interface FeedScene {
  centre: { lat: number; lon: number }
  /** An invented pilot with this member number and callsign, at the centre: the test pilot's own aircraft. */
  self?: { cid: number; callsign: string }
  /**
   * An airport that has an invented tower and ATIS online. On VATSIM the ATIS is a station of its own (letter C, runway 07R); on IVAO a
   * ground and a tower controller are online, each with their own ATIS (D and H), the first line of each being the voice-server address.
   */
  station?: string
  /** An airport with a separate departure ATIS (letter L, runway 27R) and arrival ATIS (letter M, runway 27L), as VATSIM's busy airports run them. */
  splitStation?: string
}

/**
 * @param scene Where to put the aircraft.
 * @returns A VATSIM-shaped feed with NEAR1 and NEAR2 close to the centre and FAR1 on the other side of the world.
 */
export function vatsimBody(scene: FeedScene): string {
  const now = new Date().toISOString()
  const pilot = (cid: number, callsign: string, lat: number, lon: number, groundspeed: number): object => ({
    cid,
    name: 'Test Pilot',
    callsign,
    latitude: lat,
    longitude: lon,
    altitude: groundspeed > 40 ? 12000 : 80,
    groundspeed,
    heading: 90,
    last_updated: now,
    flight_plan: { aircraft_short: 'A320', departure: 'EGLL', arrival: 'LFPG', remarks: '' }
  })
  return JSON.stringify({
    general: { update_timestamp: now },
    pilots: [
      pilot(1000001, 'NEAR1', scene.centre.lat + 0.3, scene.centre.lon + 0.3, 250),
      pilot(1000002, 'NEAR2', scene.centre.lat - 0.2, scene.centre.lon + 0.1, 0),
      pilot(1000003, 'FAR1', -33.9, 151.2, 450),
      ...(scene.self
        ? [pilot(scene.self.cid, scene.self.callsign, scene.centre.lat, scene.centre.lon, 0)]
        : [])
    ],
    controllers: scene.station
      ? [
          {
            cid: 1000010,
            name: 'Test Controller',
            callsign: `${scene.station}_TWR`,
            frequency: '118.700',
            facility: 4,
            rating: 4,
            server: 'TEST',
            visual_range: 50,
            text_atis: null
          }
        ]
      : [],
    atis: [
      ...(scene.station
        ? [
            {
              cid: 1000011,
              name: 'Test ATIS',
              callsign: `${scene.station}_ATIS`,
              frequency: '127.000',
              facility: 4,
              atis_code: 'C',
              text_atis: ['INVENTED ATIS INFORMATION C', 'RUNWAY 07R IN USE']
            }
          ]
        : []),
      ...(scene.splitStation
        ? [
            {
              cid: 1000012,
              name: 'Test ATIS',
              callsign: `${scene.splitStation}_D_ATIS`,
              frequency: '121.850',
              facility: 4,
              atis_code: 'L',
              text_atis: ['INVENTED DEPARTURE INFORMATION L', 'RUNWAY 27R IN USE']
            },
            {
              cid: 1000013,
              name: 'Test ATIS',
              callsign: `${scene.splitStation}_A_ATIS`,
              frequency: '128.075',
              facility: 4,
              atis_code: 'M',
              text_atis: ['INVENTED ARRIVAL INFORMATION M', 'RUNWAY 27L IN USE']
            }
          ]
        : [])
    ]
  })
}

/**
 * @param callsign The controller's callsign.
 * @param position IVAO's position name.
 * @param frequency The frequency, which IVAO sends as a number.
 * @param letter The ATIS's letter.
 * @param text The ATIS's text.
 * @returns An IVAO-shaped controller carrying its own ATIS, whose first line is the voice-server address.
 */
function ivaoController(
  callsign: string,
  position: string,
  frequency: number,
  letter: string,
  text: string
): object {
  return {
    callsign,
    atcSession: { position, frequency },
    atis: { revision: letter, lines: [`voice.test.ivao/${callsign}`, text] }
  }
}

/**
 * @param scene Where to put the aircraft.
 * @returns An IVAO-shaped feed with the same three aircraft.
 */
export function ivaoBody(scene: FeedScene): string {
  const now = new Date().toISOString()
  const pilot = (id: number, callsign: string, lat: number, lon: number): object => ({
    id,
    userId: 900000 + id,
    callsign,
    lastTrack: {
      latitude: lat,
      longitude: lon,
      altitude: 12000,
      groundSpeed: 250,
      heading: 90,
      onGround: false,
      timestamp: now
    },
    flightPlan: null
  })
  return JSON.stringify({
    updatedAt: now,
    clients: {
      pilots: [
        pilot(1, 'NEAR1', scene.centre.lat + 0.3, scene.centre.lon + 0.3),
        pilot(2, 'FAR1', -33.9, 151.2)
      ],
      atcs: scene.station
        ? [
            ivaoController(`${scene.station}_GND`, 'GND', 121.6, 'D', 'INVENTED IVAO GROUND ATIS D'),
            ivaoController(`${scene.station}_TWR`, 'TWR', 118.4, 'H', 'INVENTED IVAO TOWER ATIS H')
          ]
        : [],
      observers: [],
      followMe: []
    }
  })
}

/** The running fake. */
export interface NetworkFeedServer {
  /** The address of the VATSIM feed (the whole data file, skipping the status page). */
  vatsimUrl: string
  ivaoUrl: string
  requests: FeedRequest[]
  server: Server
  close: () => Promise<void>
}

/**
 * Starts the fake feed server on a free loopback port.
 *
 * @param scene Where the invented aircraft are.
 * @returns The server, its two addresses and the requests it has seen.
 */
export async function startNetworkFeedServer(scene: FeedScene): Promise<NetworkFeedServer> {
  const requests: FeedRequest[] = []
  const server = createServer((req, res) => {
    const path = req.url === '/ivao' ? '/ivao' : '/vatsim'
    requests.push({ path, atMs: Date.now(), headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(path === '/ivao' ? ivaoBody(scene) : vatsimBody(scene))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    vatsimUrl: `http://127.0.0.1:${port}/vatsim`,
    ivaoUrl: `http://127.0.0.1:${port}/ivao`,
    requests,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
