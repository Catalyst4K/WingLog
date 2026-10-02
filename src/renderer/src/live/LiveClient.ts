import { createContext, useContext, useEffect, useState } from 'react'
import type { LiveCommand, LiveCommands, LiveTopic, LiveTopics } from '@shared/live'

/**
 * How the remote-capable panels (BeyondATC, GSX Remote) read live state and send commands,
 * instead of calling `window.winglog` directly (flightdeck-backend's
 * docs/plans/live-data-seam.md, part C). Today the only implementation goes through
 * Electron's preload; v1.5's LAN viewer and a v2.x app talking to a sim-PC host will each
 * provide their own, and the panels won't change.
 */
export interface LiveClient {
  /** The topic's current value, for a panel mounting mid-session. Undefined for topics
   *  with no current-value query (the telemetry stream, single track points). */
  get<T extends LiveTopic>(topic: T): Promise<LiveTopics[T] | undefined>
  subscribe<T extends LiveTopic>(topic: T, listener: (payload: LiveTopics[T]) => void): () => void
  command<C extends LiveCommand>(name: C, ...args: LiveCommands[C]): Promise<void>
}

type Getters = { [T in LiveTopic]?: () => Promise<LiveTopics[T]> }
type Subscribers = { [T in LiveTopic]: (listener: (payload: LiveTopics[T]) => void) => () => void }
type Commands = { [C in LiveCommand]: (...args: LiveCommands[C]) => Promise<void> }

/** Over Electron's preload. Looks `window.winglog` up on every call rather than capturing
 *  it once, so renderer tests that swap the mock between tests keep working. */
export const electronLiveClient: LiveClient = {
  get(topic) {
    const w = window.winglog
    const getters: Getters = {
      simConnectionStatus: w.getSimConnectionStatus,
      gsxRemoteStatus: w.gsxRemoteGetStatus,
      gsxRemoteServices: w.gsxRemoteGetServices,
      gsxRemoteGate: w.gsxRemoteGetGateInfo,
      gsxRemoteMenu: w.gsxRemoteGetMenu,
      gsxRemotePrompt: w.gsxRemoteGetPrompt,
      gsxRemoteCommandBar: w.gsxRemoteGetCommandBar,
      beyondAtcStatus: w.beyondAtcGetStatus,
      beyondAtcState: w.beyondAtcGetState,
      beyondAtcTranscript: w.beyondAtcGetTranscript,
      beyondAtcStepClimb: w.beyondAtcGetStepClimb
    }
    const getter = getters[topic]
    return getter ? getter() : Promise.resolve(undefined)
  },
  subscribe(topic, listener) {
    const w = window.winglog
    const subscribers: Subscribers = {
      simTelemetry: w.onSimTelemetry,
      simConnectionStatus: w.onSimConnectionStatus,
      trackingPoint: w.onTrackingPoint,
      trackingPointsUpdated: w.onTrackingPointsUpdated,
      gsxRemoteStatus: w.onGsxRemoteStatus,
      gsxRemoteServices: w.onGsxRemoteServices,
      gsxRemoteGate: w.onGsxRemoteGate,
      gsxRemoteMenu: w.onGsxRemoteMenu,
      gsxRemotePrompt: w.onGsxRemotePrompt,
      gsxRemoteCommandBar: w.onGsxRemoteCommandBar,
      beyondAtcStatus: w.onBeyondAtcStatus,
      beyondAtcState: w.onBeyondAtcState,
      beyondAtcTranscript: w.onBeyondAtcTranscript,
      beyondAtcStepClimb: w.onBeyondAtcStepClimb
    }
    return subscribers[topic](listener)
  },
  command(name, ...args) {
    const w = window.winglog
    const commands: Commands = {
      'atc.setAction': (label) => w.beyondAtcSetAction(label),
      'atc.setFrequency': (frequency) => w.beyondAtcSetFrequency(frequency),
      'atc.setFrequencyCom2': (frequency) => w.beyondAtcSetFrequencyCom2(frequency),
      'atc.setAutoTune': (value) => w.beyondAtcSetAutoTune(value),
      'atc.setAutoRespond': (value) => w.beyondAtcSetAutoRespond(value),
      'atc.setStepClimb': (enabled) => w.beyondAtcSetStepClimb(enabled),
      'gsx.pickMenu': (index) => w.gsxRemotePickMenu(index),
      'gsx.search': (text) => w.gsxRemoteSearch(text),
      'gsx.toggleMenu': () => w.gsxRemoteToggleMenu(),
      'gsx.submitPrompt': (gen, text) => w.gsxRemoteSubmitPrompt(gen, text),
      'gsx.cancelPrompt': (gen) => w.gsxRemoteCancelPrompt(gen),
      'gsx.runCommand': (id) => w.gsxRemoteRunCommand(id)
    }
    return (commands[name] as (...a: LiveCommands[typeof name]) => Promise<void>)(...args)
  }
}

export const LiveClientContext = createContext<LiveClient>(electronLiveClient)

export function useLiveClient(): LiveClient {
  return useContext(LiveClientContext)
}

/** A topic's current value, kept up to date: fetched on mount, then followed live. */
export function useLiveTopic<T extends LiveTopic>(topic: T, initial: LiveTopics[T]): LiveTopics[T] {
  const client = useLiveClient()
  const [value, setValue] = useState<LiveTopics[T]>(initial)
  useEffect(() => {
    let current = true
    // A failed current-value fetch just leaves the initial value until the first push.
    client.get(topic).then(
      (v) => {
        if (current && v !== undefined) setValue(v)
      },
      () => undefined
    )
    const unsubscribe = client.subscribe(topic, setValue)
    return () => {
      current = false
      unsubscribe()
    }
  }, [client, topic])
  return value
}
