// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Persistent Settings
// ═══════════════════════════════════════════════════════════
// Wrapper around electron-store. All writes stay inside app.getPath('userData'),
// complying with AGENTS.md §3.4 (filesystem paths confined to app data).
//
// SECURITY NOTE: proxy credentials are stored as plaintext in electron-store
// for MVP. This is acceptable because:
//   - userData is single-user, mode 0700 on Linux
//   - proxy creds are lower-sensitivity than auth tokens
// TODO(v1.1): migrate to electron safeStorage (OS keychain) once we handle
//   the headless/no-keyring fallback path explicitly.

import Store from 'electron-store'
import type { ProxyMap, ProxyConfig, UiTheme } from '../shared/types'
import { SERVICES } from './services'

interface Schema {
  /** Last service the user had open; restored on next launch. */
  lastActiveService: string
  /** Per-service proxy URLs. Missing key = direct connection. */
  proxies: ProxyMap
  /** Chrome UI theme: dark (void CRT) or light (golden parchment forge). */
  theme: UiTheme
  /** Last update version the user dismissed (banner). */
  dismissedUpdateVersion: string
}

const store = new Store<Schema>({
  defaults: {
    lastActiveService: 'telegram',
    proxies: {},
    // Golden Mechanicus light is the default chrome; messengers keep
    // their own dark/light via their settings (we never force nativeTheme).
    theme: 'light',
    dismissedUpdateVersion: ''
  }
})

// ─── lastActiveService ──────────────────────────────────────
export function getLastActiveService(): string {
  return store.get('lastActiveService')
}

export function setLastActiveService(id: string): void {
  store.set('lastActiveService', id)
}

// ─── Theme ──────────────────────────────────────────────────
export function getTheme(): UiTheme {
  const t = store.get('theme')
  return t === 'dark' ? 'dark' : 'light'
}

export function setTheme(theme: UiTheme): void {
  store.set('theme', theme === 'dark' ? 'dark' : 'light')
}

// ─── Updates ────────────────────────────────────────────────
export function getDismissedUpdateVersion(): string {
  return store.get('dismissedUpdateVersion') || ''
}

export function setDismissedUpdateVersion(version: string): void {
  store.set('dismissedUpdateVersion', version)
}

// ─── Smart Proxy ────────────────────────────────────────────
/**
 * Read all per-service proxies. Returns a complete map keyed by every
 * registered service id (missing entries normalized to direct).
 */
export function getProxies(): ProxyMap {
  const stored = store.get('proxies') as ProxyMap
  const out: ProxyMap = {}
  for (const svc of SERVICES) {
    const p = stored[svc.id]
    out[svc.id] = p ?? { service: svc.id, url: '' }
  }
  return out
}

export function getProxy(serviceId: string): ProxyConfig {
  const all = getProxies()
  return all[serviceId] ?? { service: serviceId, url: '' }
}

/** Persist one service's proxy URL ('' = direct). */
export function setProxy(serviceId: string, url: string): void {
  const all = store.get('proxies') as ProxyMap
  all[serviceId] = { service: serviceId, url }
  store.set('proxies', all)
}
