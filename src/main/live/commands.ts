/**
 * The commands a remote client may send (coding-standards.md §9, "command"): one table per
 * add-on, and one `dispatchCommand` that checks the name and the argument list before running
 * one. The IPC handlers call it, and so will the v1.5 LAN viewer, so a command from a tablet goes
 * through the same code as one from the window. The values themselves are checked by the
 * service each command reaches (BeyondATC, GSX Remote), which take `unknown`.
 *
 * Commands that only make sense on this machine (settings, file dialogs, the database) are not
 * here: this table is the remote-safe surface, so a security review of it is a review of one file.
 */
import type { LiveCommand } from '@shared/live'
import type { ProcedureSelection } from '@shared/ipc'
import type { BeyondAtcService } from '../beyondatc/BeyondAtcService'
import type { GsxRemoteService } from '../gsx-remote/GsxRemoteService'
import type { StepClimbController } from '../beyondatc/step-climb'

/** One command: its arguments arrive unchecked, as a client sent them. */
type CommandFn = (...args: unknown[]) => void

/** A table of commands, keyed by name. */
export type CommandTable<K extends LiveCommand> = { [C in K]: CommandFn }

/** The BeyondATC commands. */
export type AtcCommand = Extract<LiveCommand, `atc.${string}`>

/** The GSX Remote commands. */
export type GsxCommand = Extract<LiveCommand, `gsx.${string}`>

/** The tracking commands a second screen may send. */
export type TrackCommand = Extract<LiveCommand, `track.${string}`>

/** The traffic-layer commands, from the window or a second screen. */
export type TrafficCommand = Extract<LiveCommand, `traffic.${string}`>

/**
 * The BeyondATC commands.
 *
 * @param session The current BeyondATC session, read on every call because saving the settings
 *   replaces it; undefined while BeyondATC is off, when every command does nothing.
 * @param stepClimb The auto step climb, for its on/off switch.
 * @returns The table.
 */
export function atcCommands(
  session: () =>
    | Pick<
        BeyondAtcService,
        'setAction' | 'setFrequency' | 'setFrequencyCom2' | 'setAutoTune' | 'setAutoRespond'
      >
    | undefined,
  stepClimb: Pick<StepClimbController, 'setEnabled'>
): CommandTable<AtcCommand> {
  return {
    'atc.setAction': (label) => session()?.setAction(label),
    'atc.setFrequency': (frequency) => session()?.setFrequency(frequency),
    'atc.setFrequencyCom2': (frequency) => session()?.setFrequencyCom2(frequency),
    'atc.setAutoTune': (value) => session()?.setAutoTune(value),
    'atc.setAutoRespond': (value) => session()?.setAutoRespond(value),
    'atc.setStepClimb': (enabled) => {
      if (typeof enabled === 'boolean') stepClimb.setEnabled(enabled)
    }
  }
}

/**
 * The GSX Remote commands.
 *
 * @param service The current GSX Remote service, read on every call; undefined while GSX Remote
 *   is off, when every command does nothing.
 * @returns The table.
 */
export function gsxCommands(
  service: () =>
    | Pick<
        GsxRemoteService,
        'pickMenu' | 'search' | 'toggleMenu' | 'submitPrompt' | 'cancelPrompt' | 'runCommand'
      >
    | undefined
): CommandTable<GsxCommand> {
  return {
    'gsx.pickMenu': (index) => service()?.pickMenu(index),
    'gsx.search': (text) => service()?.search(text),
    'gsx.toggleMenu': () => service()?.toggleMenu(),
    'gsx.submitPrompt': (gen, text) => service()?.submitPrompt(gen, text),
    'gsx.cancelPrompt': (gen) => service()?.cancelPrompt(gen),
    'gsx.runCommand': (id) => service()?.runCommand(id)
  }
}

/** The longest procedure or transition name accepted. */
const MAX_PROCEDURE_NAME = 40

/**
 * @param value One field of a procedure selection from a client.
 * @returns The field when it is a short string, or null when it is null or absent.
 * @throws When it is anything else.
 */
function shortNameOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > MAX_PROCEDURE_NAME)
    throw new Error('Invalid procedure selection')
  return value
}

/**
 * @param value A procedure selection from a client.
 * @returns The selection when every field is a short string or null, with nothing else in it.
 * @throws When it is anything else.
 */
export function parseProcedureSelection(value: unknown): ProcedureSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid procedure selection')
  }
  const record: Record<string, unknown> = { ...value }
  return {
    departureRunway: shortNameOrNull(record.departureRunway),
    sidIdent: shortNameOrNull(record.sidIdent),
    sidTransition: shortNameOrNull(record.sidTransition),
    starIdent: shortNameOrNull(record.starIdent),
    starTransition: shortNameOrNull(record.starTransition),
    approachIdent: shortNameOrNull(record.approachIdent),
    approachTransition: shortNameOrNull(record.approachTransition),
    arrivalIcao: shortNameOrNull(record.arrivalIcao)
  }
}

/**
 * The tracking commands a second screen may send: choosing the SID, STAR and approach, which the flight is saved with.
 *
 * @param selection Where a choice is sent: the flight shown's procedure selection.
 * @returns The table.
 */
export function trackCommands(selection: {
  setProcedureSelection(selection: ProcedureSelection): void
}): CommandTable<TrackCommand> {
  return {
    'track.setProcedureSelection': (value) => selection.setProcedureSelection(parseProcedureSelection(value))
  }
}

/**
 * The traffic-layer commands: the one shared switch for the network's traffic on the map.
 *
 * @param feed Where a switch is sent.
 * @returns The table. A value that is not a boolean is refused.
 */
export function trafficCommands(feed: { setNetworkOn(on: boolean): void }): CommandTable<TrafficCommand> {
  return {
    'traffic.setNetworkOn': (on) => {
      if (typeof on !== 'boolean') throw new Error('Invalid traffic switch')
      feed.setNetworkOn(on)
    }
  }
}

/** The most arguments any command takes. */
const MAX_ARGS = 2

/**
 * Runs one command from a client.
 *
 * @param table The commands this client may send.
 * @param name The command's name, as the client sent it.
 * @param args Its arguments, as the client sent them.
 * @throws When the name isn't in the table or the arguments aren't a short list.
 */
export function dispatchCommand(
  table: Partial<Record<LiveCommand, CommandFn>>,
  name: unknown,
  args: unknown
): void {
  if (typeof name !== 'string' || !Object.hasOwn(table, name)) throw new Error('Unknown command')
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new Error('Invalid command arguments')
  const command = table[name as LiveCommand]
  if (!command) throw new Error('Unknown command')
  command(...(args as unknown[]))
}
