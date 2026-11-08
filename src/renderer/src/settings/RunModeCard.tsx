/** Settings → Data → Where the sim runs: this PC, or another PC (multi-device builds only; winglog-backend's docs/plans/multi-device.md). */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunMode } from '@shared/ipc'
import { useCapabilities } from '../app/capabilities-context'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { SettingsCard } from './ui/SettingsCard'

/**
 * The run mode card: whether the sim runs on this computer (it is the host) or on another one (it is a client of that computer's
 * WingLog). A choice applies the next time WingLog starts. Not shown in a release build, and a computer that cannot run the sim has no
 * choice to make.
 *
 * @returns The element, or nothing where there is no choice.
 */
export function RunModeCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { multiDevice, canHostSim, runMode } = useCapabilities()
  const [chosen, setChosen] = useState<RunMode | null>(null)

  useEffect(() => {
    if (!multiDevice) return
    runAsync('RunModeCard settingsGetRunMode', winglogApi().settingsGetRunMode().then(setChosen))
  }, [multiDevice])

  if (!multiDevice || !canHostSim) return null

  const shown = chosen ?? runMode
  function choose(mode: RunMode): void {
    setChosen(mode)
    runAsync('RunModeCard settingsSetRunMode', winglogApi().settingsSetRunMode(mode))
  }

  return (
    <SettingsCard title={t('settingsView.runMode.cardTitle')}>
      <SegmentedRow<RunMode>
        label={t('settingsView.runMode.label')}
        value={shown}
        options={[
          { value: 'host', label: t('settingsView.runMode.host') },
          { value: 'client', label: t('settingsView.runMode.client') }
        ]}
        onChange={choose}
        note={shown === runMode ? t('settingsView.runMode.description') : t('settingsView.runMode.restart')}
      />
    </SettingsCard>
  )
}
