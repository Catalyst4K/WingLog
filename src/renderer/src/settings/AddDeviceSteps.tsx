/**
 * The steps of Add a device (winglog-backend's docs/plans/devices-page.md, step 4; the canvas's dev-r1-add): what to add, a phone's QR
 * and code, another computer's address and code, a client's Connect to a sim PC, and the success step. Each step only shows what it is
 * given; AddDeviceDialog owns the pairing.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanDeviceKind, LanPairing, LanStatus } from '@shared/ipc'
import { StatusLight, type LightState } from '@/components/StatusLight'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { pairingProblemKey } from './lan-problem'
import { QrCode } from './QrCode'

/** The quiet line under a step's heading, and the label over a figure. */
const QUIET = 'm-0 text-[13px] text-muted-foreground'

/**
 * The line at the foot of a step: a light and a few words on the left, the step's button on the right.
 *
 * @param props The light, the words, and the button.
 * @returns The element.
 */
export function StepFooter(props: {
  light?: LightState
  words?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <span className="inline-flex items-center gap-2 text-sm">
        {props.light && <StatusLight state={props.light} />}
        {props.words}
      </span>
      {props.children}
    </div>
  )
}

/**
 * One of the two large choices on the first step.
 *
 * @param props The icon, the name and its one-line hint, and what choosing it does.
 * @returns The button.
 */
function KindChoice(props: {
  icon: React.ReactNode
  name: string
  hint: string
  onChoose: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onChoose}
      className="flex min-h-22 cursor-pointer items-center gap-4 rounded-lg border border-input bg-background px-4.5 py-3.5 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {props.icon}
      <span className="flex flex-col">
        <span className="font-display font-semibold tracking-[-0.01em]">{props.name}</span>
        <span className="text-[13px] text-muted-foreground">{props.hint}</span>
      </span>
    </button>
  )
}

/**
 * The sim PC's first step: a phone or tablet, or another computer.
 *
 * @param props What choosing a kind does.
 * @returns The step.
 */
export function ChooseStep(props: { onChoose: (kind: LanDeviceKind) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }
  return (
    <>
      <p className="m-0 text-sm text-muted-foreground">{t('settingsView.addDevice.question')}</p>
      <div className="flex flex-col gap-3">
        <KindChoice
          icon={
            <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
              <rect x="8" y="2" width="12" height="24" rx="2.5" {...stroke} />
              <path d="M12 22 H16" {...stroke} />
            </svg>
          }
          name={t('settingsView.addDevice.phone')}
          hint={t('settingsView.addDevice.phoneHint')}
          onChoose={() => props.onChoose('screen')}
        />
        <KindChoice
          icon={
            <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
              <rect x="3" y="5" width="22" height="14" rx="1.5" {...stroke} />
              <path d="M1 23 H27" {...stroke} />
            </svg>
          }
          name={t('settingsView.addDevice.computer')}
          hint={t('settingsView.addDevice.computerHint')}
          onChoose={() => props.onChoose('twin')}
        />
      </div>
      <p className={`${QUIET} border-t border-border pt-3`}>{t('settingsView.addDevice.homeOnly')}</p>
    </>
  )
}

/**
 * Why no code can be shown, when none can: the server's own problem, no home network, or (for computers) no certificate.
 *
 * @param props The status, and the kind being paired.
 * @returns The line, or nothing when a code can be shown.
 */
export function PairingProblem(props: { status: LanStatus; kind: LanDeviceKind }): React.JSX.Element | null {
  const { t } = useTranslation()
  const key = pairingProblemKey(props.status, props.kind)
  return key ? (
    <p role="alert" className="m-0 text-sm text-destructive">
      {t(key)}
    </p>
  ) : null
}

/**
 * The code, large, in Fira Mono.
 *
 * @param props The pairing.
 * @returns The element.
 */
function PairingCode(props: { pairing: LanPairing }): React.JSX.Element {
  return (
    <span
      className="font-mono text-[34px] leading-tight font-medium tracking-[0.06em]"
      aria-label={props.pairing.code}
    >
      {props.pairing.code}
    </span>
  )
}

/**
 * The phone step: the QR code that opens the page with the code, the address, and the code to type.
 *
 * @param props The page's address and the open pairing.
 * @returns The step's body.
 */
export function PhonePairing(props: { url: string; pairing: LanPairing }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="shrink-0 rounded-md border border-border bg-white p-2">
        <QrCode
          text={`${props.url}#code=${props.pairing.code}`}
          label={t('lan.settings.qrLabel')}
          size={152}
        />
      </div>
      <div className="flex min-w-0 flex-1 basis-44 flex-col">
        <p className={QUIET}>{t('settingsView.addDevice.scanOrOpen')}</p>
        <span className="mt-1 font-mono text-[15px] break-all">{props.url}</span>
        <p className={`${QUIET} mt-4.5`}>{t('settingsView.addDevice.typeCode')}</p>
        <PairingCode pairing={props.pairing} />
        <p className={QUIET}>{t('settingsView.addDevice.once')}</p>
      </div>
    </div>
  )
}

/**
 * The computer step: what to do on the other computer, then the address and the code it types.
 *
 * @param props The address (`host:port`) and the open pairing.
 * @returns The step's body.
 */
export function ComputerPairing(props: { address: string; pairing: LanPairing }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col">
      <ol className="m-0 flex flex-col gap-1.5 pl-5 text-sm">
        <li>{t('settingsView.addDevice.computerStep1')}</li>
        <li>{t('settingsView.addDevice.computerStep2')}</li>
      </ol>
      <p className={`${QUIET} mt-4`}>{t('settingsView.devices.address')}</p>
      <span className="mt-0.5 font-mono text-[22px]">{props.address}</span>
      <p className={`${QUIET} mt-3.5`}>{t('settingsView.addDevice.pairingCode')}</p>
      <PairingCode pairing={props.pairing} />
      <p className={QUIET}>{t('settingsView.addDevice.once')}</p>
    </div>
  )
}

/**
 * A client's step: the sim PC's address and pairing code, and Connect.
 *
 * @param props What Connect does with the address and code, whether the last try failed, and the link's state in words and light
 *   once a try has been made.
 * @returns The step.
 */
export function ConnectStep(props: {
  onConnect: (address: string, code: string) => void
  failed: boolean
  state?: { light: LightState; words: string }
}): React.JSX.Element {
  const { t } = useTranslation()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const addressId = useId()
  const codeId = useId()
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        props.onConnect(address.trim(), code.trim())
      }}
    >
      <p className="m-0 text-sm text-muted-foreground">{t('settingsView.addDevice.connectHint')}</p>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-[2_1_180px] flex-col gap-1">
          <Label htmlFor={addressId}>{t('settingsView.devices.address')}</Label>
          <Input
            id={addressId}
            value={address}
            placeholder="192.168.1.20:5051"
            inputMode="url"
            onChange={(event) => setAddress(event.target.value)}
            className="font-mono"
          />
        </div>
        <div className="flex flex-[1_1_110px] flex-col gap-1">
          <Label htmlFor={codeId}>{t('settingsView.addDevice.pairingCode')}</Label>
          <Input
            id={codeId}
            value={code}
            placeholder="123456"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setCode(event.target.value)}
            className="font-mono"
          />
        </div>
      </div>
      {props.failed && (
        <p className="m-0 text-sm text-destructive">{t('settingsView.hostLink.badAddress')}</p>
      )}
      <StepFooter light={props.state?.light} words={props.state?.words}>
        <Button type="submit" disabled={address.trim() === '' || code.trim() === ''}>
          {t('settingsView.addDevice.connect')}
        </Button>
      </StepFooter>
    </form>
  )
}

/**
 * The success step: a green light, what was paired, and Done.
 *
 * @param props The words ("MacBook Air is paired", or "Connected to the sim PC") and what Done does.
 * @returns The step.
 */
export function DoneStep(props: { words: string; onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <StepFooter light="green" words={props.words}>
      <Button type="button" onClick={props.onDone}>
        {t('settingsView.addDevice.done')}
      </Button>
    </StepFooter>
  )
}
