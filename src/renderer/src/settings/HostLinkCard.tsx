/** Settings → Data → Sim PC: pair this computer with WingLog on the PC the sim runs on (winglog-backend's docs/plans/multi-device.md, Part 2). */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parsePairingText } from '@shared/host-address'
import { useHostLinkStatus } from '../app/use-host-link'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { SettingRow, SettingsCard, StatusBadge } from './ui/SettingsCard'

/** How a link state shows in the card's badge. */
const BADGE = {
  connected: 'connected',
  connecting: 'connecting',
  offline: 'error',
  'wrong-code': 'error',
  unpaired: 'disconnected'
} as const

/**
 * The Sim PC card, shown on a client: the link's state, the address and code to pair with, and forgetting the sim PC.
 *
 * @returns The element.
 */
export function HostLinkCard(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useHostLinkStatus(true)
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState(false)
  const addressId = useId()
  const codeId = useId()

  const state = status?.state ?? 'unpaired'
  const paired = state !== 'unpaired' && status?.address

  /**
   * Takes what was typed or pasted. The host's pairing text carries its address and the code, so one paste fills both fields.
   *
   * @param value The field's new text.
   */
  function enterAddress(value: string): void {
    const parsed = parsePairingText(value)
    if (parsed?.code) {
      setAddress(parsed.address)
      setCode(parsed.code)
    } else {
      setAddress(value)
    }
  }

  function connect(): void {
    setProblem(false)
    winglogApi()
      .hostLinkPair(address, code.trim())
      .then(() => setCode(''))
      .catch(() => setProblem(true))
  }

  return (
    <SettingsCard
      title={t('settingsView.hostLink.cardTitle')}
      description={t('settingsView.hostLink.description')}
      status={<StatusBadge state={BADGE[state]} label={t(`settingsView.hostLink.states.${state}`)} />}
    >
      {paired ? (
        <SettingRow label={t('settingsView.hostLink.pairedWith', { address: status.address })}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => runAsync('HostLinkCard hostLinkForget', winglogApi().hostLinkForget())}
          >
            {t('settingsView.hostLink.forget')}
          </Button>
        </SettingRow>
      ) : null}
      {!paired || state === 'wrong-code' ? (
        <>
          <SettingRow label={t('settingsView.hostLink.addressLabel')} controlId={addressId}>
            <Input
              id={addressId}
              value={address}
              placeholder="192.168.1.20:5051"
              inputMode="url"
              onChange={(event) => enterAddress(event.target.value)}
              className="w-56 font-mono"
            />
          </SettingRow>
          <SettingRow label={t('settingsView.hostLink.codeLabel')} controlId={codeId}>
            <Input
              id={codeId}
              value={code}
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
              className="w-28 font-mono"
            />
            <Button
              type="button"
              size="sm"
              disabled={address.trim() === '' || code.trim() === ''}
              onClick={connect}
            >
              {t('settingsView.hostLink.connect')}
            </Button>
          </SettingRow>
          {problem && <p className="text-xs text-destructive">{t('settingsView.hostLink.badAddress')}</p>}
        </>
      ) : null}
    </SettingsCard>
  )
}
