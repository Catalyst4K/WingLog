/** The second-screen page: pair with the PC once, then the live map of the flight being tracked. */

import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveTopic, LiveTopics } from '@shared/live'
import type { SimTelemetry } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FlightMap } from '@/FlightMap'
import { parseTransitionAltitudes, parseWaypointsFromOfpJson } from '@/route'
import type { LanConnection, LanLinkState } from './lan-connection'

/**
 * @param link The link to the PC.
 * @returns Its state, kept current.
 */
function useLinkState(link: LanConnection): LanLinkState {
  return useSyncExternalStore(
    (notify) => link.onState(() => notify()),
    () => link.state
  )
}

/**
 * @param link The link to the PC.
 * @param topic A live topic.
 * @returns The topic's latest value, or undefined until the PC has sent one.
 */
function useTopic<T extends LiveTopic>(link: LanConnection, topic: T): LiveTopics[T] | undefined {
  return useSyncExternalStore(
    (notify) => link.subscribe(topic, () => notify()),
    () => link.latest(topic)
  )
}

/**
 * @param props The link to the PC.
 * @returns The element.
 */
export function LanApp({ link }: { link: LanConnection }): React.JSX.Element {
  const state = useLinkState(link)
  if (state === 'needs-pairing' || state === 'wrong-code') {
    return <PairingScreen wrong={state === 'wrong-code'} onPair={(code) => link.pair(code)} />
  }
  if (state === 'starting') return <Centered>{<Connecting />}</Centered>
  return <FlightScreen link={link} offline={state === 'offline'} />
}

function Connecting(): React.JSX.Element {
  const { t } = useTranslation()
  return <p className="text-muted-foreground">{t('lanPage.connecting')}</p>
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-dvh flex-col items-center justify-center gap-4 p-4">{children}</div>
}

/**
 * @param props Whether the last code was wrong, and what to do with a typed one.
 * @returns The element.
 */
function PairingScreen({
  wrong,
  onPair
}: {
  wrong: boolean
  onPair: (code: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  return (
    <Centered>
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim() !== '') onPair(code)
        }}
      >
        <h1 className="font-heading text-2xl font-semibold">{t('lanPage.pairTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('lanPage.pairHelp')}</p>
        <label className="flex flex-col gap-1.5 text-sm">
          {t('lanPage.codeLabel')}
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="h-12 text-center font-mono text-2xl tracking-widest"
          />
        </label>
        {wrong && (
          <p role="alert" className="text-sm text-destructive">
            {t('lanPage.wrongCode')}
          </p>
        )}
        <Button type="submit" size="lg" className="h-12" disabled={code.length < 6}>
          {t('lanPage.pair')}
        </Button>
      </form>
    </Centered>
  )
}

/**
 * @param props The link, and whether it has dropped.
 * @returns The element.
 */
function FlightScreen({ link, offline }: { link: LanConnection; offline: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const snapshot = useSyncExternalStore(
    (notify) => link.onFlight(() => notify()),
    () => link.flight
  )
  const trackPoints = useSyncExternalStore(
    (notify) => link.onTrack(notify),
    () => link.track
  )
  const telemetry = useTopic(link, 'simTelemetry') as SimTelemetry | undefined
  const ofpJson = snapshot?.flight.ofpJson ?? null
  const waypoints = useMemo(() => parseWaypointsFromOfpJson(ofpJson), [ofpJson])
  const route = useMemo<[number, number][]>(() => waypoints.map((w) => [w.lon, w.lat]), [waypoints])
  const transition = useMemo(() => parseTransitionAltitudes(ofpJson), [ofpJson])
  const phase = trackPoints.at(-1)?.phase

  return (
    <div className="flex h-dvh flex-col">
      {offline && (
        <p role="status" className="bg-destructive px-4 py-2 text-center text-sm text-white">
          {t('lanPage.offline')}
        </p>
      )}
      {!snapshot && !offline && (
        <p role="status" className="bg-muted px-4 py-2 text-center text-sm text-muted-foreground">
          {t('lanPage.noFlight')}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <FlightMap
          live
          route={route}
          waypoints={waypoints}
          trackPoints={trackPoints}
          telemetry={snapshot ? (telemetry ?? null) : null}
          telemetryPhase={phase}
          telemetryTransition={transition}
          depIcao={null}
          arrIcao={null}
        />
      </div>
    </div>
  )
}
