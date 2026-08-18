// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Chrome CDP Google Login
// ═══════════════════════════════════════════════════════════
// Electron popups are rejected by Google ("browser may not be
// secure"). Real Chrome is not. Flow:
//
//   1. Spawn google-chrome with a TEMP profile + remote debugging.
//   2. User signs in at accounts.google.com in that real Chrome.
//   3. Pull cookies via CDP Network.getAllCookies (plaintext).
//   4. Inject into the active Electron session; kill temp Chrome.
//
// CDP WebSocket is implemented with Node net (no extra deps).
// AGENTS.md §3.2: spawn argv only (no shell).

import { spawn, type ChildProcess } from 'child_process'
import { createServer, connect, type Socket } from 'net'
import { createHash, randomBytes } from 'crypto'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { app, session as electronSession, type Session } from 'electron'
import {
  injectCookiesFull,
  injectGoogleCookiesFull,
  type FullCookie,
  type InjectResult
} from './cookie-import'
import { SERVICES, partitionFor } from './services'
import { buildIpv4HostResolverRules } from './ipv4-hosts'

const CHROME_BINS = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'brave-browser',
  'microsoft-edge'
]

interface ChromeSession {
  port: number
  proc: ChildProcess | null
  userDataDir: string
  /** True after we navigated Chrome to the AI site for site-login. */
  navigatedToService: boolean
  serviceUrl: string
}

let active: ChromeSession | null = null

function chromeProfileDir(): string {
  return join(app.getPath('userData'), 'chrome-login-profile')
}

function chromePortFile(): string {
  return join(app.getPath('userData'), 'chrome-login-port.json')
}

function savePort(port: number): void {
  try {
    writeFileSync(chromePortFile(), JSON.stringify({ port }), 'utf8')
  } catch {
    /* ignore */
  }
}

function readSavedPort(): number | null {
  try {
    const j = JSON.parse(readFileSync(chromePortFile(), 'utf8')) as { port?: number }
    return typeof j.port === 'number' ? j.port : null
  } catch {
    return null
  }
}

function clearSavedPort(): void {
  try {
    unlinkSync(chromePortFile())
  } catch {
    /* ignore */
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (!addr || typeof addr === 'string') {
        s.close()
        reject(new Error('no port'))
        return
      }
      const port = addr.port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

function whichChrome(): string | null {
  for (const bin of CHROME_BINS) {
    try {
      const p = execFileSync('which', [bin], { encoding: 'utf8' }).trim()
      if (p) return p
    } catch {
      /* next */
    }
  }
  return null
}

async function waitForDebugger(port: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Chrome DevTools port did not come up')
}

/** Minimal CDP-over-WebSocket (text frames only). */
async function cdpCall(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const u = new URL(wsUrl)
  const key = randomBytes(16).toString('base64')
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = connect(
      { host: u.hostname, port: Number(u.port || 80), path: undefined },
      () => resolve(s)
    )
    s.on('error', reject)
  })

  const path = (u.pathname || '/') + (u.search || '')
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: ${u.host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`
  )

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS handshake timeout')), 10000)
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      clearTimeout(t)
      socket.off('data', onData)
      const head = buf.subarray(0, idx).toString('utf8')
      if (!head.includes('101')) {
        reject(new Error(`WS handshake failed: ${head.split('\r\n')[0]}`))
        return
      }
      // Keep leftover as first WS bytes
      ;(socket as Socket & { __wsLeft?: Buffer }).__wsLeft = buf.subarray(idx + 4)
      resolve()
    }
    socket.on('data', onData)
  })

  let nextId = 1
  let recvBuf = (socket as Socket & { __wsLeft?: Buffer }).__wsLeft ?? Buffer.alloc(0)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const feed = (chunk: Buffer): void => {
    recvBuf = Buffer.concat([recvBuf, chunk])
    while (recvBuf.length >= 2) {
      const b0 = recvBuf[0]
      const b1 = recvBuf[1]
      const opcode = b0 & 0xf
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (recvBuf.length < 4) return
        len = recvBuf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (recvBuf.length < 10) return
        len = Number(recvBuf.readBigUInt64BE(2))
        off = 10
      }
      const maskLen = masked ? 4 : 0
      if (recvBuf.length < off + maskLen + len) return
      let payload = recvBuf.subarray(off + maskLen, off + maskLen + len)
      if (masked) {
        const mask = recvBuf.subarray(off, off + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      recvBuf = recvBuf.subarray(off + maskLen + len)
      if (opcode === 0x1) {
        try {
          const msg = JSON.parse(payload.toString('utf8')) as {
            id?: number
            result?: unknown
            error?: { message: string }
          }
          if (msg.id != null && pending.has(msg.id)) {
            const p = pending.get(msg.id)!
            pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message))
            else p.resolve(msg.result)
          }
        } catch {
          /* ignore */
        }
      } else if (opcode === 0x8) {
        socket.end()
      }
    }
  }
  socket.on('data', feed)

  const sendFrame = (text: string): void => {
    const data = Buffer.from(text, 'utf8')
    const mask = randomBytes(4)
    const masked = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
    let header: Buffer
    if (data.length < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x81
      header[1] = 0x80 | data.length
    } else if (data.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(data.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(data.length), 2)
    }
    socket.write(Buffer.concat([header, mask, masked]))
  }

  const id = nextId++
  const result = await new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    sendFrame(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }
    }, 12000)
  })

  socket.end()
  return result
}

/** Reuse a still-running login Chrome (same Google session — no re-typing password). */
async function tryReuseChrome(): Promise<boolean> {
  const tryPort = async (port: number, proc: ChildProcess | null): Promise<boolean> => {
    try {
      await waitForDebugger(port, 2500)
      active = {
        port,
        proc,
        userDataDir: chromeProfileDir(),
        navigatedToService: false,
        serviceUrl: active?.serviceUrl || ''
      }
      savePort(port)
      console.log(`[vox-internum:chrome-cdp] reusing Chrome :${port}`)
      return true
    } catch {
      return false
    }
  }

  if (active) {
    if (await tryPort(active.port, active.proc)) return true
    active = null
  }

  const saved = readSavedPort()
  if (saved != null && (await tryPort(saved, null))) return true
  return false
}

export async function startChromeGoogleLogin(): Promise<{ ok: boolean; error?: string }> {
  // Keep Google session: do NOT kill an already-running login Chrome.
  if (await tryReuseChrome()) {
    return { ok: true }
  }

  const bin = whichChrome()
  if (!bin) return { ok: false, error: 'Chrome/Chromium not found' }

  const port = await findFreePort()
  const userDataDir = chromeProfileDir()
  mkdirSync(userDataDir, { recursive: true })

  // Vox launcher often sets ALL_PROXY=socks5://127.0.0.1:7890. Login Chrome
  // inherits that and then MiniMax / Google OAuth hang or blank — while
  // Firefox (no ALL_PROXY) loads fine. Force direct for this window.
  const childEnv = { ...process.env }
  for (const k of [
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'FTP_PROXY',
    'ftp_proxy',
    'SOCKS_PROXY',
    'socks_proxy',
    'TELEGRAM_PROXY_URL'
  ]) {
    delete childEnv[k]
  }
  childEnv['NO_PROXY'] = '*'
  childEnv['no_proxy'] = '*'

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-features=Translate,MediaRouter',
    'https://accounts.google.com/'
  ]
  const ipv4Rules = buildIpv4HostResolverRules()
  if (ipv4Rules) chromeArgs.splice(chromeArgs.length - 1, 0, `--host-resolver-rules=${ipv4Rules}`)

  const proc = spawn(bin, chromeArgs, { detached: true, stdio: 'ignore', env: childEnv })
  proc.unref()
  active = { port, proc, userDataDir, navigatedToService: false, serviceUrl: '' }
  savePort(port)

  try {
    await waitForDebugger(port)
  } catch (e) {
    // Profile may already be locked by a previous Chrome — try attach via saved/old ports.
    if (await tryReuseChrome()) return { ok: true }
    stopChromeGoogleLogin()
    return { ok: false, error: (e as Error).message }
  }

  console.log(`[vox-internum:chrome-cdp] persistent Chrome :${port} (${userDataDir})`)
  return { ok: true }
}

/** Close the login Chrome window. Profile (Google login) is KEPT on disk. */
export function stopChromeGoogleLogin(): void {
  if (!active) {
    clearSavedPort()
    return
  }
  const sess = active
  active = null
  clearSavedPort()
  try {
    if (sess.proc?.pid) {
      try {
        process.kill(-sess.proc.pid, 'SIGTERM')
      } catch {
        try {
          process.kill(sess.proc.pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  // Do NOT delete chrome-login-profile — that is the whole point (remember Google).
}

export function isChromeGoogleLoginRunning(): boolean {
  return active !== null
}

function getChromeSession(): ChromeSession | null {
  return active
}

interface CdpCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expires?: number
  sameSite?: string
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

function isGoogleAuthDomain(domain: string | undefined): boolean {
  const d = (domain || '').replace(/^\./, '').toLowerCase()
  return (
    d === 'google.com' ||
    d.endsWith('.google.com') ||
    d === 'youtube.com' ||
    d.endsWith('.youtube.com') ||
    d === 'googleapis.com' ||
    d.endsWith('.googleapis.com') ||
    d === 'gstatic.com' ||
    d.endsWith('.gstatic.com')
  )
}

async function chromeActivePage(
  port: number
): Promise<{ url: string; ws?: string }> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string
    url?: string
    webSocketDebuggerUrl?: string
  }>
  const page =
    list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('chrome')) ||
    list.find((t) => t.type === 'page')
  return { url: page?.url || '', ws: page?.webSocketDebuggerUrl }
}

async function readChromeWebStorage(pageWs: string): Promise<{ local: Record<string, string>; session: Record<string, string> }> {
  const expr = `(() => {
    const local = {}, session = {};
    try { for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (k != null) local[k] = localStorage.getItem(k) || '';
    }} catch(e) {}
    try { for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i); if (k != null) session[k] = sessionStorage.getItem(k) || '';
    }} catch(e) {}
    return { local, session };
  })()`
  const res = (await cdpCall(pageWs, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: false
  })) as { result?: { value?: { local?: Record<string, string>; session?: Record<string, string> } } }
  return {
    local: res.result?.value?.local || {},
    session: res.result?.value?.session || {}
  }
}

/** Match cookies belonging to the AI site (kimi.com, z.ai, …). */
function isServiceDomain(domain: string | undefined, serviceUrl: string): boolean {
  if (!serviceUrl || !domain) return false
  let host = ''
  try {
    host = new URL(serviceUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  const d = domain.replace(/^\./, '').toLowerCase()
  const parts = host.split('.').filter(Boolean)
  const root = parts.length >= 2 ? parts.slice(-2).join('.') : host
  // Known sibling auth domains for AI providers.
  const extras: string[] = []
  if (root === 'kimi.com' || host.includes('kimi')) {
    extras.push('moonshot.cn', 'kimi.moonshot.cn', 'www.kimi.com')
  }
  if (root === 'z.ai' || host.includes('z.ai')) {
    extras.push('chat.z.ai', 'zhipuai.cn')
  }
  if (root === 'minimax.io' || host.includes('minimax')) {
    extras.push(
      'minimaxi.com',
      'hailuoai.com',
      'platform.minimax.io',
      'platform.minimaxi.com',
      'account.minimax.io',
      'account.minimaxi.com',
      'api.minimax.io',
      'api.minimaxi.com'
    )
  }
  if (root === 'qwen.ai' || host.includes('qwen')) {
    extras.push('tongyi.com', 'aliyun.com')
  }
  return (
    d === host ||
    d === root ||
    d.endsWith('.' + root) ||
    extras.some((e) => d === e || d.endsWith('.' + e))
  )
}

async function cdpGetAllCookies(wsUrl: string, port: number): Promise<CdpCookie[]> {
  try {
    await cdpCall(wsUrl, 'Network.enable')
  } catch {
    /* ok */
  }
  try {
    const res = (await cdpCall(wsUrl, 'Network.getAllCookies')) as { cookies?: CdpCookie[] }
    return res.cookies ?? []
  } catch (e) {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string
      webSocketDebuggerUrl?: string
    }>
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!page?.webSocketDebuggerUrl) throw e
    const res = (await cdpCall(page.webSocketDebuggerUrl, 'Network.getAllCookies')) as {
      cookies?: CdpCookie[]
    }
    return res.cookies ?? []
  }
}

async function resolveCdpWs(port: number): Promise<string> {
  const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string
  }
  if (!ver.webSocketDebuggerUrl) throw new Error('no debugger URL')
  let wsUrl = ver.webSocketDebuggerUrl
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string
    url?: string
    webSocketDebuggerUrl?: string
  }>
  const browserTarget = list.find((t) => t.type === 'browser' && t.webSocketDebuggerUrl)
  const page =
    list.find((t) => t.type === 'page' && (t.url || '').includes('google')) ||
    list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (browserTarget?.webSocketDebuggerUrl) wsUrl = browserTarget.webSocketDebuggerUrl
  else if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl
  return wsUrl
}

async function navigateChromeTo(port: number, url: string): Promise<void> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string
    webSocketDebuggerUrl?: string
  }>
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const ws = page?.webSocketDebuggerUrl || (await resolveCdpWs(port))
  try {
    await cdpCall(ws, 'Page.enable')
  } catch {
    /* ok */
  }
  await cdpCall(ws, 'Page.navigate', { url })
}

function toFullCookies(cookies: CdpCookie[]): FullCookie[] {
  const full: FullCookie[] = []
  const seen = new Set<string>()
  for (const c of cookies) {
    if (!c.value || !c.name) continue
    const key = `${c.domain}|${c.name}`
    if (seen.has(key)) continue
    seen.add(key)
    full.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expires: c.expires,
      sameSite: c.sameSite
    })
  }
  return full
}

export interface PullOpts {
  serviceUrl?: string
  serviceId?: string
}

function authishName(name: string): boolean {
  return /token|auth|session|access|refresh|jwt|userid|user_id|login|account|bearer|credential|oauth/i.test(
    name
  )
}

/** True only when the AI site actually has a login session — not mere tracking cookies. */
function looksLoggedIntoSite(
  siteCookies: FullCookie[],
  storage: { local: Record<string, string>; session: Record<string, string> },
  pageHost: string,
  pageUrl: string,
  serviceUrl: string
): boolean {
  if (!serviceUrl) return false
  // Mid Google OAuth / consent — never treat as done.
  if (
    pageHost.includes('accounts.google.com') ||
    pageUrl.includes('oauth') ||
    pageUrl.includes('openid') ||
    pageUrl.includes('ServiceLogin')
  ) {
    return false
  }
  if (!pageHost || !isServiceDomain(pageHost, serviceUrl)) return false

  const storageEntries = [
    ...Object.entries(storage.local),
    ...Object.entries(storage.session)
  ]
  const authStorage = storageEntries.filter(
    ([k, v]) =>
      authishName(k) ||
      (typeof v === 'string' && v.length > 40 && (v.startsWith('eyJ') || v.startsWith('{') || v.startsWith('[')))
  )
  const authCookies = siteCookies.filter(
    (c) => authishName(c.name) && (c.value || '').length > 8
  )
  // Long-lived site values are a strong signal SPAs use after login.
  const longValues = storageEntries.filter(([, v]) => typeof v === 'string' && v.length >= 80)

  // Require a real auth signal — anonymous landing pages often set 1–2 cookies.
  if (authCookies.length >= 1 && (authStorage.length >= 1 || longValues.length >= 1)) return true
  if (authStorage.length >= 2) return true
  if (authCookies.length >= 2 && siteCookies.length >= 4) return true
  if (longValues.length >= 2 && siteCookies.length >= 3) return true
  return false
}

/**
 * Two-phase login (Google cookies alone do NOT log into Kimi/Z.ai):
 *   1) Sign into Google in real Chrome → first PULL (keeps Chrome open, opens AI site)
 *   2) In that Chrome click «Sign in with Google» on the AI site → wait for chat → PULL
 *      copies Google + site session cookies into Electron.
 * Chrome is NEVER closed until looksLoggedIntoSite() is true.
 */
export async function pullGoogleCookiesFromChromeCdp(
  ses: Session,
  opts: PullOpts = {}
): Promise<InjectResult> {
  const serviceUrl = (opts.serviceUrl || '').trim()

  if (!active) {
    const started = await startChromeGoogleLogin()
    if (!started.ok) {
      return { ok: false, set: 0, skipped: 0, error: started.error || 'Failed to start Chrome' }
    }
    // TS still thinks `active` is null inside this branch — re-read via helper.
    const sess = getChromeSession()
    if (sess && serviceUrl) sess.serviceUrl = serviceUrl
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error:
        'Chrome opened (Google session is remembered). 1) Sign in to Google if needed. 2) PULL → AI site. 3) Sign in with Google on the site. 4) PULL again. Chrome stays open for the next AI.'
    }
  }

  // Switching to another AI tab → open that site in the same Chrome (Google already logged in).
  if (serviceUrl && active.serviceUrl && active.serviceUrl !== serviceUrl) {
    active.navigatedToService = false
  }
  if (serviceUrl) active.serviceUrl = serviceUrl
  const targetUrl = active.serviceUrl || serviceUrl

  let wsUrl: string
  try {
    wsUrl = await resolveCdpWs(active.port)
  } catch (e) {
    return { ok: false, set: 0, skipped: 0, error: `Cannot reach Chrome CDP: ${(e as Error).message}` }
  }

  let cookies: CdpCookie[]
  try {
    cookies = await cdpGetAllCookies(wsUrl, active.port)
  } catch (e) {
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error: `CDP getAllCookies failed: ${(e as Error).message}`
    }
  }

  const all = toFullCookies(cookies)
  const google = all.filter((c) => isGoogleAuthDomain(c.domain))
  const site = targetUrl ? all.filter((c) => isServiceDomain(c.domain, targetUrl)) : []
  const have = CRITICAL.filter((n) => google.some((p) => p.name === n))

  if (have.length < 3) {
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error: `Not signed into Google yet (${have.length}/3 session cookies). Finish Google login in Chrome, then PULL again. Chrome stays open.`
    }
  }

  const page = await chromeActivePage(active.port)
  let pageHost = ''
  try {
    pageHost = page.url ? new URL(page.url).hostname : ''
  } catch {
    pageHost = ''
  }
  const onServicePage =
    !!targetUrl && !!pageHost && isServiceDomain(pageHost, targetUrl)

  let webStorage = { local: {} as Record<string, string>, session: {} as Record<string, string> }
  // Read storage from whichever page is active if it looks like the AI site
  // OR after OAuth redirect back — also try service page targets.
  if (page.ws && (onServicePage || pageHost.includes('google'))) {
    try {
      if (onServicePage) webStorage = await readChromeWebStorage(page.ws)
    } catch {
      /* ignore */
    }
  }
  if (onServicePage && page.ws && Object.keys(webStorage.local).length === 0) {
    try {
      webStorage = await readChromeWebStorage(page.ws)
    } catch {
      /* ignore */
    }
  }

  // Still on Google OAuth — keep Chrome open, do not finish.
  if (
    pageHost.includes('accounts.google.com') ||
    (page.url || '').includes('/o/oauth2') ||
    (page.url || '').includes('ServiceLogin')
  ) {
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error:
        'Google sign-in is still open in Chrome — finish consent / pick account, wait until the AI chat loads, THEN click PULL. Chrome will stay open.'
    }
  }

  const siteReady =
    !!targetUrl &&
    looksLoggedIntoSite(site, webStorage, pageHost, page.url || '', targetUrl)

  if (targetUrl && !siteReady) {
    if (!active.navigatedToService) {
      try {
        await navigateChromeTo(active.port, targetUrl)
        active.navigatedToService = true
      } catch (e) {
        return {
          ok: false,
          set: 0,
          skipped: 0,
          error: `Google OK, but failed to open AI site in Chrome: ${(e as Error).message}`
        }
      }
    }
    try {
      await injectGoogleCookiesFull(ses, google)
    } catch {
      /* ignore */
    }
    const sk = Object.keys(webStorage.local).length
    return {
      ok: false,
      set: 0,
      skipped: 0,
      error:
        `Chrome stays open. On the AI site click «Sign in with Google», wait until YOU SEE THE CHAT, then PULL. (page=${pageHost || '…'}; siteCookies=${site.length}; localKeys=${sk})`
    }
  }

  // Final: inject Google + site cookies into the active partition.
  const toInject = targetUrl
    ? all.filter((c) => isGoogleAuthDomain(c.domain) || isServiceDomain(c.domain, targetUrl))
    : google

  const result = await injectCookiesFull(ses, toInject, { requireGoogleSession: true })
  if (result.ok) {
    const storageKeys = Object.keys(webStorage.local).length + Object.keys(webStorage.session).length
    if (opts.serviceId && (storageKeys > 0 || site.length > 0)) {
      pendingWebStorage.set(opts.serviceId, {
        local: webStorage.local,
        session: webStorage.session
      })
    }
    for (const svc of SERVICES.filter((s) => s.category === 'ai' && s.id !== opts.serviceId)) {
      const other = electronSession.fromPartition(partitionFor(svc.id))
      void injectGoogleCookiesFull(other, google).catch(() => undefined)
    }
    const sig = createHash('sha256').update(have.join(',')).digest('hex').slice(0, 8)
    console.log(
      `[vox-internum:chrome-cdp] injected ${result.set} cookies (google=${google.length} site=${site.length} storage=${storageKeys} sig=${sig}) — Chrome KEPT OPEN`
    )
    // Keep Chrome + Google session for the next AI tab (no re-typing password).
    active.navigatedToService = false
  }
  return result
}

const pendingWebStorage = new Map<
  string,
  { local: Record<string, string>; session: Record<string, string> }
>()

/** Consume localStorage/sessionStorage captured from Chrome for a service. */
export function takePendingWebStorage(
  serviceId: string
): { local: Record<string, string>; session: Record<string, string> } | null {
  const v = pendingWebStorage.get(serviceId) || null
  if (v) pendingWebStorage.delete(serviceId)
  return v
}

