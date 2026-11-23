/**
 * Add a device: the one dialog every pairing starts from (winglog-backend's docs/plans/devices-page.md, step 4; the canvas's dev-r1-add).
 * On the sim PC it asks which kind, turns that kind's switch on if it was off (and says so), opens that kind's pairing code and waits for
 * the new device; on a client it connects to a sim PC by address and code. Both end on a success step with Done.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanPairing, LanStatus } from '@shared/ipc'
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
 * @param kind The kind being paired.
 * @param status The server's status.
 * @returns The open code and the page's address, or null when there is none or it could not be used (no home network, or no
 *   certificate for a computer).
 */
function codeToShow(
  kind: OpenPairing['kind'],
  status: LanStatus | null
): { pairing: LanPairing; url: string } | null {
  if (!status?.url || pairingProblemKey(status, kind)) return null
  const pairing = kind === 'twin' ? status.twinPairing : status.pairing
  return pairing ? { pairing, url: status.url } : null
}

/** Each kind's title on its pairing step and on the success step after it. */
const PAIR_TITLE = {
  screen: 'settingsView.addDevice.phoneTitle',
  twin: 'settingsView.addDevice.computerTitle'
} as const

/**
 * The sim PC's pairing step: the code for the kind chosen, or why there is none, and the waiting light. A code that closed without a
 * pairing says so, with New code.
 *
 * @param props The open pairing, the status, whether its code closed, and what New code and Close do.
 * @returns The step.
 */
function PairStep(props: {
  open: OpenPairing
  status: LanStatus | null
  closed: boolean
  onNewCode: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { open, status } = props
  const isTwin = open.kind === 'twin'
  const words = PAIR_WORDS[open.kind]
  const code = props.closed ? null : codeToShow(open.kind, status)
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
      {props.closed && <p className="m-0 text-sm">{t('settingsView.addDevice.codeClosed')}</p>}
      <StepFooter light={code ? 'amber' : undefined} words={code ? t(words.waiting) : undefined}>
        <span className="flex gap-2">
          {props.closed && (
            <Button type="button" onClick={props.onNewCode}>
              {t('settingsView.addDevice.newCode')}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={props.onClose}>
            {t('settingsView.addDevice.close')}
          </Button>
        </span>
      </StepFooter>
    </>
  )
}

/**
 * "Use another PC's sim": this PC becomes a client from the next start, and Restart now starts it again.
 *
 * @param props What Close does.
 * @returns The step.
 */
function UseAnotherSimStep(props: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <p className="m-0 text-sm">{t('settingsView.addDevice.restartNeeded')}</p>
      <StepFooter>
        <span className="flex gap-2">
          <Button
            type="button"
            onClick={() =>
              runAsync('AddDeviceDialog appRestartForRunMode', winglogApi().appRestartForRunMode())
            }
          >
            {t('settingsView.addDevice.restartNow')}
          </Button>
          <Button type="button" variant="outline" onClick={props.onClose}>
            {t('settingsView.addDevice.close')}
          </Button>
        </span>
      </StepFooter>
    </>
  )
}

/**
 * Add a device on the sim PC: the choice (with multi-device), the pairing step, then the success step; or, on a Windows PC that could
 * use another PC's sim, the step that switches to it.
 *
 * @param props Whether this build pairs computers, whether this PC may switch to another PC's sim, and what closing does.
 * @returns The element.
 */
function HostAddDevice(props: {
  multiDevice: boolean
  canUseAnotherSim: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [paired, setPaired] = useState<{ words: string; kind: OpenPairing['kind'] } | null>(null)
  const [usingAnother, setUsingAnother] = useState(false)
  const pairing = useDevicePairing((name, kind) =>
    setPaired({ words: t('settingsView.addDevice.paired', { name }), kind })
  )
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

  function useAnotherSim(): void {
    runAsync(
      'AddDeviceDialog settingsUseAnotherPcSim',
      winglogApi()
        .settingsUseAnotherPcSim()
        .then(() => setUsingAnother(true))
    )
  }

  // The success step keeps the title of the step it follows.
  const kind = open?.kind ?? paired?.kind
  const title = usingAnother
    ? t('settingsView.addDevice.useAnother')
    : kind
      ? t(PAIR_TITLE[kind])
      : t('settingsView.addDevice.title')
  return (
    <DialogFrame title={title} onClose={close}>
      {usingAnother ? (
        <UseAnotherSimStep onClose={props.onClose} />
      ) : paired ? (
        <DoneStep words={paired.words} onDone={props.onClose} />
      ) : open ? (
        <PairStep
          open={open}
          status={status}
          closed={pairing.closed}
          onNewCode={() => choose(open.kind)}
          onClose={close}
        />
      ) : (
        props.multiDevice && (
          <ChooseStep
            onChoose={choose}
            onUseAnotherSim={props.canUseAnotherSim ? useAnotherSim : undefined}
          />
        )
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
 * @param props Whether this computer is a client, whether this build pairs computers, whether this sim PC may switch to another PC's
 *   sim, and what closing does.
 * @returns The element.
 */
export function AddDeviceDialog(props: {
  isClient: boolean
  multiDevice: boolean
  canUseAnotherSim: boolean
  onClose: () => void
}): React.JSX.Element {
  return props.isClient ? (
    <ClientAddDevice onClose={props.onClose} />
  ) : (
    <HostAddDevice
      multiDevice={props.multiDevice}
      canUseAnotherSim={props.canUseAnotherSim}
      onClose={props.onClose}
    />
  )
}
