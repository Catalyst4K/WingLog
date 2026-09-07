/**
 * M1 throwaway spike (PLAN.md §6, CLAUDE.md M1/M6 rule): connect to a running MSFS,
 * request the initial SimVar set, print at 1 Hz. Confirm real behaviour before any of
 * this becomes SimConnectService in src/main. Delete or leave inert once M1 is folded
 * into the real service — it's not meant to survive as production code.
 *
 * Sim-confirmed against a live MSFS 2024 session on Windows (2026-09-01) — see
 * docs/simconnect-notes.md for the full list of findings/divergences from the plan.
 * One correction already found by cross-checking the MSFS 2024 SDK docs against
 * PLAN.md §6's list: the parking-brake SimVar is `BRAKE PARKING POSITION`, not
 * `PARKING BRAKE POSITION` (word order) — used below. A second, sim-confirmed
 * correction: `SIM RATE` is not a recognized SimVar in MSFS 2024, `SIMULATION RATE`
 * is. Watch the console for `exception` events — those name which request SimConnect
 * rejected, but note the exception's `index` field is NOT the position of the failing
 * SimVar in this array (see docs/simconnect-notes.md) — match by `sendId` order or,
 * more reliably, isolate the suspect var in its own data definition and retest.
 *
 * Usage:
 *   npm run spike:simconnect
 *
 * By default this auto-discovers a local MSFS instance (SimConnect.cfg / registry).
 * To connect to MSFS running on another machine on the network, set:
 *   SIMCONNECT_HOST=192.168.x.x SIMCONNECT_PORT=500 npm run spike:simconnect
 * (that machine's SimConnect.xml needs a configured, reachable TCP address first —
 * see the MSFS SDK docs for SimConnect.xml).
 */
import {
    open,
    Protocol,
    SimConnectConstants,
    SimConnectDataType,
    SimConnectPeriod,
    type RawBuffer,
} from 'node-simconnect';

const APP_NAME = 'WingLog spike';
const DEFINITION_ID = 0;
const REQUEST_ID = 0;

const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface SimVarSpec {
    name: string;
    unit: string | null;
    dataType: SimConnectDataType;
    read: (data: RawBuffer) => number | string | boolean;
}

const asBool = (data: RawBuffer): boolean => data.readInt32() === 1;

// Order here is the order SimConnect will pack the response in — must match the
// addToDataDefinition call order exactly, which is why this is one declarative list
// used for both, rather than two hand-paired sequences of calls.
const SIM_VARS: SimVarSpec[] = [
    { name: 'PLANE LATITUDE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'PLANE LONGITUDE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'INDICATED ALTITUDE', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'PLANE ALT ABOVE GROUND', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'VERTICAL SPEED', unit: 'feet/minute', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'AIRSPEED INDICATED', unit: 'knots', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'AIRSPEED TRUE', unit: 'knots', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'GROUND VELOCITY', unit: 'knots', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'PLANE HEADING DEGREES TRUE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'PLANE PITCH DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'PLANE BANK DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'SIM ON GROUND', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
    { name: 'G FORCE', unit: 'GForce', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'FUEL TOTAL QUANTITY WEIGHT', unit: 'pounds', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'TOTAL WEIGHT', unit: 'pounds', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'AMBIENT WIND VELOCITY', unit: 'knots', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'AMBIENT WIND DIRECTION', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'ENG COMBUSTION:1', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
    { name: 'GEAR HANDLE POSITION', unit: 'Percent Over 100', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'FLAPS HANDLE INDEX', unit: 'number', dataType: SimConnectDataType.INT32, read: (d) => d.readInt32() },
    // NOTE: word order corrected vs PLAN.md's list — confirmed against MSFS 2024 SDK docs.
    { name: 'BRAKE PARKING POSITION', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
    { name: 'ATC ID', unit: null, dataType: SimConnectDataType.STRING32, read: (d) => d.readString32() },
    { name: 'ATC MODEL', unit: null, dataType: SimConnectDataType.STRING32, read: (d) => d.readString32() },
    { name: 'TITLE', unit: null, dataType: SimConnectDataType.STRING128, read: (d) => d.readString128() },
    // NOTE: was 'SIM RATE' — sim-confirmed as NAME_UNRECOGNIZED in MSFS 2024, see
    // docs/simconnect-notes.md. 'SIMULATION RATE' is the correct name.
    { name: 'SIMULATION RATE', unit: 'number', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
    { name: 'IS SLEW ACTIVE', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
];

function connectionOptions(): { remote: { host: string; port: number } } | undefined {
    const host = process.env['SIMCONNECT_HOST'];
    const port = process.env['SIMCONNECT_PORT'];
    if (!host || !port) return undefined;
    return { remote: { host, port: Number(port) } };
}

function connect(reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS): void {
    open(APP_NAME, Protocol.SunRise, connectionOptions())
        .then(({ recvOpen, handle }) => {
            console.log(`Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`);
            let quitting = false;

            for (const [index, spec] of SIM_VARS.entries()) {
                handle.addToDataDefinition(
                    DEFINITION_ID,
                    spec.name,
                    spec.unit,
                    spec.dataType,
                    0,
                    index
                );
            }

            handle.requestDataOnSimObject(
                REQUEST_ID,
                DEFINITION_ID,
                SimConnectConstants.OBJECT_ID_USER,
                SimConnectPeriod.SECOND
            );

            handle.on('simObjectData', (recvSimObjectData) => {
                if (recvSimObjectData.requestID !== REQUEST_ID) return;

                const values: Record<string, number | string | boolean> = {};
                for (const spec of SIM_VARS) {
                    values[spec.name] = spec.read(recvSimObjectData.data);
                }
                console.log(values);
            });

            handle.on('exception', (recvException) => {
                console.error(
                    `SimConnect exception: ${recvException.exceptionName} (index ${recvException.index}, sendId ${recvException.sendId})`
                );
                console.error('-> record this in docs/simconnect-notes.md with which SimVar/unit caused it');
            });

            handle.on('quit', () => {
                console.log('Sim quit. Reconnecting...');
                quitting = true;
                handle.close();
                connect();
            });

            handle.on('close', () => {
                if (quitting) return;
                console.log('Connection closed unexpectedly. Reconnecting...');
                handle.close();
                connect();
            });

            process.on('SIGINT', () => {
                console.log('\nShutting down.');
                handle.close();
                process.exit(0);
            });
        })
        .catch((error: unknown) => {
            // Connection failures often arrive as an AggregateError with an empty
            // top-level .message (e.g. ECONNREFUSED) — .code and the full object are
            // where the actual detail is, so log both rather than just .message.
            const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
            const description = code ?? (error instanceof Error ? error.message : String(error)) ?? 'unknown error';
            console.log(`Connection failed (${description}). Retrying in ${reconnectDelayMs / 1000}s...`);
            console.log(error);
            setTimeout(
                () => connect(Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)),
                reconnectDelayMs
            );
        });
}

connect();
