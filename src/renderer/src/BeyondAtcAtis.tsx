/**
 * The BeyondATC page's ATIS button (winglog-backend docs/plans/beyondatc-atis.md): a pop-up with BeyondATC's ATIS for each airport it has one
 * for, read fresh from BeyondATC each time it is opened. The text is BeyondATC's, drawn as text only.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcAtis, BeyondAtcAtisList } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { winglogApi } from './data/winglog-api'
import { runAsync } from './report-error'

/**
 * @param props One airport's ATIS.
 * @returns Its airport and letter, the runways BeyondATC labels, and the text.
 */
function AirportAtis(props: { atis: BeyondAtcAtis }): React.JSX.Element {
  const { t } = useTranslation()
  const { atis } = props
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
      <div className="font-medium text-foreground">
        {atis.icao}
        {atis.code ? ` · ${t('online.atis.beyondatc', { code: atis.code })}` : ''}
      </div>
      {atis.departureRunways.length > 0 && (
        <div className="font-medium text-foreground">
          {t('online.atis.beyondatcDeparture', { runways: atis.departureRunways.join(', ') })}
        </div>
      )}
      {atis.arrivalRunways.length > 0 && (
        <div className="font-medium text-foreground">
          {t('online.atis.beyondatcArrival', { runways: atis.arrivalRunways.join(', ') })}
        </div>
      )}
      <div className="break-words text-muted-foreground">{atis.text}</div>
    </div>
  )
}

/**
 * @returns A button that opens BeyondATC's ATIS, asking BeyondATC each time it opens.
 */
export function BeyondAtcAtisButton(): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<BeyondAtcAtisList | null>(null)

  const onOpenChange = (open: boolean): void => {
    if (!open) return
    setList(null)
    runAsync('BeyondAtcAtisButton beyondAtcGetAtis', winglogApi().beyondAtcGetAtis().then(setList))
  }

  let body: React.JSX.Element
  if (list === null)
    body = <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.atis.reading')}</p>
  else if (list.state === 'off')
    body = <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.atis.off')}</p>
  else if (list.state === 'unavailable')
    body = <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.atis.unavailable')}</p>
  else if (list.airports.length === 0)
    body = <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.atis.none')}</p>
  else
    body = (
      <div className="flex flex-col gap-2">
        {list.airports.map((atis) => (
          <AirportAtis key={atis.icao} atis={atis} />
        ))}
      </div>
    )

  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t('beyondAtcPanel.atis.button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('beyondAtcPanel.atis.title')}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
