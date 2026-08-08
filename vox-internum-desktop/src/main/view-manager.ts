// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — WebContentsView Manager
// ═══════════════════════════════════════════════════════════
// Owns one WebContentsView per service. Each view lives in its own
// persistent session partition (cookies/cache/localStorage isolated
// between Telegram, VK, MAX).
//
// IMPORTANT GEOMETRY NOTE:
// WebContentsView is rendered by Electron ABOVE the renderer's HTML,
// like a native overlay. Therefore:
//   - The sidebar (56px) is the only renderer-painted region that
//     must stay visible; the main area is a "hole" the views fill.
//   - Any HTML overlay (loading screen, future settings) must
//     temporarily hide the active view via setVisible(false) to
//     avoid being covered.
//
// Switching is done by visibility, NOT by destroying/recreating views:
// this keeps login sessions warm and avoids reloading on every switch.

import { BrowserWindow, WebContentsView, session } from 'electron'
import { SERVICES, partitionFor, findService, DEFAULT_SERVICE } from './services'
import { attachLoginHandler, applyProxy, applySystemProxy, parseProxy } from './session-router'
import { applyInquisition } from './inquisition'
import { applyCamouflage, camouflagePreloadPath } from './camouflage'
import { applyCleaner } from './cleaner'
import { attachContextMenu } from './context-menu'
import { getProxy } from './storage'
import type { LoadingUpdate, UnreadUpdate } from '../shared/types'

/** Width of the renderer sidebar (must match CSS --sidebar-width). */
const SIDEBAR_WIDTH = 56

interface ViewEntry {
  view: WebContentsView
  serviceId: string
  /** True once loadURL has been called at least once. */
  loaded: boolean
  /** Bounded retry count for did-fail-load recovery. */
  retryCount?: number
}

export class ViewManager {
  private views = new Map<string, ViewEntry>()
  private activeId: string = DEFAULT_SERVICE
  private win: BrowserWindow | null = null
  private onUnread: ((u: UnreadUpdate) => void) | null = null
  private onLoading: ((l: LoadingUpdate) => void) | null = null
  /** Last unread count per service — MCP reads this. */
  private unread = new Map<string, number>()

  attach(win: BrowserWindow, callbacks: {
    onUnread: (u: UnreadUpdate) => void
    onLoading: (l: LoadingUpdate) => void
  }): void {
    this.win = win
    this.onUnread = callbacks.onUnread
    this.onLoading = callbacks.onLoading
  }

  /** Create all views and load their URLs. Call once after window ready. */
  async init(): Promise<void> {
    if (!this.win) throw new Error('ViewManager.attach() must be called before init()')

    for (const svc of SERVICES) {
      // Native services (Gmail IMAP) own their UI in the renderer;
      // skip creating a WebContentsView for them. The main area
      // shows a native panel instead.
      if (svc.kind === 'native') continue
      // Proxy routing BEFORE first loadURL.
      //   - If the user set an explicit Smart Proxy → use it.
      //   - Otherwise → resolve the system proxy from env (HTTP_PROXY /
      //     HTTPS_PROXY / ALL_PROXY) and apply it explicitly. Electron's
      //     {mode:'system'} is unreliable across versions; reading env
      //     and calling setProxy with explicit proxyRules is the robust
      //     path. Without this, services behind a regional block
      //     (Telegram in RU) fail with ERR_NETWORK_CHANGED → black screen.
      //
      // Fire-and-forget: setProxy can block on proxy-PAC resolution;
      // awaiting it inside init stalled startup. We run it in the
      // background; loadURL is triggered later by ensureLoaded on
      // first switch, by which time the proxy is in place.
      const stored = getProxy(svc.id)
      if (stored.url && stored.url.trim() && stored.url.trim().toLowerCase() !== 'direct://') {
        const parsed = parseProxy(stored.url)
        void applyProxy(svc.id, parsed)
      } else {
        void applySystemProxy(svc.id)
      }

      const ses = session.fromPartition(partitionFor(svc.id))

      // Inquisition Firewall: block telemetry + revoke hardware
      // permissions for this service's session. Applied before the
      // view is created so the very first request is filtered.
      applyInquisition(ses)

      // Camouflage: strip Electron signature from headers/UA so the
      // web app sees plain Chrome (needed for Gmail/WhatsApp later).
      applyCamouflage(ses)

      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // Camouflage preload: patches navigator.webdriver / chrome.app
          // before the page's own scripts run.
          preload: camouflagePreloadPath(),
          // Native Chromium throttling: when the WebContentsView is not
          // visible (setVisible(false)) or the window is hidden, timers
          // and requestAnimationFrame are automatically throttled. This
          // is the safe mechanism — JS-visible document.visibilityState
          // hacks broke Telegram Web K / Gmail / mail.ru SPAs.
          backgroundThrottling: true
        }
      })
      view.setBackgroundColor('#000000')

      // Install the proxy auth 'login' handler on this view's
      // webContents. Reads creds from session-router's store.
      attachLoginHandler(view.webContents, svc.id)

      const entry: ViewEntry = { view, serviceId: svc.id, loaded: false }
      this.views.set(svc.id, entry)

      // Loading lifecycle -> notify renderer for the loading overlay.
      view.webContents.on('did-start-loading', () => {
        this.onLoading?.({ service: svc.id, loading: true })
      })
      view.webContents.on('dom-ready', () => {
        entry.loaded = true
        // Re-apply CSS cleaner on every navigation: SPAs rebuild DOM
        // on route change, so chrome elements reappear and must be
        // hidden again. insertCSS dedupes by content.
        applyCleaner(view, svc.id)
        this.onLoading?.({ service: svc.id, loading: false })
      })
      view.webContents.on('did-stop-loading', () => {
        this.onLoading?.({ service: svc.id, loading: false })
      })

      // Auto-retry on load failure. Common cause: ERR_NETWORK_CHANGED
      // when the host's network route flaps during the initial fetch
      // (the user reported a black Telegram tab from this). Without
      // a retry, the view stays blank forever. Bounded to 5 attempts
      // with backoff so we don't hammer a genuinely broken endpoint.
      view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
        // Ignore sub-resource failures and user-initiated aborts.
        if (errorCode === -3 /* ERR_ABORTED */) return
        const attempts = (entry.retryCount ?? 0) + 1
        entry.retryCount = attempts
        if (attempts > 5) {
          console.error(
            `[vox-internum] ${svc.id} load failed after 5 retries: ${errorDescription} (${errorCode})`
          )
          this.onLoading?.({ service: svc.id, loading: false })
          return
        }
        const delay = Math.min(800 * Math.pow(2, attempts - 1), 8000)
        console.warn(
          `[vox-internum] ${svc.id} load failed (${errorDescription}, code ${errorCode}); retry ${attempts}/5 in ${delay}ms`
        )
        setTimeout(() => {
          if (entry.view.webContents.isDestroyed()) return
          void entry.view.webContents.loadURL(validatedURL || svc.url)
        }, delay)
      })

      // Unread-count badge via page title parsing.
      // Telegram: "(3) Telegram"; VK/MAX similar leading-number pattern.
      view.webContents.on('page-title-updated', (_e, title) => {
        const count = parseUnreadCount(title)
        this.unread.set(svc.id, count)
        this.onUnread?.({ service: svc.id, count })
      })

      // External links open in the user's real browser, not inside the view.
      view.webContents.setWindowOpenHandler((details) => {
        const url = details.url
        // Auth flows (Google sign-in, VK ID SSO, Microsoft, Yandex)
        // open in popups. If we redirect them to the system browser,
        // the OAuth round-trip can't complete because the web app
        // never sees the result. Load these URLs in the current view
        // so the SPA keeps ownership of the navigation.
        let urlHost = ''
        try {
          urlHost = new URL(url).hostname
        } catch {
          urlHost = ''
        }
        const isAuthDomain =
          urlHost === 'accounts.google.com' ||
          urlHost.endsWith('.accounts.google.com') ||
          urlHost === 'id.vk.ru' ||
          urlHost.endsWith('.id.vk.ru') ||
          urlHost.endsWith('.vk.com') ||
          urlHost.endsWith('login.microsoftonline.com') ||
          urlHost.endsWith('login.live.com') ||
          urlHost.endsWith('passport.yandex.ru') ||
          urlHost.endsWith('oauth.yandex.ru')
        if (
          isAuthDomain &&
          (url.startsWith('http:') || url.startsWith('https:'))
        ) {
          void view.webContents.loadURL(url)
          return { action: 'deny' }
        }
        // Everything else (random external links) → system browser.
        const { shell } = require('electron') as typeof import('electron')
        void shell.openExternal(url)
        return { action: 'deny' }
      })

      // OS-native desktop notifications: when a service's web app calls
      // new Notification(...), Chromium shows a real desktop popup
      // because the 'notifications' permission is granted (see
      // inquisition.ts). Click on the popup focuses Vox Internum.
      // NOTE: Electron 30 has no setNotificationCallback on Session;
      // we rely on Chromium's built-in Notification surface, which is
      // good enough for TG/VK/MAX. The popup click → window.focus is
      // wired at the OS level (StartupWMClass=vox-internum matches).

      // Right-click context menu (copy/paste/reload/sign-out).
      attachContextMenu(view.webContents, this.win!, {
        getActiveService: () => this.activeId,
        getActiveView: () => this.getActiveView(),
        signOut: (id) => this.signOut(id)
      })

      this.win!.contentView.addChildView(view)
      // All views hidden until switched-to.
      view.setVisible(false)

      // LAZY LOADING: do NOT call loadURL here. Views are created
      // (sessions wired, handlers attached) but the URL is fetched
      // only on first switch via ensureLoaded(). This keeps the app
      // light: 6 views cost ~6 idle renderer processes, not 6 active
      // web apps competing for network + CPU + RAM.
    }

    // Reveal + load the default view.
    this.activeId = DEFAULT_SERVICE
    this.applyVisibility()
    this.layout()
    this.ensureLoaded(DEFAULT_SERVICE)
  }

  /**
   * Load a view's URL the first time it is requested. Subsequent
   * calls are no-ops. Idempotent.
   */
  private ensureLoaded(serviceId: string): void {
    const entry = this.views.get(serviceId)
    if (!entry || entry.loaded) return
    const svc = findService(serviceId)
    if (!svc) return
    entry.loaded = true // mark BEFORE load so re-entrant switch doesn't double-fire
    void entry.view.webContents.loadURL(svc.url)
  }

  /** Switch the visible view. Hides all others. */
  switch(serviceId: string): void {
    if (!findService(serviceId)) return
    if (serviceId === this.activeId) return
    this.activeId = serviceId
    const svc = findService(serviceId)
    // Native services (Gmail IMAP) have no WebContentsView — the
    // renderer shows a native panel. We must hide the active web-view
    // so the panel is visible above it.
    if (svc?.kind === 'native') {
      for (const [, entry] of this.views) entry.view.setVisible(false)
      return
    }
    // Ensure the new view has been loaded at least once.
    this.ensureLoaded(serviceId)
    this.applyVisibility()
    this.layout()
  }

  getActive(): string {
    return this.activeId
  }

  /** Return the WebContentsView currently visible. */
  getActiveView(): WebContentsView | null {
    const entry = this.views.get(this.activeId)
    return entry?.view ?? null
  }

  /**
   * Sign out of a service: clear cookies/cache/localStorage for its
   * session partition, then reload the login page. The persistent
   * partition is wiped in place — next launch the service will be
   * unauthenticated. Used by the context-menu "Sign out" action.
   */
  async signOut(serviceId: string): Promise<void> {
    const svc = findService(serviceId)
    if (!svc) return
    const ses = session.fromPartition(partitionFor(serviceId))
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage']
    })
    // Force a fresh load of the login page.
    const entry = this.views.get(serviceId)
    if (entry) {
      entry.loaded = true
      void entry.view.webContents.loadURL(svc.url)
    }
  }

  /**
   * Reload one service's view. Used after a proxy change so new
   * connections use the updated route. Active connections in other
   * views are unaffected.
   */
  reloadService(serviceId: string): void {
    const entry = this.views.get(serviceId)
    if (!entry) return
    // Mark loaded so ensureLoaded doesn't short-circuit; the retry
    // mechanism in did-fail-load will kick in if this also fails.
    entry.loaded = true
    const svc = findService(serviceId)
    if (!svc) return
    void entry.view.webContents.loadURL(svc.url)
  }

  /**
   * Snapshot of unread counts per service. Read from the badge-reader
   * state maintained in page-title-updated handlers.
   */
  getUnreadCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const id of this.unread.keys()) {
      out[id] = this.unread.get(id) ?? 0
    }
    return out
  }

  /**
   * Diagnostic snapshot of all views. Debug-only; exposed via the
   * vox:diagnostic-snapshot IPC for the integration test harness.
   * Returns, per service: URL, title, isLoading, isVisible, loaded,
   * and a bodySize heuristic (length of document.body.innerText) to
   * confirm the page actually rendered content (not a blank screen).
   *
   * bodySize is read defensively with a 2s timeout — executeJavaScript
   * on a never-loaded view (lazy loading!) would otherwise hang the
   * test forever. Returns bodySize=0 for not-yet-loaded views.
   */
  async snapshot(): Promise<
    Array<{
      id: string
      url: string
      title: string
      isLoading: boolean
      isVisible: boolean
      loaded: boolean
      unread: number
      bodySize: number
    }>
  > {
    const out: Array<{
      id: string
      url: string
      title: string
      isLoading: boolean
      isVisible: boolean
      loaded: boolean
      unread: number
      bodySize: number
    }> = []
    for (const [id, entry] of this.views) {
      const wc = entry.view.webContents
      let bodySize = 0
      // Only probe the DOM for views that have actually loaded.
      // Probing a not-yet-loaded (about:blank) view via executeJavaScript
      // hangs under lazy loading.
      if (entry.loaded && !wc.isDestroyed()) {
        try {
          bodySize = await Promise.race([
            wc.executeJavaScript(
              '(document.body && document.body.innerText || "").length',
              true
            ),
            new Promise<number>((r) => setTimeout(() => r(0), 2000))
          ])
        } catch {
          // page crashed or navigated — leave bodySize=0
        }
      }
      out.push({
        id,
        url: wc.getURL(),
        title: wc.getTitle(),
        isLoading: wc.isLoading(),
        isVisible: id === this.activeId,
        loaded: entry.loaded,
        unread: this.unread.get(id) ?? 0,
        bodySize
      })
    }
    return out
  }

  /**
   * Inject text into the active chat's input field for a service.
   * Used by the MCP server AFTER human approval. The script focuses
   * the input, sets its value, and dispatches an input event so the
   * SPA's framework (React/Vue) registers the change. The message is
   * NOT auto-sent — the user presses Enter. (Auto-Enter after remote
   * approval is too risky; keep the final keystroke human.)
   */
  async injectMessage(serviceId: string, text: string): Promise<boolean> {
    const entry = this.views.get(serviceId)
    if (!entry) return false
    // Selector per service. We try several common patterns; the
    // script returns true if any matched.
    const js = `
      (function() {
        const selectors = ${JSON.stringify(INPUT_SELECTORS[serviceId] || [])};
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            el.focus();
            // Use the native setter so React/Vue see the change.
            const proto = el.tagName === 'TEXTAREA'
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, ${JSON.stringify(text)});
            else el.value = ${JSON.stringify(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      })()
    `
    try {
      // Make the target view visible so the user sees the injection
      // happen in context (and the input is actually rendered).
      const wasActive = this.activeId === serviceId
      if (!wasActive) this.switch(serviceId)
      const result = await entry.view.webContents.executeJavaScript(js, true)
      return Boolean(result)
    } catch {
      return false
    }
  }

  /** Recompute bounds for all views after a window resize. */
  layout(): void {
    if (!this.win) return
    const [width, height] = this.win.getContentSize()
    const viewWidth = Math.max(0, width - SIDEBAR_WIDTH)
    for (const entry of this.views.values()) {
      entry.view.setBounds({
        x: SIDEBAR_WIDTH,
        y: 0,
        width: viewWidth,
        height
      })
    }
  }

  /**
   * Temporarily hide the active view so a renderer-painted overlay
   * (loading screen, modal) can be seen. Call showActiveView() to restore.
   */
  hideActiveView(): void {
    const entry = this.views.get(this.activeId)
    if (entry) entry.view.setVisible(false)
  }

  showActiveView(): void {
    const entry = this.views.get(this.activeId)
    if (entry) entry.view.setVisible(true)
  }

  private applyVisibility(): void {
    for (const [id, entry] of this.views) {
      const isActive = id === this.activeId
      entry.view.setVisible(isActive)
    }
  }
}

/**
 * Per-service CSS selectors for the message input field, tried in
 * order. Used by injectMessage (MCP send_message). Best-effort:
 * selectors change as web apps update; the script returns false if
 * none match, and the user is told "injection failed".
 *
 * Mail services are deliberately absent — auto-injecting into a mail
 * compose box is too risky and not in scope.
 */
const INPUT_SELECTORS: Record<string, string[]> = {
  telegram: [
    '#editable-message-text',          // Web K
    '.input-message-container[contenteditable]',
    'div[contenteditable="true"][data-name="peer"]'
  ],
  vk: [
    'div.im-editable[contenteditable="true"]',
    '.im-chat-input--text',
    '[contenteditable="true"].im-chat-input--text'
  ],
  max: [
    'div[contenteditable="true"]',
    'textarea[data-testid="message-input"]'
  ]
}

/**
 * Parse the unread message count out of a web-app page title.
 * Patterns seen in the wild:
 *   "(5) Telegram"          -> 5
 *   "5 Telegram"            -> 5
 *   "(99+) VK"              -> 99
 *   "Telegram"              -> 0
 */
export function parseUnreadCount(title: string): number {
  if (!title) return 0
  // Try "(N)" or "(N+)" first.
  const paren = title.match(/^\((\d+)\+?\)/)
  if (paren) return parseInt(paren[1], 10)
  // Then "N " leading number.
  const leading = title.match(/^(\d+)\s/)
  if (leading) return parseInt(leading[1], 10)
  return 0
}
