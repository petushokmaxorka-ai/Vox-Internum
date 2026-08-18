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

import { BrowserWindow, WebContentsView, session, shell, type Session } from 'electron'
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
  /** Callback fired when user picks "Import Google Cookies". */
  public onCookieImport: (() => void) | null = null
  /** Context-menu: open Chrome + pull Google cookies via CDP. */
  public onPullChromeGoogle: (() => Promise<void>) | null = null
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
      // Native / external: no embedded WebContentsView.
      if (svc.kind === 'native' || svc.kind === 'external') continue
      // Proxy routing BEFORE first loadURL.
      //   - Explicit Smart Proxy URL → use it (incl. direct://).
      //   - AI / mail with no override → DIRECT by default.
      //     ALL_PROXY/xray often breaks Chinese CDNs + Google OAuth
      //     callbacks (SSL -100 / blank MiniMax, Qwen timeouts).
      //   - Messengers with no override → system proxy from env
      //     (Telegram/WhatsApp need it in RU).
      const stored = getProxy(svc.id)
      const raw = (stored.url || '').trim()
      const lower = raw.toLowerCase()
      if (lower === 'direct://' || lower === 'direct') {
        await applyProxy(svc.id, parseProxy('direct://'))
        console.log(`[vox-internum:proxy] ${svc.id} Smart Proxy direct://`)
      } else if (raw) {
        const parsed = parseProxy(raw)
        await applyProxy(svc.id, parsed)
        console.log(`[vox-internum:proxy] ${svc.id} Smart Proxy ${parsed.proxyRules}`)
      } else if (svc.category === 'ai' || svc.category === 'mail') {
        await applyProxy(svc.id, parseProxy('direct://'))
        console.log(`[vox-internum:proxy] ${svc.id} default direct (AI/mail — skip VPN)`)
      } else {
        const applied = await applySystemProxy(svc.id)
        console.log(`[vox-internum:proxy] ${svc.id} system/default → ${applied}`)
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
          // Messengers keep throttling OFF so voice/video notes keep
          // decoding when the window briefly loses focus.
          backgroundThrottling: svc.category !== 'messenger',
          // Voice messages / media elements must be allowed to play.
          autoplayPolicy: 'no-user-gesture-required'
        }
      })
      view.setBackgroundColor('#00000000')
      // Never start muted — Electron can inherit a muted flag across reloads.
      view.webContents.setAudioMuted(false)

      // Install the proxy auth 'login' handler on this view's
      // webContents. Reads creds from session-router's store.
      attachLoginHandler(view.webContents, svc.id)

      const entry: ViewEntry = { view, serviceId: svc.id, loaded: false }
      this.views.set(svc.id, entry)

      // Loading lifecycle -> notify renderer for the loading overlay.
      // Only the ACTIVE service drives the overlay — background SPA
      // navigations must not spam IPC / DOM work (felt like jank).
      view.webContents.on('did-start-loading', () => {
        if (this.activeId !== svc.id) return
        this.onLoading?.({ service: svc.id, loading: true })
      })
      view.webContents.on('dom-ready', () => {
        entry.loaded = true
        // Re-apply CSS cleaner on every navigation: SPAs rebuild DOM
        // on route change, so chrome elements reappear and must be
        // hidden again. insertCSS dedupes by content.
        applyCleaner(view, svc.id)
        if (this.activeId === svc.id) {
          this.onLoading?.({ service: svc.id, loading: false })
        }
      })
      view.webContents.on('did-stop-loading', () => {
        if (this.activeId !== svc.id) return
        this.onLoading?.({ service: svc.id, loading: false })
      })

      // Auto-retry on MAIN-FRAME load failure only. Common cause:
      // ERR_NETWORK_CHANGED when the host's network route flaps during
      // the initial fetch (black Telegram tab). Subframe/CDN failures
      // must NOT reload the top document — that caused reload storms
      // and felt like freezes. Bounded to 5 attempts with backoff.
      view.webContents.on(
        'did-fail-load',
        (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
          if (!isMainFrame) return
          // Ignore user-initiated aborts.
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
        }
      )

      // Successful main-frame navigation → allow future retries.
      view.webContents.on('did-finish-load', () => {
        entry.retryCount = 0
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
        if (this.isAuthUrl(url)) {
          this.openAuthPopup(url, ses)
          return { action: 'deny' }
        }

        // Everything else (random external links) → system browser.
        void shell.openExternal(url)
        return { action: 'deny' }
      })

      // Google often navigates INSIDE the WebContentsView (not window.open).
      // That triggers "browser may not be secure". Hijack those navigations
      // into a top-level BrowserWindow that shares this partition.
      view.webContents.on('will-navigate', (e, url) => {
        if (!this.isAuthUrl(url)) return
        e.preventDefault()
        this.openAuthPopup(url, ses)
      })
      view.webContents.on('will-redirect', (e, url) => {
        // Only intercept outbound redirects INTO Google auth from a
        // non-auth page. If we are already on accounts.google.com inside
        // a popup this handler is not attached.
        if (!this.isAuthUrl(url)) return
        try {
          const cur = new URL(view.webContents.getURL()).hostname
          if (cur === 'accounts.google.com' || cur.endsWith('.accounts.google.com')) return
        } catch {
          /* continue */
        }
        e.preventDefault()
        this.openAuthPopup(url, ses)
      })

      // OS-native desktop notifications: when a service's web app calls
      // new Notification(...), Chromium shows a real desktop popup
      // because the 'notifications' permission is granted (see
      // inquisition.ts). Click on the popup focuses Vox Internum.
      // NOTE: Electron 30 has no setNotificationCallback on Session;
      // we rely on Chromium's built-in Notification surface, which is
      // good enough for TG/VK/MAX. The popup click → window.focus is
      // wired at the OS level (StartupWMClass=vox-internum matches).

      // Right-click context menu (copy/paste/reload/google/sign-out).
      attachContextMenu(view.webContents, this.win!, {
        getActiveService: () => this.activeId,
        getActiveView: () => this.getActiveView(),
        signOut: (id) => this.signOut(id),
        openCookieImport: () => {
          this.onCookieImport?.()
        },
        pullChromeGoogle: async () => {
          if (this.onPullChromeGoogle) await this.onPullChromeGoogle()
        }
      })

      this.win!.contentView.addChildView(view)
      // All views hidden until switched-to.
      view.setVisible(false)

      // LAZY LOADING: do NOT call loadURL here. Views are created
      // (sessions wired, handlers attached) but the URL is fetched
      // only on first switch via ensureLoaded(). This keeps the app
      // light: idle blank renderers cost far less than N fully loaded
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
    const svc = findService(serviceId)
    // Native / external: hide web views; renderer shows a panel.
    // External opens the system browser (escape hatch only).
    if (svc?.kind === 'native' || svc?.kind === 'external') {
      this.activeId = serviceId
      for (const [, entry] of this.views) entry.view.setVisible(false)
      if (svc.kind === 'external' && svc.url) {
        void shell.openExternal(svc.url)
      }
      return
    }
    if (serviceId === this.activeId) return
    this.activeId = serviceId
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

  /** True if URL is a Google / VK / MS / Yandex OAuth host we must not embed. */
  private isAuthUrl(url: string): boolean {
    if (!url.startsWith('http:') && !url.startsWith('https:')) return false
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    return (
      host === 'accounts.google.com' ||
      host.endsWith('.accounts.google.com') ||
      host === 'id.vk.ru' ||
      host.endsWith('.id.vk.ru') ||
      host.endsWith('login.microsoftonline.com') ||
      host.endsWith('login.live.com') ||
      host.endsWith('passport.yandex.ru') ||
      host.endsWith('oauth.yandex.ru')
    )
  }

  /**
   * Open OAuth in a top-level BrowserWindow sharing the service
   * partition. Google rejects WebContentsView embeds; a normal window
   * with AutomationControlled disabled is accepted more often. On
   * close, reload the active view so cookies take effect.
   */
  openAuthPopup(url: string, ses?: Session): void {
    const sessionToUse =
      ses ??
      session.fromPartition(partitionFor(this.activeId))
    const popup = new BrowserWindow({
      width: 520,
      height: 720,
      parent: this.win ?? undefined,
      modal: false,
      autoHideMenuBar: true,
      title: 'Sign in — Google',
      webPreferences: {
        session: sessionToUse,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
        // No camouflage preload — Google Identity Services refuses
        // patched navigator.webdriver descriptors.
      }
    })
    popup.webContents.setWindowOpenHandler((details) => {
      if (details.url.startsWith('http:') || details.url.startsWith('https:')) {
        void popup.loadURL(details.url)
      }
      return { action: 'deny' }
    })
    void popup.loadURL(url)
    popup.on('closed', () => {
      const active = this.getActiveView()
      if (active && !active.webContents.isDestroyed()) {
        void active.webContents.reload()
      }
    })
  }

  /** Convenience: Google accounts home in a popup for the active service. */
  openGoogleSignIn(): void {
    this.openAuthPopup('https://accounts.google.com/')
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

  /** Recompute bounds after a window resize / switch.
   *  Only the ACTIVE view needs fresh geometry during resize drag —
   *  hidden views are updated on the next switch (applyVisibility). */
  layout(): void {
    if (!this.win) return
    const [width, height] = this.win.getContentSize()
    const viewWidth = Math.max(0, width - SIDEBAR_WIDTH)
    const bounds = {
      x: SIDEBAR_WIDTH,
      y: 0,
      width: viewWidth,
      height
    }
    const active = this.views.get(this.activeId)
    if (active) {
      active.view.setBounds(bounds)
      return
    }
    for (const entry of this.views.values()) {
      entry.view.setBounds(bounds)
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
    const svc = findService(this.activeId)
    if (svc?.kind === 'native' || svc?.kind === 'external') return
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
  ],
  ok: [
    'div[contenteditable="true"]',
    'textarea[placeholder][class*="input"]'
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
