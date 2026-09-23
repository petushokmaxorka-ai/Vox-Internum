// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Main Process Entry
// ═══════════════════════════════════════════════════════════
// Dark Mechanicus messenger aggregator. Hosts one WebContentsView per
// service (Telegram, VK, MAX), each in an isolated session partition.
//
// AGENTS.md compliance:
//   §3.2 — no subprocess execution anywhere in this app.
//   §3.4 — electron-store writes only to app.getPath('userData').
//   §3.7 — contextIsolation:true, sandbox:true, nodeIntegration:false.

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '../shared/types'
import type { SetProxyResult, McpApproveRequest } from '../shared/types'
import { SERVICES, DEFAULT_SERVICE, findService } from './services'
import { ViewManager } from './view-manager'
import { getLastActiveService, setLastActiveService, getProxies, setProxy, getTheme, setTheme } from './storage'
import { parseProxy, applyProxy, applySystemProxy } from './session-router'
import { startMcpServer, createApproval, resolveApproval } from './mcp/server'
import { getLicenseState, activateLicense, forgetLicense } from './license'
import {
  isGmailConfigured,
  disconnectGmail,
  fetchInboxPage,
  fetchMessage,
  sendGmailMessage
} from './imap/manager'
import { setGmailAccount, clearGmailAccount } from './imap/accounts'
import { applyIpv4HostResolverRules } from './ipv4-hosts'
import {
  checkForUpdate,
  dismissUpdate,
  openUpdatePage,
  installUpdate,
  scheduleUpdateCheck
} from './updater'

// GPU policy:
//   Linux  → hardware GPU (SwiftShader freezes TG fast-scroll).
//   Windows → software GPU by default (hardware + ignore-gpu-blocklist
//             crashed portable/NSIS builds with the generic Electron
//             error dialog after a brief flash). Opt in: VOX_ENABLE_GPU=1.
//   Override off anywhere: VOX_DISABLE_GPU=1.
const wantGpu =
  process.env.VOX_DISABLE_GPU !== '1' &&
  (process.platform !== 'win32' || process.env.VOX_ENABLE_GPU === '1')
if (!wantGpu) {
  app.disableHardwareAcceleration()
  console.log(`[vox-internum] GPU disabled (${process.platform})`)
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  console.log('[vox-internum] GPU enabled')
}

// MiniMax (Akamai) AAAA is blackholed here — force A records or Chromium hangs.
applyIpv4HostResolverRules()

// Telegram Web voice notes + notification sounds: Chromium's default
// autoplay policy + AudioServiceSandbox often yield silent <audio>/WebAudio
// under Electron on Linux (Pulse/PipeWire). Allow autoplay without a prior
// gesture and run the audio service unsandboxed so it can reach the sink.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox')

// ─── Anti-automation defeat (Gmail sign-in bypass) ─────────
// Google's "This browser or app may not be secure" screen detects
// Electron/Chromium automation via Blink's AutomationControlled
// feature flag, which sets navigator.webdriver=true at the engine
// level (not patchable via JS — Google checks the descriptor).
// Disabling the Blink feature makes our embedded Chromium look like
// a regular Chrome tab to Google's anti-bot heuristics. We also
// remove the --enable-automation switch Electron inherits.
//
// This is the same technique Ferdium/Rambox use for Gmail web auth.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
app.commandLine.removeSwitch('enable-automation')

// NOTE: nativeTheme.themeSource left at 'system' default. Forcing
// 'dark' broke mail.ru's post-login SPA (its dark-mode CSS path
// hides inbox content). Users can toggle dark mode per-service in
// the service's own settings (TG: Settings → Chat Settings → Night).

// ─── Single instance ────────────────────────────────────────
// Prevents two Vox Internum windows from running at once (which
// would also cause EADDRINUSE on the MCP port 9751). If a second
// instance starts, it quits and focuses the first.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance owns the lock; bail out immediately.
  app.quit()
}
app.on('second-instance', () => {
  // User tried to launch again — focus the existing window instead.
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) {
    const w = wins[0]
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
})

const manager = new ViewManager()

// Surface real crash reasons instead of a blank "Electron" dialog.
process.on('uncaughtException', (err) => {
  console.error('[vox-internum] uncaughtException', err)
  try {
    dialog.showErrorBox('Vox Internum crashed', err?.stack || String(err))
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (reason) => {
  console.error('[vox-internum] unhandledRejection', reason)
})

/** Resolve the branded launcher icon (repo build/ → packaged resources/). */
function appIconPath(): string | null {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(process.resourcesPath ?? '', 'build/icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

function loadAppIcon(size?: number): Electron.NativeImage {
  const path = appIconPath()
  if (!path) return nativeImage.createEmpty()
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) return img
  return size ? img.resize({ width: size, height: size }) : img
}

// ─── IPC ────────────────────────────────────────────────────
function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.VOX_GET_SERVICES, () => SERVICES)
  ipcMain.handle(IPC_CHANNELS.VOX_GET_ACTIVE, () => manager.getActive())
  ipcMain.handle(IPC_CHANNELS.VOX_SWITCH, (_e, id: string) => {
    if (!findService(id)) return { ok: false, active: manager.getActive() }
    manager.switch(id)
    setLastActiveService(id)
    return { ok: true, active: id }
  })

  // Smart Proxy
  ipcMain.handle(IPC_CHANNELS.VOX_GET_PROXIES, () => getProxies())
  ipcMain.handle(IPC_CHANNELS.VOX_SET_PROXY, async (_e, serviceId: string, url: string): Promise<SetProxyResult> => {
    if (!findService(serviceId)) {
      return { ok: false, applied: '', error: 'unknown service' }
    }
    try {
      const trimmed = (url || '').trim()
      const lower = trimmed.toLowerCase()
      // Empty → system proxy (messengers). Explicit direct:// → DIRECT
      // (must NOT fall through to ALL_PROXY — that breaks AI/mail).
      let applied: string
      if (lower === 'direct://' || lower === 'direct') {
        applied = await applyProxy(serviceId, parseProxy('direct://'))
      } else if (trimmed) {
        const parsed = parseProxy(trimmed)
        applied = await applyProxy(serviceId, parsed)
      } else {
        applied = await applySystemProxy(serviceId)
      }
      // Persist the RAW url (preserves user input normalization-independent).
      setProxy(serviceId, url)
      return { ok: true, applied }
    } catch (e) {
      return { ok: false, applied: '', error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC_CHANNELS.VOX_APPLY_AND_RELOAD, async (_e, serviceId: string): Promise<{ ok: boolean }> => {
    if (!findService(serviceId)) return { ok: false }
    const storedUrl = getProxies()[serviceId]?.url ?? ''
    const trimmed = storedUrl.trim()
    const lower = trimmed.toLowerCase()
    if (lower === 'direct://' || lower === 'direct') {
      await applyProxy(serviceId, parseProxy('direct://'))
    } else if (trimmed) {
      await applyProxy(serviceId, parseProxy(trimmed))
    } else {
      await applySystemProxy(serviceId)
    }
    manager.reloadService(serviceId)
    return { ok: true }
  })

  // View visibility — lets renderer show an HTML overlay above the
  // otherwise-on-top WebContentsView.
  ipcMain.handle(IPC_CHANNELS.VOX_HIDE_ACTIVE_VIEW, () => {
    manager.hideActiveView()
    return { ok: true }
  })
  ipcMain.handle(IPC_CHANNELS.VOX_SHOW_ACTIVE_VIEW, () => {
    manager.showActiveView()
    return { ok: true }
  })

  // Theme (chrome only — never force nativeTheme on embedded messengers)
  ipcMain.handle(IPC_CHANNELS.VOX_GET_THEME, () => getTheme())
  ipcMain.handle(IPC_CHANNELS.VOX_SET_THEME, (_e, theme: string) => {
    const next = theme === 'dark' ? 'dark' : 'light'
    setTheme(next)
    return { ok: true, theme: next }
  })

  // Updates (GitHub Releases)
  ipcMain.handle(IPC_CHANNELS.VOX_CHECK_UPDATE, () => checkForUpdate())
  ipcMain.handle(IPC_CHANNELS.VOX_DISMISS_UPDATE, (_e, version: string) => {
    dismissUpdate(String(version || ''))
    return { ok: true }
  })
  ipcMain.handle(IPC_CHANNELS.VOX_OPEN_UPDATE, async (_e, url: string) => {
    await openUpdatePage(String(url || ''))
    return { ok: true }
  })
  // Tier 1 auto-update: restart into the already-downloaded build.
  ipcMain.handle(IPC_CHANNELS.VOX_INSTALL_UPDATE, () => {
    installUpdate()
    return { ok: true }
  })

  // External links from the renderer (Gmail setup help, external
  // services). Only http(s) — never file:// or custom schemes.
  ipcMain.handle(IPC_CHANNELS.VOX_OPEN_EXTERNAL, async (_e, url: string) => {
    const target = String(url || '')
    if (!/^https?:\/\//i.test(target)) return { ok: false }
    try {
      await shell.openExternal(target)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // MCP HITL: renderer responds to an approval request.
  ipcMain.handle(
    IPC_CHANNELS.VOX_MCP_APPROVE_RESPONSE,
    (_e, payload: { id: string; approved: boolean }) => {
      resolveApproval(payload.id, payload.approved)
      return { ok: true }
    }
  )

  // Licensing
  ipcMain.handle(IPC_CHANNELS.VOX_LICENSE_GET_STATE, () => getLicenseState())
  ipcMain.handle(IPC_CHANNELS.VOX_LICENSE_ACTIVATE, (_e, key: string) =>
    activateLicense(key)
  )
  ipcMain.handle(IPC_CHANNELS.VOX_LICENSE_FORGET, () => forgetLicense())

  // DEBUG-ONLY: diagnostic snapshot of all views. Used by the
  // integration test harness. Internal channel, not in shared/types.
  ipcMain.handle('vox:diagnostic-snapshot', () => manager.snapshot())

  // Gmail IMAP — replaces the broken Gmail web-view (Google blocks
  // Electron sign-in). User configures App Password once, then we
  // connect via IMAP and render inbox natively.
  ipcMain.handle(IPC_CHANNELS.VOX_GMAIL_CONFIGURED, () => isGmailConfigured())
  ipcMain.handle(IPC_CHANNELS.VOX_GMAIL_SETUP, async (_e, email: string, appPassword: string) => {
    try {
      setGmailAccount(email, appPassword)
      // Verify by connecting + fetching 1 message
      await fetchInboxPage(1, 1)
      return { ok: true }
    } catch (e) {
      // Bad creds → clear + report
      clearGmailAccount()
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC_CHANNELS.VOX_GMAIL_SIGNOUT, async () => {
    await disconnectGmail()
    clearGmailAccount()
    return { ok: true }
  })
  ipcMain.handle(IPC_CHANNELS.VOX_GMAIL_FETCH_INBOX, async (_e, page?: number) => {
    try {
      const result = await fetchInboxPage(page ?? 1, 30)
      return {
        ok: true,
        list: result.list,
        page: result.page,
        total: result.total,
        totalPages: result.totalPages
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, list: [], page: 1, total: 0, totalPages: 0 }
    }
  })
  ipcMain.handle(IPC_CHANNELS.VOX_GMAIL_FETCH_MESSAGE, async (_e, seq: number) => {
    try {
      const msg = await fetchMessage(seq)
      return { ok: true, msg }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(
    IPC_CHANNELS.VOX_GMAIL_SEND,
    async (_e, input: { to: string; subject: string; text: string; inReplyTo?: string }) => {
      return sendGmailMessage(input)
    }
  )

  // Google cookie import + normal sign-in helpers
  ipcMain.handle(
    IPC_CHANNELS.VOX_IMPORT_GOOGLE_COOKIES,
    async (_e, pairs: Array<{ name: string; value: string }>) => {
      const activeId = manager.getActive()
      const active = manager.getActiveView()
      if (!active) return { ok: false, set: 0, skipped: 0, error: 'no active view — open a service tab first' }
      const { injectGoogleCookiePairs, injectCookiesFull } = await import('./cookie-import')
      // Service-aware paste: Google session markers keep the legacy Google
      // path (AI "Sign in with Google"). Plain session cookies pasted on
      // mail.ru / Yandex must be written to that service's own domain,
      // not .google.com — otherwise the jar stays empty for e.mail.ru.
      const googleMarkers = new Set(['SID', 'HSID', 'SSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'])
      const serviceDomain =
        activeId === 'mailru' ? '.mail.ru' :
        activeId === 'yandex' ? '.yandex.ru' :
        ''
      const looksLikeGoogle = pairs.some((p) => googleMarkers.has(p.name))
      const result = serviceDomain && !looksLikeGoogle
        ? await injectCookiesFull(
            active.webContents.session,
            pairs.map((p) => ({
              name: p.name,
              value: p.value,
              domain: serviceDomain,
              path: '/',
              secure: true,
              httpOnly: false
            })),
            { requireGoogleSession: false }
          )
        : await injectGoogleCookiePairs(active.webContents.session, pairs)
      if (result.ok) {
        manager.reloadService(activeId)
      }
      return result
    }
  )

  ipcMain.handle('vox:auto-import-chrome-cookies', async () => {
    const activeId = manager.getActive()
    const active = manager.getActiveView()
    if (!active) return { ok: false, set: 0, skipped: 0, error: 'no active view — open a service tab first' }
    const { importGoogleCookiesFromBrowser } = await import('./cookie-import')
    const result = await importGoogleCookiesFromBrowser(active.webContents.session)
    if (result.ok) {
      manager.reloadService(activeId)
    }
    return result
  })

  // Top-level Google sign-in window (often blocked by Google — CDP preferred).
  ipcMain.handle('vox:open-google-signin-popup', () => {
    manager.openGoogleSignIn()
    return { ok: true }
  })

  // Real Chrome (temp profile + CDP) — the path Google actually accepts.
  ipcMain.handle('vox:open-chrome-google-login', async () => {
    const { startChromeGoogleLogin } = await import('./chrome-cdp-login')
    return startChromeGoogleLogin()
  })

  ipcMain.handle('vox:pull-chrome-cdp-cookies', async () => {
    const activeId = manager.getActive()
    const active = manager.getActiveView()
    if (!active) return { ok: false, set: 0, skipped: 0, error: 'no active view — open an AI tab first' }
    const svc = findService(activeId)
    const { pullGoogleCookiesFromChromeCdp, takePendingWebStorage } = await import('./chrome-cdp-login')
    const result = await pullGoogleCookiesFromChromeCdp(active.webContents.session, {
      serviceId: activeId,
      serviceUrl: svc?.url || ''
    })
    if (result.ok) {
      manager.reloadService(activeId)
      const st = takePendingWebStorage(activeId)
      if (st && (Object.keys(st.local).length || Object.keys(st.session).length)) {
        const view = active
        const apply = (): void => {
          if (view.webContents.isDestroyed()) return
          const payload = JSON.stringify(st)
          void view.webContents
            .executeJavaScript(
              `(function(){ try {
                const st = ${payload};
                Object.entries(st.local||{}).forEach(([k,v]) => localStorage.setItem(k, String(v)));
                Object.entries(st.session||{}).forEach(([k,v]) => sessionStorage.setItem(k, String(v)));
                location.reload();
              } catch(e) {} })()`
            )
            .catch(() => undefined)
        }
        view.webContents.once('did-finish-load', () => setTimeout(apply, 400))
      }
    }
    return result
  })

  ipcMain.handle('vox:stop-chrome-google-login', async () => {
    const { stopChromeGoogleLogin } = await import('./chrome-cdp-login')
    stopChromeGoogleLogin()
    return { ok: true }
  })
}

// ─── Window ─────────────────────────────────────────────────
function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#f0e6d2',
    title: 'VOX INTERNUM',
    icon: loadAppIcon(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Keep chrome title as VOX INTERNUM — don't let the shell page or
  // Windows fall back to the raw Electron binary name in the title bar.
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault()
    if (!mainWindow.isDestroyed()) mainWindow.setTitle('VOX INTERNUM')
  })

  // External links from the renderer (none expected, but defensive)
  // open in the user's browser, not a child window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Debounced resize → recompute view bounds. The OS fires many events
  // during a drag-resize; coalesce to avoid thrashing setBounds.
  let resizeTimer: NodeJS.Timeout | null = null
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => manager.layout(), 80)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// ─── Tray ───────────────────────────────────────────────────
function createTray(win: BrowserWindow): Tray | null {
  const icon = loadAppIcon(22)
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('VOX INTERNUM')

  const menu = Menu.buildFromTemplate([
    { label: '◆ VOX INTERNUM', enabled: false },
    { type: 'separator' },
    ...SERVICES.map((s) => ({
      label: s.name,
      click: (): void => {
        win.show()
        win.focus()
        void win.webContents.send(IPC_CHANNELS.VOX_SWITCH_REQUEST, s.id)
      }
    })),
    { type: 'separator' },
    {
      label: '⚙ Toggle DevTools (active view)',
      click: (): void => {
        const active = manager.getActiveView()
        if (!active) return
        if (active.webContents.isDevToolsOpened()) {
          active.webContents.closeDevTools()
        } else {
          active.webContents.openDevTools({ mode: 'detach' })
        }
      }
    },
    { type: 'separator' },
    {
      label: '✗ QUIT',
      click: (): void => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => {
    if (win.isVisible()) {
      win.focus()
    } else {
      win.show()
    }
  })
  return tray
}

// ─── Lifecycle ──────────────────────────────────────────────
app.whenReady().then(() => {
  // app.quit() above does not stop 'ready' from firing; without this
  // the second instance built a window, tray and MCP server (EADDRINUSE)
  // before exiting.
  if (!gotLock) return

  electronApp.setAppUserModelId('dev.heretic-os.vox-internum')

  // Linux WM_CLASS must match StartupWMClass=vox-internum in the .desktop
  // file. Windows taskbar / Alt-Tab use app name + PE ProductName.
  if (process.platform === 'linux') {
    app.setName('vox-internum')
  } else {
    app.setName('Vox Internum')
  }

  app.on('browser-window-created', (_e, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  const win = createWindow()
  createTray(win)
  scheduleUpdateCheck(() => (win.isDestroyed() ? null : win))

  // Safe send: renderer frame may not be ready yet (or may have been
  // disposed) when the embedded views fire loading/title events.
  // Guard against "Render frame was disposed" crashes.
  const safeSend = (channel: string, payload: unknown): void => {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    } catch {
      // Frame disposed mid-send — drop silently. Renderer will re-derive
      // state via getServices/getActive on its next init.
    }
  }

  manager.attach(win, {
    onUnread: (u) => safeSend(IPC_CHANNELS.VOX_UNREAD_UPDATE, u),
    onLoading: (l) => safeSend(IPC_CHANNELS.VOX_LOADING_UPDATE, l)
  })

  // LOCAL TEST ONLY: if VOX_LICENSE_DEV=1, start an in-process
  // license server on 127.0.0.1:8788 that mimics the production
  // Cloudflare Worker. NEVER enabled in production builds.
  if (process.env['VOX_LICENSE_DEV'] === '1') {
    import('./license-dev-server').then(({ startLicenseDevServer }) => {
      startLicenseDevServer()
      // Tell the license client to use the dev server.
      process.env['VOX_LICENSE_URL'] = `http://127.0.0.1:8788`
    })
  }

  // Wire cookie-import: context menu → renderer modal → IPC inject.
  manager.onCookieImport = () => {
    safeSend('vox:open-cookie-import', {})
  }

  // One-shot from context menu: CDP pull (auto-opens Chrome if needed).
  manager.onPullChromeGoogle = async () => {
    const activeId = manager.getActive()
    const active = manager.getActiveView()
    if (!active) return
    const svc = findService(activeId)
    const { pullGoogleCookiesFromChromeCdp } = await import('./chrome-cdp-login')
    const result = await pullGoogleCookiesFromChromeCdp(active.webContents.session, {
      serviceId: activeId,
      serviceUrl: svc?.url || ''
    })
    if (result.ok) {
      manager.reloadService(activeId)
      const { takePendingWebStorage } = await import('./chrome-cdp-login')
      const st = takePendingWebStorage(activeId)
      if (st && (Object.keys(st.local).length || Object.keys(st.session).length)) {
        const view = active
        const apply = (): void => {
          if (view.webContents.isDestroyed()) return
          const payload = JSON.stringify(st)
          void view.webContents
            .executeJavaScript(
              `(function(){ try {
                const st = ${payload};
                Object.entries(st.local||{}).forEach(([k,v]) => localStorage.setItem(k, String(v)));
                Object.entries(st.session||{}).forEach(([k,v]) => sessionStorage.setItem(k, String(v)));
                location.reload();
              } catch(e) {} })()`
            )
            .catch(() => undefined)
        }
        view.webContents.once('did-finish-load', () => setTimeout(apply, 400))
      }
      safeSend('vox:cookie-status', {
        ok: true,
        message: `✓ ${result.set} cookies — site OK. Chrome stays open for next AI.`
      })
    } else {
      safeSend('vox:open-cookie-import', {})
      safeSend('vox:cookie-status', { ok: false, message: result.error || 'Pull failed' })
    }
  }

  // MCP server: expose tools to an LLM dashboard. HITL approval flows
  // through the renderer (mainWindowRef) so the user sees + approves
  // every outbound action before it happens.
  startMcpServer({
    listServices: () =>
      SERVICES.map((s) => ({ id: s.id, name: s.name, category: s.category })),
    getUnread: () => manager.getUnreadCounts(),
    requestApproval: async (req) => {
      // Promise that resolves when the user answers in the renderer.
      const promise = createApproval(req)
      // Surface the prompt to the renderer.
      const payload: McpApproveRequest = {
        id: req.id,
        action: req.action,
        service: req.service,
        summary: req.summary
      }
      safeSend(IPC_CHANNELS.VOX_MCP_APPROVE_REQUEST, payload)
      return promise
    },
    injectMessage: async (serviceId, text) => {
      const before = manager.getActive()
      const ok = await manager.injectMessage(serviceId, text)
      // injectMessage switches to the target view; keep the sidebar in
      // sync (same path as the tray menu).
      if (manager.getActive() !== before) {
        safeSend(IPC_CHANNELS.VOX_SWITCH_REQUEST, manager.getActive())
      }
      return ok
    }
  })

  // Wait for the renderer's own HTML to finish loading before spinning
  // up the embedded messenger views. Otherwise the views' did-start-loading
  // events fire before there is a renderer frame to receive them.
  win.webContents.once('did-finish-load', () => {
    void manager.init().then(async () => {
      // Restore last active service (or default on first run).
      const last = getLastActiveService()
      if (findService(last) && last !== DEFAULT_SERVICE) {
        manager.switch(last)
        // The renderer already asked for the active id (still the
        // default) during its own init — tell it about the restore.
        safeSend(IPC_CHANNELS.VOX_SWITCH_REQUEST, last)
      }

      // TEST-ONLY: after views have had time to render, dump a
      // per-view snapshot to stdout so the integration harness can
      // verify pages actually loaded.
      if (process.env['VOX_TEST_MODE']) {
        // 12s after init — views need time to fetch + render web apps.
        setTimeout(async () => {
          try {
            const snap = await manager.snapshot()
            console.log(
              '[vox-internum:test] SNAPSHOT ' +
                JSON.stringify(
                  snap.map((s) => ({
                    id: s.id,
                    url: s.url.slice(0, 60),
                    title: s.title.slice(0, 50),
                    loaded: s.loaded,
                    bodySize: s.bodySize
                  }))
                )
            )
          } catch (e) {
            console.log('[vox-internum:test] SNAPSHOT-ERROR ' + (e as Error).message)
          }
        }, 12000)
      }
    }).catch((e) => {
      console.error('[vox-internum] view-manager init FAILED:', e)
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
