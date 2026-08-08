// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — License Client (Main-process side)
// ═══════════════════════════════════════════════════════════
// Talks to the license-worker (services/license-worker) over HTTPS.
// Responsibilities:
//   - Hold the deviceId (random UUID, generated once, persisted).
//   - Hold the activation token (opaque, persisted via safeStorage).
//   - On startup: verify the token; degrade to trial/expired if it fails.
//   - Expose activate(key) / forget() / getState() to the renderer.
//
// NO secrets are baked in: the worker URL comes from VOX_LICENSE_URL
// (dev: http://localhost:8787, prod: your workers.dev URL). If unset,
// licensing is disabled and the app runs as unlicensed forever —
// nothing breaks, Pro features (when any exist) simply show "locked".

import { safeStorage } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'crypto'
import type {
  LicenseState,
  LicenseTier,
  ActivateResult
} from '../shared/types'

const DEFAULT_URL = 'http://localhost:8787'
const TRIAL_DAYS = 14

interface Persisted {
  deviceId: string
  /** Encrypted opaque token (safeStorage). Empty when unactivated. */
  tokenEnc: string
  /** The license key tail (last 4) for display. */
  keyTail: string
  /** First-run timestamp for the trial window. */
  firstRunAt: number
}

const store = new Store<Persisted>({
  name: 'license',
  defaults: {
    deviceId: '',
    tokenEnc: '',
    keyTail: '',
    firstRunAt: 0
  }
})

function workerUrl(): string {
  return (process.env['VOX_LICENSE_URL'] || DEFAULT_URL).replace(/\/$/, '')
}

function getDeviceId(): string {
  let id = store.get('deviceId')
  if (!id) {
    id = randomUUID()
    store.set('deviceId', id)
  }
  return id
}

function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64')
  }
  // Fallback: plaintext (single-user userData, mode 0700). Documented.
  return 'plain:' + token
}

function decryptToken(enc: string): string {
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

function stateFromTier(
  tier: LicenseTier,
  expiresAt: number,
  keyTail = ''
): LicenseState {
  let statusText: string
  switch (tier) {
    case 'trial':
      statusText = `TRIAL · ${daysLeft(expiresAt)}D LEFT`
      break
    case 'licensed':
      statusText = `LICENSED · ${keyTail || 'VOX'}`
      break
    case 'expired':
      statusText = 'EXPIRED'
      break
    case 'revoked':
      statusText = 'REVOKED'
      break
    default:
      // No backend configured → app is free/open. Don't alarm the user.
      statusText = 'OPEN SOURCE'
  }
  return { tier, expiresAt, keyTail, statusText }
}

function daysLeft(expiresAt: number): number {
  if (!expiresAt) return 0
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000))
}

/**
 * Compute the current license state. Verifies the token online if
 * one is present; otherwise falls back to trial (first 14 days) or
 * unlicensed.
 */
export async function getLicenseState(): Promise<LicenseState> {
  // No worker configured? Licensing disabled entirely.
  if (!process.env['VOX_LICENSE_URL']) {
    return stateFromTier('unlicensed', 0)
  }

  const token = decryptToken(store.get('tokenEnc'))
  if (token) {
    try {
      const res = await fetch(`${workerUrl()}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, deviceId: getDeviceId() })
      })
      const data = (await res.json()) as {
        valid: boolean
        expiresAt: number | null
        reason?: string
      }
      if (data.valid) {
        return stateFromTier('licensed', data.expiresAt ?? 0, store.get('keyTail'))
      }
      if (data.reason === 'revoked') {
        return stateFromTier('revoked', 0)
      }
      if (data.reason === 'expired') {
        return stateFromTier('expired', data.expiresAt ?? 0)
      }
      // unknown token / device mismatch — fall through to trial.
    } catch {
      // Network error — fall through to trial so the app still works
      // offline. We do NOT hard-lock on network failure.
    }
  }

  // Trial window: first TRIAL_DAYS days since first run.
  let firstRun = store.get('firstRunAt')
  if (!firstRun) {
    firstRun = Date.now()
    store.set('firstRunAt', firstRun)
  }
  const expiresAt = firstRun + TRIAL_DAYS * 86400000
  if (Date.now() < expiresAt) {
    return stateFromTier('trial', expiresAt)
  }
  return stateFromTier('expired', expiresAt)
}

/**
 * Activate a license key. On success, persists the token and returns
 * the new state. On failure, returns the error.
 */
export async function activateLicense(key: string): Promise<ActivateResult> {
  if (!process.env['VOX_LICENSE_URL']) {
    return { ok: false, error: 'Licensing not configured' }
  }
  const clean = key.trim().toUpperCase()
  if (!clean) return { ok: false, error: 'Empty key' }

  try {
    const res = await fetch(`${workerUrl()}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: clean, deviceId: getDeviceId() })
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: err.error || `HTTP ${res.status}` }
    }
    const data = (await res.json()) as { token: string; expiresAt: number }
    store.set('tokenEnc', encryptToken(data.token))
    store.set('keyTail', clean.slice(-4))
    const state = stateFromTier('licensed', data.expiresAt, clean.slice(-4))
    return { ok: true, state }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Forget the activation token (sign out / switch account). */
export function forgetLicense(): LicenseState {
  store.set('tokenEnc', '')
  store.set('keyTail', '')
  // Keep deviceId + firstRunAt — trial window continues.
  let firstRun = store.get('firstRunAt')
  if (!firstRun) {
    firstRun = Date.now()
    store.set('firstRunAt', firstRun)
  }
  const expiresAt = firstRun + TRIAL_DAYS * 86400000
  if (Date.now() < expiresAt) return stateFromTier('trial', expiresAt)
  return stateFromTier('expired', expiresAt)
}

// Ensure deviceId is set on import (defensive — also done in getter).
void getDeviceId()
