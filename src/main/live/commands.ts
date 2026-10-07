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
