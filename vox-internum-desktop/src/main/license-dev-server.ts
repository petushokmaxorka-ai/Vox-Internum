// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — License dev server (LOCAL TEST ONLY)
// ═══════════════════════════════════════════════════════════
// Minimal in-process HTTP server that mimics the license-worker
// API for local testing. NOT for production — the real backend
// is the Cloudflare Worker (services/license-worker). This is
// only enabled when VOX_LICENSE_DEV=1 is set, so shipping the
// app with this code is safe (it never runs for end users).
//
// Endpoints (same shape as the Worker):
//   POST /activate {key, deviceId}  → {token, expiresAt}
//   POST /verify   {token, deviceId} → {valid, expiresAt, reason?}
//   POST /admin/create {days} [Bearer ADMIN_KEY] → {key, days}
//   POST /admin/revoke {key} [Bearer ADMIN_KEY] → {ok, key}
//   GET  /health → {ok:true}

import { createServer, type Server } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const DEV_ADMIN_KEY = 'vox-dev-admin-2026'
const DEV_PORT = 8788

// ─── Persistent storage ─────────────────────────────────────
// Licenses + tokens are persisted to a JSON file in userData so
// they survive Vox Internum restarts. The file lives at:
//   ~/.config/vox-internum-desktop/license-dev-state.json
// This is DEV-ONLY — production uses the Cloudflare Worker + KV.

interface StoredLicense {
  key: string
  days: number
  createdAt: number
  revoked: boolean
  activations: Array<{ deviceId: string; token: string; activatedAt: number }>
}
interface StoredState {
  licenses: StoredLicense[]
}

function stateFilePath(): string {
  return join(app.getPath('userData'), 'license-dev-state.json')
}

function loadState(): { licenses: Map<string, any>; tokens: Map<string, any> } {
  const licenses = new Map<string, any>()
  const tokens = new Map<string, any>()
  const p = stateFilePath()
  if (!existsSync(p)) return { licenses, tokens }
  try {
    const raw = readFileSync(p, 'utf8')
    const data: StoredState = JSON.parse(raw)
    for (const sl of data.licenses || []) {
      const activations = new Map<string, { token: string; activatedAt: number }>()
      for (const a of sl.activations || []) {
        activations.set(a.deviceId, { token: a.token, activatedAt: a.activatedAt })
        tokens.set(a.token, { licenseKey: sl.key, deviceId: a.deviceId, expiresAt: sl.createdAt + sl.days * 86400000 })
      }
      licenses.set(sl.key, { ...sl, activations })
    }
  } catch {
    // corrupted file — start fresh
  }
  return { licenses, tokens }
}

function saveState(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const data: StoredState = {
    licenses: Array.from(licenses.entries()).map(([key, rec]) => ({
      key,
      days: rec.days,
      createdAt: rec.createdAt,
      revoked: rec.revoked,
      activations: Array.from(rec.activations.entries()).map(([deviceId, a]) => ({
        deviceId,
        token: a.token,
        activatedAt: a.activatedAt
      }))
    }))
  }
  writeFileSync(stateFilePath(), JSON.stringify(data, null, 2))
}

// Initialize from disk (declared here, populated below).
const licenses = new Map<string, { key: string; days: number; createdAt: number; revoked: boolean; activations: Map<string, { token: string; activatedAt: number }> }>()
const tokens = new Map<string, { licenseKey: string; deviceId: string; expiresAt: number }>()

// Load existing state immediately.
{
  const loaded = loadState()
  loaded.licenses.forEach((v, k) => licenses.set(k, v))
  loaded.tokens.forEach((v, k) => tokens.set(k, v))
}

function randKey(): string {
  const a = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let k = ''
  const b = randomBytes(32)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) k += a[b[i * 8 + j] % a.length]
    if (i < 3) k += '-'
  }
  return 'VOX-' + k
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c: Buffer) => (s += c.toString()))
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function isAdmin(req: any): boolean {
  const h = req.headers['authorization'] || ''
  return h === `Bearer ${DEV_ADMIN_KEY}`
}

export function startLicenseDevServer(): Server {
  const srv = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization'
      })
      res.end()
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, service: 'vox-internum-license-dev' })
      }
      if (url.pathname === '/admin/create' && req.method === 'POST') {
        if (!isAdmin(req)) return json(res, 403, { error: 'forbidden' })
        const b = await readBody(req)
        const days = Number.isFinite(b.days) && b.days > 0 ? b.days : 30
        const key = randKey()
        licenses.set(key, { key, days, createdAt: Date.now(), revoked: false, activations: new Map() })
        saveState()
        console.log(`[vox-license-dev] created key ${key} (${days}d)`)
        return json(res, 200, { key, days })
      }
      if (url.pathname === '/admin/revoke' && req.method === 'POST') {
        if (!isAdmin(req)) return json(res, 403, { error: 'forbidden' })
        const b = await readBody(req)
        const rec = licenses.get((b.key || '').toUpperCase())
        if (!rec) return json(res, 404, { error: 'invalid key' })
        rec.revoked = true
        for (const [, a] of rec.activations) tokens.delete(a.token)
        rec.activations.clear()
        saveState()
        return json(res, 200, { ok: true, key: rec.key })
      }
      if (url.pathname === '/activate' && req.method === 'POST') {
        const b = await readBody(req)
        const key = (b.key || '').toUpperCase()
        const deviceId = b.deviceId || ''
        if (!key || !deviceId) return json(res, 400, { error: 'key and deviceId required' })
        const rec = licenses.get(key)
        if (!rec) return json(res, 404, { error: 'invalid key' })
        if (rec.revoked) return json(res, 403, { error: 'key revoked' })
        const existing = rec.activations.get(deviceId)
        if (existing) {
          tokens.delete(existing.token)
          const token = randomUUID()
          const earliest = Math.min(...Array.from(rec.activations.values()).map((a) => a.activatedAt))
          const expiresAt = earliest + rec.days * 86400000
          existing.token = token
          existing.activatedAt = Date.now()
          tokens.set(token, { licenseKey: key, deviceId, expiresAt })
          saveState()
          return json(res, 200, { token, expiresAt })
        }
        if (rec.activations.size >= 3) return json(res, 403, { error: 'device limit reached' })
        const token = randomUUID()
        const activatedAt = Date.now()
        const expiresAt = activatedAt + rec.days * 86400000
        rec.activations.set(deviceId, { token, activatedAt })
        tokens.set(token, { licenseKey: key, deviceId, expiresAt })
        saveState()
        console.log(`[vox-license-dev] activated ${key.slice(-6)} for device ${deviceId.slice(0, 8)}`)
        return json(res, 200, { token, expiresAt })
      }
      if (url.pathname === '/verify' && req.method === 'POST') {
        const b = await readBody(req)
        const token = b.token || ''
        const deviceId = b.deviceId || ''
        if (!token || !deviceId) return json(res, 400, { error: 'token and deviceId required' })
        const t = tokens.get(token)
        if (!t) return json(res, 200, { valid: false, expiresAt: null, reason: 'unknown token' })
        if (t.deviceId !== deviceId) return json(res, 200, { valid: false, expiresAt: null, reason: 'device mismatch' })
        if (Date.now() >= t.expiresAt) return json(res, 200, { valid: false, expiresAt: t.expiresAt, reason: 'expired' })
        const rec = licenses.get(t.licenseKey)
        if (!rec || rec.revoked) return json(res, 200, { valid: false, expiresAt: null, reason: 'revoked' })
        return json(res, 200, { valid: true, expiresAt: t.expiresAt })
      }
      return json(res, 404, { error: 'not found' })
    } catch (e) {
      return json(res, 500, { error: (e as Error).message })
    }
  })
  srv.listen(DEV_PORT, '127.0.0.1', () => {
    console.log(`[vox-license-dev] listening on http://127.0.0.1:${DEV_PORT}`)
    console.log(`[vox-license-dev] ADMIN_KEY=${DEV_ADMIN_KEY}`)
    console.log(`[vox-license-dev] generate a key:`)
    console.log(`[vox-license-dev]   curl -X POST http://127.0.0.1:${DEV_PORT}/admin/create -H "Authorization: Bearer ${DEV_ADMIN_KEY}" -H "Content-Type: application/json" -d '{"days":365}'`)
  })
  return srv
}
