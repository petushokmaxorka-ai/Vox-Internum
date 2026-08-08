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
  McpApproveRequest
} from '../shared/types'
import { showGmailPanel, hideGmailPanel, wireGmailPanel } from './gmail-imap'

const api = window.electronAPI.vox

// Runtime state
let services: ServiceConfig[] = []
let activeId = ''
const unread = new Map<string, number>() // serviceId -> count
const loading = new Set<string>()        // serviceIds currently loading

// ─── Sidebar rendering ──────────────────────────────────────
function renderSidebar(): void {
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  // Remove existing service buttons + separators (keep spacer + bottom settings btn).
  sidebar.querySelectorAll('.sidebar-btn[data-service], .sidebar-separator').forEach((el) => el.remove())

  const spacer = sidebar.querySelector('.sidebar-spacer')

  // Group services by category. Render messengers first, then a
  // separator, then mail relays — mirroring the 40k "vox channels"
  // vs "astropath relay" split.
  const messengers = services.filter((s) => s.category === 'messenger')
  const mail = services.filter((s) => s.category === 'mail')

  for (const svc of messengers) {
    sidebar.insertBefore(makeServiceBtn(svc), spacer)
  }
  if (mail.length > 0) {
    sidebar.insertBefore(makeSeparator(), spacer)
    for (const svc of mail) {
      sidebar.insertBefore(makeServiceBtn(svc), spacer)
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
  if (id === activeId) return
  // Hide Gmail IMAP panel when leaving it.
  if (activeId === 'gmail') hideGmailPanel()
  const res = await api.switch(id)
  if (res.ok) {
    activeId = res.active
    refreshActive()
    // Show Gmail IMAP panel when entering it.
    if (activeId === 'gmail') void showGmailPanel()
  }
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
  renderSidebar()
  wireSettings()
  wireApproveFlow()
  wireLicense()
  wireGmailPanel()
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

void init()
