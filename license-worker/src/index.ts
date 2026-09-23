// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — License Worker
// ═══════════════════════════════════════════════════════════
// Cloudflare Worker that owns license activation + verification for
// the Vox Internum desktop client.
//
// Architecture:
//   - LICENSES KV: key (license_id) -> ActivationRecord
//   - TOKENS KV:   token -> { licenseId, deviceId, expiresAt }
//   - Opaque session tokens (random 32 bytes), NOT JWT. TLS + online
//     verification is enough for desktop licensing.
//
// Endpoints:
//   POST /activate {key, deviceId}            -> {token, expiresAt} | error
//   POST /verify   {token, deviceId}          -> {valid, expiresAt} | error
//   POST /admin/create {days} [auth]          -> {key} (admin only)
//   POST /admin/revoke {key} [auth]           -> {ok} (admin only)
//   GET  /health                              -> {ok:true}
//
// Activation rules:
//   - A key has MAX_DEVICES slots. Activating on a new deviceId
//     consumes one; re-activating on a known deviceId is idempotent.
//   - revoking a key invalidates all its tokens.
//
// Money: this Worker does NOT touch payments. The principal issues
// keys manually via /admin/create after accepting payment out-of-band
// (crypto, ЮMoney, Boosty, etc.).

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  LICENSES: KVNamespace
  TOKENS: KVNamespace
  ADMIN_KEY: string
  TRIAL_DAYS: string
  MAX_DEVICES: string
}

interface LicenseRecord {
  /** The license key — also the KV key. */
  key: string
  /** Epoch ms when the key was created. */
  createdAt: number
  /** Validity duration in days from first activation. */
  days: number
  /** Whether the principal revoked the key. */
  revoked: boolean
  /** Device activation records. */
  activations: ActivationEntry[]
}

interface ActivationEntry {
  deviceId: string
  /** Epoch ms when this device first activated. */
  activatedAt: number
  /** Current opaque session token for this device. */
  token: string
}

interface VerifyResponse {
  valid: boolean
  expiresAt: number | null
  reason?: string
}

const MAX_DEVICES_DEFAULT = 3
const TRIAL_DAYS_DEFAULT = 14

// ─── Helpers ────────────────────────────────────────────────

function randomKey(): string {
  // 4 groups of 8 base32 chars, separated by dashes.
  // Crockford base32 (no I/L/O/U to avoid confusion).
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) {
      out += alphabet[bytes[i * 8 + j] % alphabet.length]
    }
    if (i < 3) out += '-'
  }
  return 'VOX-' + out
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function maxDevices(env: Env): number {
  const n = parseInt(env.MAX_DEVICES, 10)
  return Number.isFinite(n) && n > 0 ? n : MAX_DEVICES_DEFAULT
}

function trialDays(env: Env): number {
  const n = parseInt(env.TRIAL_DAYS, 10)
  return Number.isFinite(n) && n > 0 ? n : TRIAL_DAYS_DEFAULT
}

/** Expiry = first activation + days, OR trial window if never activated. */
function expiryOf(rec: LicenseRecord): number {
  if (rec.activations.length === 0) {
    // Trial window from creation.
    return rec.createdAt + rec.days * 86400000
  }
  // From earliest activation.
  const earliest = Math.min(...rec.activations.map((a) => a.activatedAt))
  return earliest + rec.days * 86400000
}

// ─── Endpoint handlers ──────────────────────────────────────

async function activate(
  req: Request,
  env: Env
): Promise<Response> {
  let body: { key?: string; deviceId?: string }
  try {
    body = (await req.json()) as { key?: string; deviceId?: string }
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  const key = (body.key || '').trim().toUpperCase()
  const deviceId = (body.deviceId || '').trim()
  if (!key || !deviceId) {
    return json({ error: 'key and deviceId required' }, 400)
  }

  const recRaw = await env.LICENSES.get(key)
  if (!recRaw) return json({ error: 'invalid key' }, 404)
  const rec = JSON.parse(recRaw) as LicenseRecord

  if (rec.revoked) return json({ error: 'key revoked' }, 403)

  // Already activated on this device? Rotate token, keep activation.
  const existing = rec.activations.find((a) => a.deviceId === deviceId)
  if (existing) {
    // Invalidate old token.
    if (existing.token) await env.TOKENS.delete(existing.token)
    existing.token = randomToken()
    const expiresAt = expiryOf(rec)
    await env.TOKENS.put(
      existing.token,
      JSON.stringify({ licenseId: rec.key, deviceId, expiresAt })
    )
    await env.LICENSES.put(key, JSON.stringify(rec))
    return json({ token: existing.token, expiresAt })
  }

  // New device — consume a slot if available.
  if (rec.activations.length >= maxDevices(env)) {
    return json({ error: 'device limit reached', maxDevices: maxDevices(env) }, 403)
  }

  const token = randomToken()
  rec.activations.push({ deviceId, activatedAt: Date.now(), token })
  const expiresAt = expiryOf(rec)
  await env.TOKENS.put(
    token,
    JSON.stringify({ licenseId: rec.key, deviceId, expiresAt })
  )
  await env.LICENSES.put(key, JSON.stringify(rec))
  return json({ token, expiresAt })
}

async function verify(req: Request, env: Env): Promise<Response> {
  let body: { token?: string; deviceId?: string }
  try {
    body = (await req.json()) as { token?: string; deviceId?: string }
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  const { token, deviceId } = body
  if (!token || !deviceId) {
    return json({ error: 'token and deviceId required' }, 400)
  }

  const tokenRaw = await env.TOKENS.get(token || '')
  if (!tokenRaw) return json({ valid: false, expiresAt: null, reason: 'unknown token' } as VerifyResponse)
  const t = JSON.parse(tokenRaw) as { licenseId: string; deviceId: string; expiresAt: number }

  if (t.deviceId !== deviceId) {
    return json({ valid: false, expiresAt: null, reason: 'device mismatch' } as VerifyResponse)
  }
  if (Date.now() >= t.expiresAt) {
    return json({ valid: false, expiresAt: t.expiresAt, reason: 'expired' } as VerifyResponse)
  }

  // Also confirm the license itself is not revoked.
  const recRaw = await env.LICENSES.get(t.licenseId)
  if (!recRaw) return json({ valid: false, expiresAt: null, reason: 'license missing' } as VerifyResponse)
  const rec = JSON.parse(recRaw) as LicenseRecord
  if (rec.revoked) {
    return json({ valid: false, expiresAt: t.expiresAt, reason: 'revoked' } as VerifyResponse)
  }

  return json({ valid: true, expiresAt: t.expiresAt } as VerifyResponse)
}

async function adminCreate(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: 'forbidden' }, 403)
  let body: { days?: number }
  try {
    body = (await req.json()) as { days?: number }
  } catch {
    body = {}
  }
  const days = Number.isFinite(body.days) && (body.days as number) > 0
    ? (body.days as number)
    : trialDays(env)

  const key = randomKey()
  const rec: LicenseRecord = {
    key,
    createdAt: Date.now(),
    days,
    revoked: false,
    activations: []
  }
  await env.LICENSES.put(key, JSON.stringify(rec))
  return json({ key, days })
}

async function adminRevoke(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: 'forbidden' }, 403)
  let body: { key?: string }
  try {
    body = (await req.json()) as { key?: string }
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  const key = (body.key || '').trim().toUpperCase()
  if (!key) return json({ error: 'key required' }, 400)

  const recRaw = await env.LICENSES.get(key)
  if (!recRaw) return json({ error: 'invalid key' }, 404)
  const rec = JSON.parse(recRaw) as LicenseRecord
  rec.revoked = true
  // Invalidate all tokens.
  for (const a of rec.activations) {
    if (a.token) await env.TOKENS.delete(a.token)
  }
  rec.activations = []
  await env.LICENSES.put(key, JSON.stringify(rec))
  return json({ ok: true, key })
}

function isAdmin(req: Request, env: Env): boolean {
  // Secret not configured → admin endpoints are closed. Otherwise the
  // expected header would be the literal "Bearer undefined".
  if (!env.ADMIN_KEY) return false
  const auth = req.headers.get('authorization') || ''
  const expected = `Bearer ${env.ADMIN_KEY}`
  // Constant-time-ish comparison.
  if (auth.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < auth.length; i++) {
    diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

// ─── Router ─────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // Lightweight CORS for the desktop client (same-origin not needed,
    // but OPTIONS preflight safety).
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization'
        }
      })
    }

    try {
      if (path === '/health' && req.method === 'GET') {
        return json({ ok: true, service: 'vox-internum-license' })
      }
      // `return await` so async failures land in the catch below.
      if (path === '/activate' && req.method === 'POST') return await activate(req, env)
      if (path === '/verify' && req.method === 'POST') return await verify(req, env)
      if (path === '/admin/create' && req.method === 'POST') return await adminCreate(req, env)
      if (path === '/admin/revoke' && req.method === 'POST') return await adminRevoke(req, env)
      return json({ error: 'not found' }, 404)
    } catch (e) {
      return json({ error: (e as Error).message }, 500)
    }
  }
}
