// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Google Cookie Import / Inject
// ═══════════════════════════════════════════════════════════
// Two paths to defeat Google's "This browser or app may not be
// secure" Electron block:
//
//   1. Manual paste — user copies SID/HSID/… from a real Chrome
//      DevTools cookie table and pastes NAME=VALUE lines.
//   2. Auto-import — read Chrome's Cookies SQLite + decrypt via
//      gnome-keyring (Linux). Best-effort; Chrome v20 encryption
//      / locked DB often fails → fall back to paste.
//
// Critical Electron cookies.set quirks we honour here:
//   - Cookie names may contain `-` (`__Secure-1PSID`).
//   - SAPISID / APISID must NOT be httpOnly (page JS needs them).
//   - `__Secure-*` / `__Host-*` require secure=true; `__Host-*`
//     must not set a Domain attribute.
//   - Inject against several Google URLs so the jar is usable for
//     accounts.google.com OAuth redirects into AI chat sites.

import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { copyFileSync, existsSync, unlinkSync } from 'fs'
import { createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import type { CookiesSetDetails, Session, Cookie } from 'electron'

export interface CookiePair {
  name: string
  value: string
}

/** Full cookie as returned by CDP / Chrome — preserve attributes on inject. */
export interface FullCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  /** Unix seconds; omit / <=0 → session cookie */
  expires?: number
  sameSite?: string
}

export interface InjectResult {
  ok: boolean
  set: number
  skipped: number
  error?: string
  details?: string[]
}

/** Cookies Google keeps httpOnly (JS must not read them). */
const HTTP_ONLY = new Set([
  'SID',
  'HSID',
  'SSID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  'NID',
  'AEC'
])

/** Cookies the page JS needs (SAPISIDHASH etc.). Never mark httpOnly. */
const NEVER_HTTP_ONLY = new Set([
  'APISID',
  'SAPISID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC'
])

const GOOGLE_URLS = [
  'https://accounts.google.com/',
  'https://www.google.com/',
  'https://google.com/'
]

/**
 * Parse pasted cookie text. Accepts:
 *   NAME=VALUE
 *   NAME = VALUE
 *   Cookie header: `a=b; c=d`
 *   DevTools TSV row: name<TAB>value<TAB>…
 * Cookie names may include `-` / `__` (e.g. `__Secure-1PSID`).
 */
export function parseCookiePaste(raw: string): CookiePair[] {
  const out: CookiePair[] = []
  const seen = new Set<string>()

  const push = (name: string, value: string): void => {
    const n = name.trim()
    const v = value.trim()
    if (!n || !v) return
    if (!/^[\w.-]+$/.test(n)) return
    if (seen.has(n)) return
    seen.add(n)
    out.push({ name: n, value: v })
  }

  const text = (raw ?? '').trim()
  if (!text) return out

  // Single-line Cookie header form.
  if (!text.includes('\n') && text.includes(';') && text.includes('=')) {
    for (const part of text.split(';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      push(part.slice(0, eq), part.slice(eq + 1))
    }
    return out
  }

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue

    if (t.includes('\t')) {
      const cols = t.split('\t')
      if (cols.length >= 2) push(cols[0], cols[1])
      continue
    }

    const eq = t.indexOf('=')
    if (eq <= 0) continue
    push(t.slice(0, eq), t.slice(eq + 1))
  }

  return out
}

function mapSameSite(
  raw?: string
): CookiesSetDetails['sameSite'] {
  const s = (raw || '').toLowerCase()
  if (s === 'none' || s === 'no_restriction') return 'no_restriction'
  if (s === 'lax') return 'lax'
  if (s === 'strict') return 'strict'
  return 'unspecified'
}

function urlForCookieDomain(domain: string | undefined, name: string): string {
  if (name.startsWith('__Host-')) return 'https://accounts.google.com/'
  const d = (domain || '.google.com').replace(/^\./, '')
  if (!d) return 'https://www.google.com/'
  return `https://${d}/`
}

function cookieDetails(name: string, value: string, url: string): CookiesSetDetails {
  const hostOnly = name.startsWith('__Host-')
  const details: CookiesSetDetails = {
    url,
    name,
    value,
    path: '/',
    secure: true,
    sameSite: 'lax',
    httpOnly: NEVER_HTTP_ONLY.has(name) ? false : HTTP_ONLY.has(name) ? true : false
  }
  // __Host- cookies must not set Domain; __Secure- / normal Google
  // session cookies live on .google.com.
  if (!hostOnly) {
    details.domain = '.google.com'
  }
  return details
}

function fullCookieToDetails(c: FullCookie): CookiesSetDetails {
  const name = c.name
  const rawDomain = c.domain || ''
  const isHostPrefixed = name.startsWith('__Host-')
  // CDP: leading-dot = Domain attribute; no leading dot = host-only cookie.
  const hostOnly = isHostPrefixed || (rawDomain !== '' && !rawDomain.startsWith('.'))
  const url = urlForCookieDomain(rawDomain || '.google.com', name)

  const details: CookiesSetDetails = {
    url,
    name,
    value: c.value,
    path: isHostPrefixed ? '/' : c.path || '/',
    secure:
      c.secure === true ||
      name.startsWith('__Secure-') ||
      isHostPrefixed ||
      mapSameSite(c.sameSite) === 'no_restriction',
    httpOnly: NEVER_HTTP_ONLY.has(name)
      ? false
      : c.httpOnly != null
        ? c.httpOnly
        : HTTP_ONLY.has(name)
  }

  if (!hostOnly) {
    details.domain = rawDomain.startsWith('.') ? rawDomain : `.${rawDomain.replace(/^\./, '')}`
  }

  const exp = c.expires
  if (typeof exp === 'number' && exp > 0) {
    details.expirationDate = exp
  }
  details.sameSite = mapSameSite(c.sameSite)
  if (details.sameSite === 'no_restriction') details.secure = true
  return details
}

async function setCookieWithFallback(ses: Session, details: CookiesSetDetails): Promise<void> {
  try {
    await ses.cookies.set(details)
    return
  } catch {
    /* retry softer */
  }
  const soft: CookiesSetDetails = { ...details }
  soft.sameSite = 'lax'
  try {
    await ses.cookies.set(soft)
    return
  } catch {
    /* retry minimal */
  }
  const minimal: CookiesSetDetails = {
    url: details.url,
    name: details.name,
    value: details.value,
    path: details.path || '/',
    secure: details.secure !== false,
    httpOnly: details.httpOnly,
    expirationDate: details.expirationDate
  }
  if (details.domain) minimal.domain = details.domain
  await ses.cookies.set(minimal)
}

/**
 * Inject Google session cookies into an Electron session.
 * Prefer injectGoogleCookiesFull when CDP attributes are available.
 */
export async function injectGoogleCookiePairs(
  ses: Session,
  pairs: CookiePair[]
): Promise<InjectResult> {
  if (!pairs.length) {
    return { ok: false, set: 0, skipped: 0, error: 'No cookies to inject. Paste NAME=VALUE lines.' }
  }

  let set = 0
  let skipped = 0
  const details: string[] = []

  for (const { name, value } of pairs) {
    let okOnce = false
    let lastErr = ''
    for (const url of GOOGLE_URLS) {
      try {
        await setCookieWithFallback(ses, cookieDetails(name, value, url))
        okOnce = true
        break
      } catch (e) {
        lastErr = (e as Error).message
      }
    }
    if (okOnce) {
      set++
    } else {
      skipped++
      details.push(`${name}: ${lastErr || 'set failed'}`)
    }
  }

  try {
    await ses.cookies.flushStore()
  } catch {
    /* ignore */
  }

  const verified = await verifyGoogleJar(ses)
  if (!verified.ok) {
    return {
      ok: false,
      set,
      skipped,
      error: verified.error,
      details
    }
  }

  if (set === 0) {
    return {
      ok: false,
      set: 0,
      skipped,
      error:
        'Electron rejected every cookie. Copy Name + Value from DevTools (not the Domain column). ' +
        (details[0] ?? ''),
      details
    }
  }

  return { ok: true, set, skipped, details: details.length ? details : undefined }
}

const SESSION_MARKERS = ['SID', 'HSID', 'SSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']

/** Inject arbitrary cookies (Google + site session). Optionally require Google jar. */
export async function injectCookiesFull(
  ses: Session,
  cookies: FullCookie[],
  opts: { requireGoogleSession?: boolean } = {}
): Promise<InjectResult> {
  if (!cookies.length) {
    return { ok: false, set: 0, skipped: 0, error: 'No cookies to inject' }
  }

  let set = 0
  let skipped = 0
  const details: string[] = []

  for (const c of cookies) {
    if (!c.name || !c.value) {
      skipped++
      continue
    }
    try {
      await setCookieWithFallback(ses, fullCookieToDetails(c))
      set++
    } catch (e) {
      skipped++
      details.push(`${c.name}: ${(e as Error).message}`)
    }
  }

  try {
    await ses.cookies.flushStore()
  } catch {
    /* ignore */
  }

  if (opts.requireGoogleSession !== false) {
    const hasGoogle = cookies.some((c) => SESSION_MARKERS.includes(c.name))
    if (hasGoogle) {
      const verified = await verifyGoogleJar(ses)
      if (!verified.ok) {
        return { ok: false, set, skipped, error: verified.error, details }
      }
    }
  }

  if (set === 0) {
    return { ok: false, set: 0, skipped, error: 'Electron rejected every cookie', details }
  }

  return { ok: true, set, skipped, details: details.length ? details : undefined }
}

/** Inject cookies preserving CDP domain/path/secure/httpOnly/expiry/sameSite. */
export async function injectGoogleCookiesFull(
  ses: Session,
  cookies: FullCookie[]
): Promise<InjectResult> {
  return injectCookiesFull(ses, cookies, { requireGoogleSession: true })
}

/** Confirm the jar actually contains a Google login session (not just ENID/OTZ). */
export async function verifyGoogleJar(ses: Session): Promise<{ ok: boolean; error?: string; found: string[] }> {
  let jar: Cookie[] = []
  try {
    const a = await ses.cookies.get({ domain: 'google.com' })
    const b = await ses.cookies.get({ domain: '.google.com' })
    const c = await ses.cookies.get({ domain: 'accounts.google.com' })
    const seen = new Set<string>()
    jar = []
    for (const x of [...a, ...b, ...c]) {
      const k = `${x.domain}|${x.name}`
      if (seen.has(k)) continue
      seen.add(k)
      jar.push(x)
    }
  } catch (e) {
    return { ok: false, found: [], error: `cookie read failed: ${(e as Error).message}` }
  }

  const found = SESSION_MARKERS.filter((n) => jar.some((c) => c.name === n && !!c.value))
  if (found.length < 2) {
    const names = jar.map((c) => c.name).slice(0, 20).join(',')
    return {
      ok: false,
      found,
      error:
        `Cookies did not stick in Electron jar (have: ${found.join(',') || 'none'}; jar=[${names}]). ` +
        'Sign in fully in the Chrome window, then PULL again.'
    }
  }
  return { ok: true, found }
}

// ─── Auto-import from Chrome (Linux) ────────────────────────

function findChromeCookiesDb(): string | null {
  const candidates = [
    join(homedir(), '.config', 'google-chrome', 'Default', 'Network', 'Cookies'),
    join(homedir(), '.config', 'google-chrome', 'Default', 'Cookies'),
    join(homedir(), '.config', 'chromium', 'Default', 'Network', 'Cookies'),
    join(homedir(), '.config', 'chromium', 'Default', 'Cookies'),
    join(homedir(), '.config', 'BraveSoftware', 'Brave-Browser', 'Default', 'Network', 'Cookies'),
    join(homedir(), '.config', 'microsoft-edge', 'Default', 'Network', 'Cookies')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function getChromeSafeStoragePassword(): string | null {
  const lookups: Array<[string, string]> = [
    ['application', 'chrome'],
    ['application', 'chromium'],
    ['xdg:schema', 'chrome_libsecret_os_crypt_password_v2'],
    ['xdg:schema', 'chromium_libsecret_os_crypt_password_v2']
  ]
  for (const [k, v] of lookups) {
    try {
      const key = execFileSync('secret-tool', ['lookup', k, v], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim()
      if (key) return key
    } catch {
      /* try next */
    }
  }
  return null
}

function deriveChromeKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
}

function decryptChromeCookie(encryptedBase: Buffer, key: Buffer): string {
  if (encryptedBase.length < 3) return encryptedBase.toString('utf8')
  const prefix = encryptedBase.subarray(0, 3).toString('ascii')

  if (prefix === 'v10') {
    const enc = encryptedBase.subarray(3)
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    let decrypted = Buffer.concat([decipher.update(enc), decipher.final()])
    const padLen = decrypted[decrypted.length - 1]
    if (padLen && padLen <= 16) decrypted = decrypted.subarray(0, decrypted.length - padLen)
    return decrypted.toString('utf8')
  }

  if (prefix === 'v11') {
    const nonce = encryptedBase.subarray(3, 15)
    const ciphertext = encryptedBase.subarray(15, encryptedBase.length - 16)
    const tag = encryptedBase.subarray(encryptedBase.length - 16)
    try {
      const decipher = createDecipheriv('aes-128-gcm', key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      const key256 = createHash('sha256').update(key).digest()
      const d = createDecipheriv('aes-256-gcm', key256, nonce)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8')
    }
  }

  if (prefix === 'v20') {
    // Chrome 127+ App-Bound encryption — needs OS-level key we cannot
    // reliably derive from secret-tool alone. Signal caller to paste.
    throw new Error('v20')
  }

  return encryptedBase.toString('utf8')
}

async function readChromeCookies(
  dbPath: string
): Promise<Array<{ name: string; value: string; domain: string }>> {
  // Chrome locks the live DB — copy to /tmp first.
  const tmp = join(tmpdir(), `vox-chrome-cookies-${randomBytes(4).toString('hex')}.db`)
  try {
    copyFileSync(dbPath, tmp)
    // WAL companions if present
    for (const suffix of ['-wal', '-shm']) {
      const side = dbPath + suffix
      if (existsSync(side)) {
        try {
          copyFileSync(side, tmp + suffix)
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    throw new Error(
      `Cannot copy Chrome cookie DB (is the disk full?): ${(e as Error).message}`
    )
  }

  let raw: string
  try {
    raw = execFileSync(
      'sqlite3',
      [
        '-separator',
        '\t',
        tmp,
        `SELECT name, host_key, hex(encrypted_value), value
         FROM cookies
         WHERE host_key LIKE '%google.com%'
            OR host_key LIKE '%google.ru%';`
      ],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 20 * 1024 * 1024 }
    )
  } catch (e) {
    throw new Error(
      `Failed to read Chrome cookies: ${(e as Error).message}. Install sqlite3, or close Chrome and retry.`
    )
  } finally {
    for (const p of [tmp, tmp + '-wal', tmp + '-shm']) {
      try {
        unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  }

  const password = getChromeSafeStoragePassword()
  const key = password ? deriveChromeKey(password) : Buffer.alloc(0)
  let sawV20 = false

  const out: Array<{ name: string; value: string; domain: string }> = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [name, domain, encHex, plainValue] = line.split('\t')
    if (!name) continue
    let value = plainValue || ''
    if (!value && encHex && encHex.length > 6 && password) {
      try {
        value = decryptChromeCookie(Buffer.from(encHex, 'hex'), key)
      } catch (e) {
        if ((e as Error).message === 'v20') sawV20 = true
        value = ''
      }
    }
    if (value) out.push({ name, value, domain: domain || '.google.com' })
  }

  if (out.length === 0 && sawV20) {
    throw new Error(
      'Chrome uses v20 cookie encryption — auto-import cannot decrypt. Use manual paste (F12 → Application → Cookies).'
    )
  }
  if (out.length === 0 && !password) {
    throw new Error(
      'Chrome profile cookies are locked (gnome-keyring). Do NOT use this path — use OPEN REAL CHROME → PULL COOKIES (CDP), or paste SID/HSID/SSID/APISID/SAPISID manually.'
    )
  }

  return out
}

const CRITICAL = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID'
]

export async function importGoogleCookiesFromBrowser(ses: Session): Promise<InjectResult> {
  const dbPath = findChromeCookiesDb()
  if (!dbPath) {
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error: 'Chrome/Chromium cookies DB not found. Use manual paste instead.'
    }
  }

  let cookies: Array<{ name: string; value: string; domain: string }>
  try {
    cookies = await readChromeCookies(dbPath)
  } catch (e) {
    return { ok: false, set: 0, skipped: 0, error: (e as Error).message }
  }

  const toInject = cookies
    .filter((c) => CRITICAL.includes(c.name))
    .map((c) => ({ name: c.name, value: c.value }))

  if (toInject.length === 0) {
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error:
        'No Google session cookies decrypted. Log into Google in Chrome, or paste SID/HSID/SSID/APISID/SAPISID manually.'
    }
  }

  return injectGoogleCookiePairs(ses, toInject)
}
