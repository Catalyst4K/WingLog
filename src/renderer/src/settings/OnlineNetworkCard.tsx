/** Settings → 3rd party: the online network (none, VATSIM or IVAO) and the pilot's member number on it (winglog-backend's docs/plans/vatsim-build.md, Step 1a). */

import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OnlineNetwork, OnlineNetworkSettings } from '@shared/ipc'
import { Input } from '@/components/ui/input'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler, runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { SettingRow, SettingsCard } from './ui/SettingsCard'

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

/**
 * The Online network card. The member number is saved when the field loses focus or Enter is pressed, so a half-typed IVAO number
 * does not start reading the feed.
 *
 * @returns The element, or nothing until the settings are read.
 */
export function OnlineNetworkCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<OnlineNetworkSettings | null>(null)
  const [memberNumber, setMemberNumber] = useState('')
  const inputId = useId()

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

  if (!settings) return null
  const network = settings.network

  async function save(next: OnlineNetworkSettings): Promise<void> {
    setSettings(next)
    await winglogApi().settingsSetOnlineNetwork(next)
  }

  function choose(choice: NetworkChoice): void {
    const chosen = choice === 'none' ? null : choice
    const stored = chosen === 'ivao' ? settings?.ivaoVid : settings?.vatsimCid
    setMemberNumber(stored ?? '')
    runAsync('OnlineNetworkCard settingsSetOnlineNetwork', save({ ...settings!, network: chosen }))
  }

  async function saveMemberNumber(): Promise<void> {
    if (!network) return
    const value = memberNumber === '' ? null : memberNumber
    const field = network === 'ivao' ? 'ivaoVid' : 'vatsimCid'
    if (settings?.[field] === value) return
    await save({ ...settings!, [field]: value })
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
    </SettingsCard>
  )
}
