// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Renderer Logic
// ═══════════════════════════════════════════════════════════
// Builds the sidebar from the service registry, wires up clicks,
// and renders unread badges + the loading overlay.
//
// The actual messenger UIs are native WebContentsViews painted on
// top of the main-area (see main/view-manager.ts). This script only
// owns the 56px sidebar and overlays.

import type {
  ServiceConfig,
  UnreadUpdate,
  LoadingUpdate,
  ProxyMap,
  McpApproveRequest,
  UpdateInfo,
  UiTheme
} from '../shared/types'
import { showGmailPanel, hideGmailPanel, wireGmailPanel } from './gmail-imap'

const api = window.electronAPI.vox

// Runtime state
let services: ServiceConfig[] = []
let activeId = ''
const unread = new Map<string, number>() // serviceId -> count
const loading = new Set<string>()        // serviceIds currently loading
let currentTheme: UiTheme = 'light'
let pendingUpdate: UpdateInfo | null = null

// ─── Sidebar rendering ──────────────────────────────────────
function renderSidebar(): void {
  const scroll = document.getElementById('sidebar-scroll')
  if (!scroll) return

  // Rebuild service list only — footer (theme/license/settings) stays pinned.
  scroll.replaceChildren()

  // Group services by category. Render messengers first, then AI
  // chats, then mail relays — three sections in the sidebar.
  const messengers = services.filter((s) => s.category === 'messenger')
  const ai = services.filter((s) => s.category === 'ai')
  const mail = services.filter((s) => s.category === 'mail')

  for (const svc of messengers) {
    scroll.appendChild(makeServiceBtn(svc))
  }
  if (ai.length > 0) {
    scroll.appendChild(makeSeparator())
    for (const svc of ai) {
      scroll.appendChild(makeServiceBtn(svc))
    }
  }
  if (mail.length > 0) {
    scroll.appendChild(makeSeparator())
    for (const svc of mail) {
      scroll.appendChild(makeServiceBtn(svc))
    }
  }
}

function makeServiceBtn(svc: ServiceConfig): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'sidebar-btn' + (svc.id === activeId ? ' active' : '')
  btn.dataset.service = svc.id
  btn.title = svc.name
  btn.innerHTML = `<span class="label">${svc.label}</span>` + renderBadge(svc.id)
  btn.addEventListener('click', () => onServiceClick(svc.id))
  return btn
}

function makeSeparator(): HTMLDivElement {
  const sep = document.createElement('div')
  sep.className = 'sidebar-separator'
  return sep
}

function renderBadge(serviceId: string): string {
  const n = unread.get(serviceId) ?? 0
  return n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''
}

function refreshBadges(): void {
  for (const svc of services) {
    const btn = document.querySelector(`.sidebar-btn[data-service="${svc.id}"]`)
    if (!btn) continue
    const existing = btn.querySelector('.badge')
    if (existing) existing.remove()
    const n = unread.get(svc.id) ?? 0
    if (n > 0) {
      const b = document.createElement('span')
      b.className = 'badge'
      b.textContent = n > 99 ? '99+' : String(n)
      btn.appendChild(b)
    }
  }
}

function refreshActive(): void {
  document.querySelectorAll('.sidebar-btn[data-service]').forEach((el) => {
    const btn = el as HTMLButtonElement
    btn.classList.toggle('active', btn.dataset.service === activeId)
  })
}

// ─── Click handler ──────────────────────────────────────────
async function onServiceClick(id: string): Promise<void> {
  const target = services.find((s) => s.id === id)
  // Re-click external → reopen system browser (main.switch also does this).
  if (id === activeId) {
    if (target?.kind === 'external' && target.url) {
      await api.switch(id)
    }
    return
  }
  // Hide panels when leaving.
  if (activeId === 'gmail') hideGmailPanel()
  hideExternalPanel()
  const res = await api.switch(id)
  if (res.ok) {
    activeId = res.active
    refreshActive()
    if (activeId === 'gmail') void showGmailPanel()
    showExternalPanelIfNeeded(activeId)
  }
}

function hideExternalPanel(): void {
  document.getElementById('external-panel')?.classList.add('hidden')
}

function showExternalPanelIfNeeded(serviceId: string): void {
  const svc = services.find((s) => s.id === serviceId)
  if (svc?.kind !== 'external') {
    hideExternalPanel()
    return
  }
  const panel = document.getElementById('external-panel')
  const title = document.getElementById('external-panel-title')
  const urlEl = document.getElementById('external-panel-url')
  if (title) title.textContent = `◆ ${svc.name.toUpperCase()} · EXTERNAL`
  if (urlEl) urlEl.textContent = svc.url
  panel?.classList.remove('hidden')
}

function wireExternalPanel(): void {
  document.getElementById('external-open-btn')?.addEventListener('click', () => {
    const svc = services.find((s) => s.id === activeId)
    if (svc?.kind === 'external' && svc.url) {
      void api.openExternalLink(svc.url)
    }
  })
}

// ─── Loading overlay ────────────────────────────────────────
function refreshLoading(): void {
  const overlay = document.getElementById('loading-overlay')
  const sub = document.getElementById('loading-service')
  if (!overlay) return
  const activeIsLoading = loading.has(activeId)
  overlay.classList.toggle('hidden', !activeIsLoading)
  if (activeIsLoading && sub) {
    const svc = services.find((s) => s.id === activeId)
    sub.textContent = svc ? svc.name.toUpperCase() : '...'
  }
}

// ─── Push event wiring ──────────────────────────────────────
api.onUnread((u: UnreadUpdate): void => {
  unread.set(u.service, u.count)
  refreshBadges()
})

api.onLoading((l: LoadingUpdate): void => {
  if (l.loading) loading.add(l.service)
  else loading.delete(l.service)
  refreshLoading()
})

// ─── Init ───────────────────────────────────────────────────
async function init(): Promise<void> {
  services = await api.getServices()
  activeId = await api.getActive()
  await initTheme()
  renderSidebar()
  wireSettings()
  wireApproveFlow()
  wireLicense()
  wireGmailPanel()
  wireExternalPanel()
  wireCookieImport()
  wireTheme()
  wireUpdateBanner()
  if (activeId === 'gmail') void showGmailPanel()
  showExternalPanelIfNeeded(activeId)
}

async function initTheme(): Promise<void> {
  try {
    currentTheme = await api.getTheme()
  } catch {
    currentTheme = 'light'
  }
  applyTheme(currentTheme)
}

function applyTheme(theme: UiTheme): void {
  currentTheme = theme
  document.documentElement.setAttribute('data-theme', theme)
  const mark = document.getElementById('theme-mark')
  // ASCII labels — emoji sun/moon often invisible/clipped in sidebar fonts.
  if (mark) mark.textContent = theme === 'light' ? 'SOL' : 'NOX'
  const btn = document.getElementById('btn-theme')
  if (btn) btn.title = theme === 'light' ? 'THEME — SWITCH TO DARK (NOX)' : 'THEME — SWITCH TO LIGHT (SOL)'
}

function wireTheme(): void {
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    void (async () => {
      const next: UiTheme = currentTheme === 'light' ? 'dark' : 'light'
      const res = await api.setTheme(next)
      if (res.ok) applyTheme(res.theme)
    })()
  })
}

function showUpdateBanner(info: UpdateInfo): void {
  pendingUpdate = info
  const banner = document.getElementById('update-banner')
  const text = document.getElementById('update-banner-text')
  if (text) {
    text.textContent = info.readyToInstall
      ? `◆ UPDATE ${info.currentVersion} → ${info.latestVersion} DOWNLOADED  ·  RESTART TO APPLY`
      : `◆ UPDATE ${info.currentVersion} → ${info.latestVersion}  ·  ${info.releaseName || 'NEW RELEASE'}`
  }
  // Tier 1 (downloaded) → RESTART & UPDATE; Tier 2 → open release page.
  document.getElementById('update-install')?.classList.toggle('hidden', !info.readyToInstall)
  document.getElementById('update-open')?.classList.toggle('hidden', Boolean(info.readyToInstall))
  banner?.classList.remove('hidden')
}

function hideUpdateBanner(): void {
  document.getElementById('update-banner')?.classList.add('hidden')
}

function wireUpdateBanner(): void {
  api.onUpdateAvailable((info) => {
    if (info.available) showUpdateBanner(info)
  })
  document.getElementById('update-open')?.addEventListener('click', () => {
    if (pendingUpdate?.releaseUrl) void api.openUpdate(pendingUpdate.releaseUrl)
  })
  document.getElementById('update-install')?.addEventListener('click', () => {
    void api.installUpdate()
  })
  document.getElementById('update-dismiss')?.addEventListener('click', () => {
    if (pendingUpdate?.latestVersion && !pendingUpdate.readyToInstall) {
      void api.dismissUpdate(pendingUpdate.latestVersion)
    }
    hideUpdateBanner()
  })
  // Manual check once after init (in addition to main's scheduled push).
  void api.checkUpdate().then((info) => {
    if (info.available) showUpdateBanner(info)
  })
}

// ─── Settings modal (Smart Proxy) ───────────────────────────
// NOTE: when opening, main process hides the active WebContentsView
// (it paints over HTML). On close, it's restored. We just toggle the
// overlay class + tell main to hide/show via a side-effect of switch.

let proxyCache: ProxyMap = {}

async function openSettings(): Promise<void> {
  proxyCache = await api.getProxies()
  renderProxyRows()
  // Hide the active WebContentsView so our modal isn't covered.
  await api.hideActiveView()
  const overlay = document.getElementById('settings-overlay')
  overlay?.classList.remove('hidden')
}

async function closeSettings(): Promise<void> {
  document.getElementById('settings-overlay')?.classList.add('hidden')
  // Restore the active view.
  await api.showActiveView()
}

function renderProxyRows(): void {
  const container = document.getElementById('proxy-rows')
  if (!container) return
  container.innerHTML = ''
  for (const svc of services) {
    const cfg = proxyCache[svc.id] ?? { service: svc.id, url: '' }
    const trimmed = (cfg.url || '').trim()
    const isProxy = Boolean(trimmed && trimmed.toLowerCase() !== 'direct://')
    const isDirect = trimmed.toLowerCase() === 'direct://'
    // Three badge states:
    //   PROXY   → user supplied a URL (socks5://...)
    //   SYSTEM  → empty: backend resolves env proxy (HTTP_PROXY/ALL_PROXY)
    //   DIRECT  → explicit 'direct://': no proxy at all
    const modeLabel = isProxy ? '◆ PROXY' : isDirect ? '◆ DIRECT' : '◆ SYSTEM'
    const modeClass = isProxy ? 'proxy' : isDirect ? 'direct' : 'system'

    const row = document.createElement('div')
    row.className = 'proxy-row'
    row.innerHTML = `
      <div class="proxy-row-head">
        <span class="proxy-row-label">${svc.name}</span>
        <span class="proxy-row-mode ${modeClass}">${modeLabel}</span>
      </div>
      <input type="text" class="proxy-input" data-service="${svc.id}"
             value="${cfg.url.replace(/"/g, '&quot;')}"
             placeholder="socks5://[user:pass@]host:port — leave empty for SYSTEM" autocomplete="off" />
      <div class="proxy-actions">
        <button class="modal-btn modal-btn-green" data-action="save" data-service="${svc.id}">◆ SAVE &amp; APPLY</button>
        <button class="modal-btn" data-action="system" data-service="${svc.id}">⚙ SYSTEM</button>
        <button class="modal-btn" data-action="direct" data-service="${svc.id}">✗ DIRECT</button>
      </div>
    `
    container.appendChild(row)
  }

  // Wire buttons.
  container.querySelectorAll('.modal-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLButtonElement
      const sid = target.dataset.service
      const action = target.dataset.action
      if (sid && action) void onProxyAction(sid, action)
    })
  })
}

async function onProxyAction(serviceId: string, action: string): Promise<void> {
  const statusEl = document.getElementById('settings-status')
  const input = document.querySelector<HTMLInputElement>(`.proxy-input[data-service="${serviceId}"]`)
  if (!statusEl) return

  // Three explicit modes:
  //   save   → use the URL typed in the input
  //   system → empty URL, backend resolves HTTP_PROXY/ALL_PROXY env
  //   direct → no proxy at all (empty bypasses regional blocks too)
  let url: string
  if (action === 'save') {
    url = input?.value.trim() ?? ''
    if (!url) {
      setLicenseMsg('◆ URL REQUIRED FOR SAVE', 'err')
      return
    }
  } else if (action === 'direct') {
    url = 'direct://'
  } else {
    url = '' // system
  }

  statusEl.className = 'modal-status'
  statusEl.textContent = `◆ APPLYING ${serviceId.toUpperCase()}...`

  const res = await api.setProxy(serviceId, url)
  if (!res.ok) {
    statusEl.className = 'modal-status err'
    statusEl.textContent = `✗ ${res.error ?? 'FAILED'}`
    return
  }

  // Reload the service so the new route takes effect immediately.
  await api.applyAndReload(serviceId)

  // Refresh local cache + re-render to reflect new mode badge.
  proxyCache = await api.getProxies()
  renderProxyRows()
  statusEl.className = 'modal-status ok'
  const label =
    action === 'direct' ? 'DIRECT' : action === 'system' ? 'SYSTEM' : res.applied
  statusEl.textContent = `✓ ${serviceId.toUpperCase()} → ${label}`
}

function wireSettings(): void {
  const gear = document.getElementById('btn-settings')
  gear?.addEventListener('click', openSettings)
  document.getElementById('btn-close-settings')?.addEventListener('click', closeSettings)

  // Close on overlay click (outside modal).
  document.getElementById('settings-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings()
  })
}

// ─── MCP HITL approval flow ────────────────────────────────
// When an LLM client calls send_message via MCP, main pushes an
// approval request here. We show a modal with the full payload; the
// user must click APPROVE or DENY. Result echoes back to main.
let pendingApproveId: string | null = null

function wireApproveFlow(): void {
  api.onApproveRequest((req: McpApproveRequest): void => {
    showApproveModal(req)
  })
  document.getElementById('btn-approve-yes')?.addEventListener('click', () => answerApproval(true))
  document.getElementById('btn-approve-no')?.addEventListener('click', () => answerApproval(false))
}

async function showApproveModal(req: McpApproveRequest): Promise<void> {
  // If a previous prompt is still pending, deny it implicitly — we
  // only show one at a time.
  if (pendingApproveId) {
    await api.approveResponse(pendingApproveId, false)
  }
  pendingApproveId = req.id
  const svcName = services.find((s) => s.id === req.service)?.name ?? req.service
  ;(document.getElementById('approve-action') as HTMLElement).textContent = req.action
  ;(document.getElementById('approve-service') as HTMLElement).textContent = svcName
  ;(document.getElementById('approve-summary') as HTMLElement).textContent = req.summary
  document.getElementById('approve-overlay')?.classList.remove('hidden')
  await api.hideActiveView()
}

async function answerApproval(approved: boolean): Promise<void> {
  if (!pendingApproveId) return
  const id = pendingApproveId
  pendingApproveId = null
  document.getElementById('approve-overlay')?.classList.add('hidden')
  await api.approveResponse(id, approved)
  await api.showActiveView()
}

// ─── License ────────────────────────────────────────────────
async function refreshLicenseBadge(): Promise<void> {
  const state = await api.getLicenseState()
  const mark = document.getElementById('license-mark')
  if (mark) {
    mark.className = `license-badge ${state.tier}`
    mark.textContent = state.tier === 'licensed' ? '✓' : '◆'
  }
  // Also reflect into the modal if open.
  const statusEl = document.getElementById('license-status')
  if (statusEl) statusEl.textContent = state.statusText
}

function wireLicense(): void {
  document.getElementById('btn-license')?.addEventListener('click', openLicenseModal)
  document.getElementById('btn-license-close')?.addEventListener('click', closeLicenseModal)
  document.getElementById('btn-license-activate')?.addEventListener('click', onActivate)
  document.getElementById('btn-license-forget')?.addEventListener('click', onForget)
  document.getElementById('license-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLicenseModal()
  })
  // Initial badge paint (async, non-blocking).
  void refreshLicenseBadge()
}

async function openLicenseModal(): Promise<void> {
  document.getElementById('license-overlay')?.classList.remove('hidden')
  await api.hideActiveView()
  await refreshLicenseBadge()
  ;(document.getElementById('license-key-input') as HTMLInputElement)?.focus()
}

async function closeLicenseModal(): Promise<void> {
  document.getElementById('license-overlay')?.classList.add('hidden')
  await api.showActiveView()
}

function setLicenseMsg(text: string, type: 'ok' | 'err' | ''): void {
  const el = document.getElementById('license-msg')
  if (!el) return
  el.className = 'modal-status' + (type ? ' ' + type : '')
  el.textContent = text
}

async function onActivate(): Promise<void> {
  const input = document.getElementById('license-key-input') as HTMLInputElement
  const key = (input?.value || '').trim()
  if (!key) {
    setLicenseMsg('◆ KEY REQUIRED', 'err')
    return
  }
  setLicenseMsg('◆ ACTIVATING…', '')
  const res = await api.activateLicense(key)
  if (res.ok && res.state) {
    setLicenseMsg('✓ ACTIVATED', 'ok')
    if (input) input.value = ''
    await refreshLicenseBadge()
  } else {
    setLicenseMsg('✗ ' + (res.error || 'FAILED'), 'err')
  }
}

async function onForget(): Promise<void> {
  setLicenseMsg('◆ CLEARING…', '')
  await api.forgetLicense()
  await refreshLicenseBadge()
  setLicenseMsg('✓ TOKEN FORGOTTEN — TRIAL RESUMED', 'ok')
}

// ─── Cookie import (Google OAuth bypass) ────────────────────
function wireCookieImport(): void {
  window.electronAPI.vox.onOpenCookieImport(() => {
    document.getElementById('cookie-overlay')?.classList.remove('hidden')
    void window.electronAPI.vox.hideActiveView()
  })
  window.electronAPI.vox.onCookieStatus?.((msg) => {
    const status = document.getElementById('cookie-status')
    if (!status) return
    status.className = msg.ok ? 'modal-status ok' : 'modal-status err'
    status.textContent = (msg.ok ? '✓ ' : '✗ ') + msg.message
  })
  document.getElementById('cookie-close')?.addEventListener('click', async () => {
    document.getElementById('cookie-overlay')?.classList.add('hidden')
    await window.electronAPI.vox.showActiveView()
  })

  document.getElementById('cookie-popup')?.addEventListener('click', async () => {
    const status = document.getElementById('cookie-status')
    if (status) { status.className = 'modal-status'; status.textContent = '◆ OPENING ELECTRON POPUP (often blocked)…' }
    await window.electronAPI.vox.openGoogleSignInPopup()
    if (status) {
      status.className = 'modal-status err'
      status.textContent = '⚠ IF GOOGLE SAYS «NOT SECURE» — USE OPEN REAL CHROME INSTEAD'
    }
  })

  document.getElementById('cookie-open-chrome')?.addEventListener('click', async () => {
    const status = document.getElementById('cookie-status')
    if (status) {
      status.className = 'modal-status'
      status.textContent = '◆ STARTING REAL CHROME…'
    }
    const res = await window.electronAPI.vox.openChromeGoogleLogin()
    if (res.ok) {
      if (status) {
        status.className = 'modal-status ok'
        status.textContent = '✓ CHROME OPEN — SIGN IN, THEN CLICK PULL COOKIES'
      }
    } else if (status) {
      status.className = 'modal-status err'
      status.textContent = '✗ ' + (res.error || 'FAILED TO START CHROME')
    }
  })

  // Pull via CDP from temp Chrome (primary) — button id cookie-auto
  document.getElementById('cookie-auto')?.addEventListener('click', async () => {
    const status = document.getElementById('cookie-status')
    if (status) { status.className = 'modal-status'; status.textContent = '◆ PULLING COOKIES FROM CHROME (CDP)…' }
    const res = await window.electronAPI.vox.pullChromeCdpCookies()
    if (res.ok && (res.set ?? 0) > 0) {
      if (status) {
        status.className = 'modal-status ok'
        status.textContent = `✓ ${res.set} COOKIES — SITE LOGGED IN. Chrome stays open for the next AI.`
      }
      document.getElementById('cookie-overlay')?.classList.add('hidden')
      await window.electronAPI.vox.showActiveView()
    } else {
      if (status) { status.className = 'modal-status err'; status.textContent = '✗ ' + (res.error || 'PULL FAILED') }
    }
  })

  document.getElementById('cookie-stop-chrome')?.addEventListener('click', async () => {
    const status = document.getElementById('cookie-status')
    await window.electronAPI.vox.stopChromeGoogleLogin()
    if (status) {
      status.className = 'modal-status ok'
      status.textContent = '✓ LOGIN CHROME CLOSED (Google account kept on disk for next time)'
    }
  })

  document.getElementById('cookie-inject')?.addEventListener('click', async () => {
    const ta = document.getElementById('cookie-input') as HTMLTextAreaElement
    const raw = (ta?.value || '').trim()
    const status = document.getElementById('cookie-status')
    if (!raw) {
      if (status) { status.className = 'modal-status err'; status.textContent = '◆ PASTE COOKIES FIRST' }
      return
    }
    // Names may include dashes (__Secure-1PSID). Values may contain '='.
    const pairs: Array<{ name: string; value: string }> = []
    const seen = new Set<string>()
    const push = (name: string, value: string): void => {
      const n = name.trim()
      const v = value.trim()
      if (!n || !v || !/^[\w.-]+$/.test(n) || seen.has(n)) return
      seen.add(n)
      pairs.push({ name: n, value: v })
    }
    if (!raw.includes('\n') && raw.includes(';') && raw.includes('=')) {
      for (const part of raw.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0) push(part.slice(0, eq), part.slice(eq + 1))
      }
    } else {
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        if (t.includes('\t')) {
          const cols = t.split('\t')
          if (cols.length >= 2) push(cols[0], cols[1])
          continue
        }
        const eq = t.indexOf('=')
        if (eq > 0) push(t.slice(0, eq), t.slice(eq + 1))
      }
    }
    if (pairs.length === 0) {
      if (status) {
        status.className = 'modal-status err'
        status.textContent = '◆ NO NAME=VALUE PAIRS (use SID=… lines; __Secure-* names OK)'
      }
      return
    }
    if (status) { status.className = 'modal-status'; status.textContent = `◆ INJECTING ${pairs.length} COOKIES…` }
    const res = await window.electronAPI.vox.importGoogleCookies(pairs)
    if (res.ok && (res.set ?? 0) > 0) {
      if (status) {
        status.className = 'modal-status ok'
        status.textContent = `✓ ${res.set} COOKIES INJECTED — RELOADING`
      }
      document.getElementById('cookie-overlay')?.classList.add('hidden')
      await window.electronAPI.vox.showActiveView()
    } else {
      if (status) {
        status.className = 'modal-status err'
        status.textContent = '✗ ' + (res.error || (res.set === 0 ? '0 cookies set — check paste format' : 'FAILED'))
      }
    }
  })
}

void init()
