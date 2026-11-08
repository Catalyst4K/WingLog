/** Cloud sync's account recovery: a forgotten password, and deleting the account. Split from use-settings-state.ts to keep that file short. */

import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { SyncStatus } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'

/**
 * @param err What an account action threw.
 */
function toastError(err: unknown): void {
  toast.error(err instanceof Error ? err.message : String(err))
}

/** What the cloud sync card can do about a lost password or an account to be removed. */
export interface AccountRecovery {
  /** Asks for a reset code by email. Resolves true when the service took the request. */
  forgotPassword: (email: string) => Promise<boolean>
  /** Sets a new password with the emailed code. Resolves true when it was changed. */
  resetPassword: (email: string, code: string, password: string) => Promise<boolean>
  /** Deletes the cloud account for the password; the data on this computer stays. Resolves true when it was deleted. */
  deleteAccount: (password: string) => Promise<boolean>
}

/**
 * @param setStatus Sets the card's sync status, which a reset or a deletion changes (it signs this computer out).
 * @returns The three actions.
 */
export function useAccountRecovery(setStatus: Dispatch<SetStateAction<SyncStatus>>): AccountRecovery {
  const { t } = useTranslation()

  /**
   * "not found" is how the service answers while password reset is not switched on.
   *
   * @param err What the call threw.
   */
  function resetError(err: unknown): void {
    if (err instanceof Error && err.message === 'not found')
      toast.error(t('settingsView.cloudSync.resetUnavailable'))
    else toastError(err)
  }

  async function forgotPassword(forgottenEmail: string): Promise<boolean> {
    try {
      await winglogApi().authForgotPassword(forgottenEmail)
      return true
    } catch (err) {
      resetError(err)
      return false
    }
  }

  async function resetPassword(resetEmail: string, code: string, newPassword: string): Promise<boolean> {
    try {
      setStatus(await winglogApi().authResetPassword(resetEmail, code, newPassword))
      toast.success(t('settingsView.cloudSync.resetDoneToast'))
      return true
    } catch (err) {
      resetError(err)
      return false
    }
  }

  async function deleteAccount(accountPassword: string): Promise<boolean> {
    try {
      setStatus(await winglogApi().authDeleteAccount(accountPassword))
      toast.success(t('settingsView.cloudSync.accountDeletedToast'))
      return true
    } catch (err) {
      toastError(err)
      return false
    }
  }

  return { forgotPassword, resetPassword, deleteAccount }
}
