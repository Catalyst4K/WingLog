/**
 * Settings → 3rd party: the online network (none, VATSIM or IVAO), the pilot's member number on it (winglog-backend's
 * docs/plans/vatsim-build.md, Step 1a), and whether the map offers the sim traffic button. The network is the one switch for every VATSIM
 * and IVAO feature: None shows none of them.
 */

import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OnlineNetwork, OnlineNetworkSettings } from '@shared/ipc'
import { Input } from '@/components/ui/input'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler, runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { OnOffControl, SettingRow, SettingsCard } from './ui/SettingsCard'

type NetworkChoice = OnlineNetwork | 'none'

/** The longest member number kept, digits. */
const MAX_MEMBER_DIGITS = 10

/**
 * @param text What was typed.
 * @returns Only its digits, at most ten of them.
 */
function digitsOnly(text: string): string {
  return text.replace(/\D/g, '').slice(0, MAX_MEMBER_DIGITS)
}

/** What the card takes. */
export interface OnlineNetworkCardProps {
  /** Defaults to the build flag; a prop so both builds can be tested. */
  isDevBuild?: boolean
}

/**
 * The Online network card. The member number is saved when the field loses focus or Enter is pressed, so a half-typed IVAO number
 * does not start reading the feed.
 *
 * @param props Whether this is the dev build, which also offers "Pretend I am this pilot".
 * @returns The element, or nothing until the settings are read.
 */
export function OnlineNetworkCard(props: OnlineNetworkCardProps): React.JSX.Element | null {
  const isDevBuild = props.isDevBuild ?? __WINGLOG_DEV_BUILD__
  const { t } = useTranslation()
  const [settings, setSettings] = useState<OnlineNetworkSettings | null>(null)
  const [memberNumber, setMemberNumber] = useState('')
  const inputId = useId()
  const pretendId = useId()
  const [pretend, setPretend] = useState('')

  useEffect(() => {
    runAsync(
      'OnlineNetworkCard settingsGetOnlineNetwork',
      winglogApi()
        .settingsGetOnlineNetwork()
        .then((loaded) => {
          setSettings(loaded)
          setMemberNumber((loaded.network === 'ivao' ? loaded.ivaoVid : loaded.vatsimCid) ?? '')
        })
    )
  }, [])

  useEffect(() => {
    if (!isDevBuild) return
    runAsync(
      'OnlineNetworkCard onlineGetPretend',
      winglogApi()
        .onlineGetPretend()
        .then((callsign) => setPretend(callsign ?? ''))
    )
  }, [isDevBuild])

  if (!settings) return null
  const network = settings.network

  const save = async (next: OnlineNetworkSettings): Promise<void> => {
    setSettings(next)
    await winglogApi().settingsSetOnlineNetwork(next)
  }

  const choose = (choice: NetworkChoice): void => {
    const chosen = choice === 'none' ? null : choice
    setMemberNumber((chosen === 'ivao' ? settings.ivaoVid : settings.vatsimCid) ?? '')
    runAsync('OnlineNetworkCard settingsSetOnlineNetwork', save({ ...settings, network: chosen }))
  }

  const saveMemberNumber = async (): Promise<void> => {
    if (!network) return
    const value = memberNumber === '' ? null : memberNumber
    const field = network === 'ivao' ? 'ivaoVid' : 'vatsimCid'
    if (settings[field] === value) return
    await save({ ...settings, [field]: value })
  }

  return (
    <SettingsCard
      title={t('settingsView.onlineNetwork.cardTitle')}
      description={t('settingsView.onlineNetwork.description')}
    >
      <SegmentedRow<NetworkChoice>
        label={t('settingsView.onlineNetwork.network')}
        value={network ?? 'none'}
        options={[
          { value: 'none', label: t('settingsView.onlineNetwork.none') },
          { value: 'vatsim', label: 'VATSIM' },
          { value: 'ivao', label: 'IVAO' }
        ]}
        onChange={choose}
      />
      {network && (
        <SettingRow
          label={
            network === 'ivao' ? t('settingsView.onlineNetwork.vid') : t('settingsView.onlineNetwork.cid')
          }
          note={
            network === 'ivao'
              ? t('settingsView.onlineNetwork.vidHint')
              : t('settingsView.onlineNetwork.cidHint')
          }
          controlId={inputId}
        >
          <Input
            id={inputId}
            type="text"
            inputMode="numeric"
            className="w-40"
            value={memberNumber}
            onChange={(e) => setMemberNumber(digitsOnly(e.target.value))}
            onBlur={asyncHandler('OnlineNetworkCard saveMemberNumber', saveMemberNumber)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </SettingRow>
      )}
      {network && (
        <SettingRow
          label={t('settingsView.onlineNetwork.keepBeyondAtc')}
          note={t('settingsView.onlineNetwork.keepBeyondAtcHint')}
        >
          <OnOffControl
            label={t('settingsView.onlineNetwork.keepBeyondAtc')}
            enabled={settings.keepBeyondAtcOnline}
            onText={t('settingsView.beyondAtc.on')}
            offText={t('settingsView.beyondAtc.off')}
            onChange={asyncHandler('OnlineNetworkCard keepBeyondAtc', (keep: boolean) =>
              save({ ...settings, keepBeyondAtcOnline: keep })
            )}
          />
        </SettingRow>
      )}
      {/* Not a network feature: the sim's own traffic is offered whatever the network, unless switched off here. */}
      <SettingRow
        label={t('settingsView.onlineNetwork.simTrafficButton')}
        note={t('settingsView.onlineNetwork.simTrafficButtonHint')}
      >
        <OnOffControl
          label={t('settingsView.onlineNetwork.simTrafficButton')}
          enabled={settings.simTrafficButton}
          onText={t('settingsView.beyondAtc.on')}
          offText={t('settingsView.beyondAtc.off')}
          onChange={asyncHandler('OnlineNetworkCard simTrafficButton', (offered: boolean) =>
            save({ ...settings, simTrafficButton: offered })
          )}
        />
      </SettingRow>
      {isDevBuild && (
        <SettingRow
          label="Pretend I am this pilot (dev build)"
          note="A callsign in the live feed to take as you."
          controlId={pretendId}
        >
          <Input
            id={pretendId}
            type="text"
            className="w-40"
            value={pretend}
            onChange={(e) => setPretend(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12))}
            onBlur={asyncHandler('OnlineNetworkCard onlineSetPretend', () =>
              winglogApi().onlineSetPretend(pretend === '' ? null : pretend)
            )}
          />
        </SettingRow>
      )}
    </SettingsCard>
  )
}
