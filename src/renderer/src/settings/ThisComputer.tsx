/**
 * Settings → Devices → This computer: whether the sim runs on this computer (it is the host) or on another (it is a client of that
 * computer's WingLog). Multi-device builds only, and only where this computer could run the sim (winglog-backend's
 * docs/plans/multi-device.md; docs/plans/devices-page.md, step 3).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunMode } from '@shared/ipc'
import { useCapabilities } from '../app/capabilities-context'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { SettingsCard } from './ui/SettingsCard'

/**
 * The section with "The sim runs on". A choice applies the next time WingLog starts.
 *
 * @returns The element, or nothing where there is no choice to make.
 */
export function ThisComputer(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { multiDevice, canHostSim, runMode } = useCapabilities()
  const [chosen, setChosen] = useState<RunMode | null>(null)

  useEffect(() => {
    if (!multiDevice) return
    runAsync('DevicesPage settingsGetRunMode', winglogApi().settingsGetRunMode().then(setChosen))
  }, [multiDevice])

  if (!multiDevice || !canHostSim) return null

  function choose(mode: RunMode): void {
    setChosen(mode)
    runAsync('DevicesPage settingsSetRunMode', winglogApi().settingsSetRunMode(mode))
  }

  return (
    <SettingsCard title={t('settingsView.devices.thisComputer')}>
      <SegmentedRow<RunMode>
        label={t('settingsView.runMode.label')}
        value={chosen ?? runMode}
        options={[
          { value: 'host', label: t('settingsView.runMode.host') },
          { value: 'client', label: t('settingsView.runMode.client') }
        ]}
        onChange={choose}
        note={t('settingsView.runMode.restart')}
      />
    </SettingsCard>
  )
}
