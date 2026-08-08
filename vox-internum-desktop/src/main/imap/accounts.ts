// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Gmail IMAP Account Storage
// ═══════════════════════════════════════════════════════════
// Persists the user's Gmail address + App Password using Electron's
// safeStorage (OS keychain on Linux/macOS, DPAPI on Windows). The
// credentials NEVER touch disk in plaintext.
//
// One account only — Vox Internum is a personal aggregator, not a
// multi-account mail client. If multi-account is needed later, extend
// to an array with the same pattern.

import Store from 'electron-store'
import { safeStorage } from 'electron'

interface AccountStore {
  /** Gmail address (alice@gmail.com). Plaintext — not secret. */
  email: string
  /**
   * App Password (16 chars, generated at myaccount.google.com/
   * apppasswords). Encrypted via safeStorage; base64-encoded for
   * JSON storage. Empty when no account is configured.
   */
  appPasswordEnc: string
}

const store = new Store<AccountStore>({
  name: 'gmail-account',
  defaults: {
    email: '',
    appPasswordEnc: ''
  }
})

/** Returns true if a Gmail account is configured (email + password). */
export function hasGmailAccount(): boolean {
  return Boolean(store.get('email') && store.get('appPasswordEnc'))
}

/** Read the configured Gmail address, or '' if none. */
export function getGmailEmail(): string {
  return store.get('email')
}

/**
 * Read the App Password (decrypted). Returns '' if not set or if
 * decryption fails (e.g. OS keychain changed). When keychain is
 * unavailable, falls back to a plaintext-with-prefix scheme — same
 * approach as license.ts.
 */
export function getGmailAppPassword(): string {
  const enc = store.get('appPasswordEnc')
  if (!enc) return ''
  if (enc.startsWith('plain:')) return enc.slice(6)
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Persist a Gmail account. Encrypts the App Password via safeStorage.
 * Calling this overwrites any existing account.
 */
export function setGmailAccount(email: string, appPassword: string): void {
  let enc: string
  if (!appPassword) {
    enc = ''
  } else if (safeStorage.isEncryptionAvailable()) {
    enc = safeStorage.encryptString(appPassword).toString('base64')
  } else {
    enc = 'plain:' + appPassword
  }
  store.set('email', email.trim())
  store.set('appPasswordEnc', enc)
}

/** Forget the stored Gmail account (sign out). */
export function clearGmailAccount(): void {
  store.set('email', '')
  store.set('appPasswordEnc', '')
}

/** IMAP/SMTP server coordinates for Gmail. */
export const GMAIL_IMAP = {
  host: 'imap.gmail.com',
  port: 993
}
export const GMAIL_SMTP = {
  host: 'smtp.gmail.com',
  port: 465
}
