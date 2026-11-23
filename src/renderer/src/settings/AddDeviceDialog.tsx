/**
 * Add a device: the one dialog every pairing starts from (winglog-backend's docs/plans/devices-page.md, step 4; the canvas's dev-r1-add).
 * On the sim PC it asks which kind, turns that kind's switch on if it was off (and says so), opens that kind's pairing code and waits for
 * the new device; on a client it connects to a sim PC by address and code. Both end on a success step with Done.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanStatus } from '@shared/ipc'
import type { LightState } from '@/components/StatusLight'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useHostLinkStatus } from '../app/use-host-link'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import {
  ChooseStep,
  ComputerPairing,
  ConnectStep,
  DoneStep,
  PairingProblem,
  PhonePairing,
  StepFooter
} from './AddDeviceSteps'
import { pairingProblemKey } from './lan-problem'
import { useDevicePairing, type OpenPairing } from './use-device-pairing'

/**
 * The dialog's frame: its title, Escape and the corner button closing it, focus kept inside.
 *
 * @param props The title, what closing does, and the step.
 * @returns The element.
 */
function DialogFrame(props: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogContent className="gap-4 p-6 sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="font-display text-[22px] leading-tight font-bold tracking-[-0.02em]">
            {props.title}
          </DialogTitle>
        </DialogHeader>
        {props.children}
      </DialogContent>
    </Dialog>
  )
}

/** Each kind's words on its pairing step: the line when choosing it turned its switch on, and the waiting line. */
const PAIR_WORDS = {
  screen: { turnedOn: 'settingsView.addDevice.phonesOn', waiting: 'settingsView.addDevice.waitingDevice' },
  twin: { turnedOn: 'settingsView.addDevice.computersOn', waiting: 'settingsView.addDevice.waitingComputer' }
} as const

/**
 * The sim PC's pairing step: the code for the kind chosen, or why there is none, and the waiting light.
 *
 * @param props The open pairing, the status, and what Close does.
 * @returns The step.
 */
function PairStep(props: {
  open: OpenPairing
  status: LanStatus | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { open, status } = props
  const isTwin = open.kind === 'twin'
  const words = PAIR_WORDS[open.kind]
  const pairing = status && (isTwin ? status.twinPairing : status.pairing)
  // No code is shown while it could not be used (no home network, or no certificate for a computer).
  const usable = status && !pairingProblemKey(status, open.kind)
  const code = usable && pairing && status.url ? { pairing, url: status.url } : null
  return (
    <>
      {open.turnedOn && <p className="m-0 text-sm">{t(words.turnedOn)}</p>}
      {status && <PairingProblem status={status} kind={open.kind} />}
      {code &&
        (isTwin ? (
          <ComputerPairing address={new URL(code.url).host} pairing={code.pairing} />
        ) : (
          <PhonePairing url={code.url} pairing={code.pairing} />
        ))}
      <StepFooter light={code ? 'amber' : undefined} words={code ? t(words.waiting) : undefined}>
        <Button type="button" variant="outline" onClick={props.onClose}>
          {t('settingsView.addDevice.close')}
        </Button>
      </StepFooter>
    </>
  )
}

/**
 * Add a device on the sim PC: the choice (with multi-device), the pairing step, then the success step.
 *
 * @param props Whether this build pairs computers, and what closing does.
 * @returns The element.
 */
function HostAddDevice(props: { multiDevice: boolean; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [pairedWords, setPairedWords] = useState<string | null>(null)
  const pairing = useDevicePairing((name) => setPairedWords(t('settingsView.addDevice.paired', { name })))
  const { open, status } = pairing
  const choose = (kind: OpenPairing['kind']): void =>
    runAsync('AddDeviceDialog lanStartPairing', pairing.start(kind))

  useEffect(() => {
    // A build with phones only has nothing to choose: the dialog opens on the phone's code.
    if (!props.multiDevice) runAsync('AddDeviceDialog lanStartPairing', pairing.start('screen'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the dialog opens
  }, [])

  function close(): void {
    pairing.stop()
    props.onClose()
  }

  const title = open
    ? t(open.kind === 'twin' ? 'settingsView.addDevice.computerTitle' : 'settingsView.addDevice.phoneTitle')
    : t('settingsView.addDevice.title')
  return (
    <DialogFrame title={title} onClose={close}>
      {pairedWords ? (
        <DoneStep words={pairedWords} onDone={props.onClose} />
      ) : open ? (
        <PairStep open={open} status={status} onClose={close} />
      ) : (
        props.multiDevice && <ChooseStep onChoose={choose} />
      )}
    </DialogFrame>
  )
}

/**
 * @param state A client's link state.
 * @returns Its light while connecting: amber on the way, green connected, red refused.
 */
function linkLight(state: string): LightState {
  if (state === 'connected') return 'green'
  return state === 'connecting' ? 'amber' : 'red'
}

/**
 * Connect to a sim PC, on a client: the address and code, then the success step once the link is up.
 *
 * @param props What closing does.
 * @returns The element.
 */
function ClientAddDevice(props: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const link = useHostLinkStatus(true)
  const [tried, setTried] = useState(false)
  const [failed, setFailed] = useState(false)

  function connect(address: string, code: string): void {
    setFailed(false)
    winglogApi()
      .hostLinkPair(address, code)
      .then(() => setTried(true))
      .catch(() => setFailed(true))
  }

  const state =
    tried && link
      ? { light: linkLight(link.state), words: t(`settingsView.hostLink.states.${link.state}`) }
      : undefined
  return (
    <DialogFrame title={t('settingsView.addDevice.connectTitle')} onClose={props.onClose}>
      {tried && link?.state === 'connected' ? (
        <DoneStep words={t('settingsView.addDevice.connectedToSimPc')} onDone={props.onClose} />
      ) : (
        <ConnectStep onConnect={connect} failed={failed} state={state} />
      )}
    </DialogFrame>
  )
}

/**
 * The dialog. Rendered only while open, so each opening starts at the first step.
 *
 * @param props Whether this computer is a client, whether this build pairs computers, and what closing does.
 * @returns The element.
 */
export function AddDeviceDialog(props: {
  isClient: boolean
  multiDevice: boolean
  onClose: () => void
}): React.JSX.Element {
  return props.isClient ? (
    <ClientAddDevice onClose={props.onClose} />
  ) : (
    <HostAddDevice multiDevice={props.multiDevice} onClose={props.onClose} />
  )
}
