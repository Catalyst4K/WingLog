/** Settings → Cloud sync: "Forgot password?" under the log-in form: asks for a code by email, then takes the code and a new password. */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { asyncHandler } from '../report-error'
import { SettingRow } from './ui/SettingsCard'
import type { CloudSyncState } from './use-settings-state'

/** The code is typed from an email: 8 letters and digits, with room for the spaces or dash a person might add. */
const MAX_CODE_CHARS = 32

/**
 * The two steps of a password reset, opened from a link under the log-in form.
 *
 * @param props The cloud sync's state and actions.
 * @returns The element.
 */
export function ForgotPassword(props: { sync: CloudSyncState }): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState<'closed' | 'email' | 'code'>('closed')
  const [email, setEmail] = useState(props.sync.email)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const emailId = useId()
  const codeId = useId()
  const passwordId = useId()

  if (step === 'closed') {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="self-start px-0"
        onClick={() => {
          setEmail(props.sync.email)
          setStep('email')
        }}
      >
        {t('settingsView.cloudSync.forgotPassword')}
      </Button>
    )
  }

  async function ask(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    const asked = await props.sync.forgotPassword(email.trim())
    setBusy(false)
    if (asked) setStep('code')
  }

  async function finish(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    const changed = await props.sync.resetPassword(email.trim(), code, password)
    setBusy(false)
    if (!changed) return
    // The new password is typed once more to log in: the form above has the address ready.
    props.sync.setEmail(email.trim())
    setCode('')
    setPassword('')
    setStep('closed')
  }

  return (
    <form
      onSubmit={asyncHandler('SettingsView handleForgotPassword', step === 'email' ? ask : finish)}
      className="flex flex-col gap-3"
    >
      {step === 'email' ? (
        <SettingRow label={t('settingsView.cloudSync.email')} controlId={emailId}>
          <Input
            id={emailId}
            className="w-64"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </SettingRow>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {t('settingsView.cloudSync.forgotSent')}
          </p>
          <SettingRow label={t('settingsView.cloudSync.resetCode')} controlId={codeId}>
            <Input
              id={codeId}
              className="w-64 font-mono"
              autoComplete="one-time-code"
              maxLength={MAX_CODE_CHARS}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </SettingRow>
          <SettingRow
            label={t('settingsView.cloudSync.resetNewPassword')}
            note={t('settingsView.cloudSync.atLeast12Chars')}
            controlId={passwordId}
          >
            <Input
              id={passwordId}
              className="w-64"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </SettingRow>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setStep('closed')} disabled={busy}>
          {t('settingsView.cloudSync.deleteCancel')}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {step === 'email'
            ? t('settingsView.cloudSync.forgotEmailMe')
            : t('settingsView.cloudSync.resetSet')}
        </Button>
      </div>
    </form>
  )
}
