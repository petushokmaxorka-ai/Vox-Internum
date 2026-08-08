// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — CSS Cleaner
// ═══════════════════════════════════════════════════════════
// Per-service CSS injection that strips web-app chrome (headers,
// side menus, promo banners, "open in app" nudges) so the embedded
// messenger looks native inside Vox Internum.
//
// DESIGN — defensive selectors:
//   - Web apps use obfuscated/mangled class names that change between
//     builds. We rely on STABLE element IDs first (#page_header on VK),
//     then structural/attribute selectors, then class fallbacks.
//   - Every rule uses !important; the web app's own CSS fights us.
//
// DESIGN — re-apply on every navigation:
//   - SPAs rebuild DOM on route change (vk.com/im → vk.com/im?sel=123).
//     dom-ready fires for each; we re-inject. insertCSS returns a key
//     we don't track — Electron dedupes identical CSS by content.
//
// KNOWN LIMITATIONS:
//   - Telegram Web K is already a focused chat UI; we only trim the
//     "switch to mobile" banner. Aggressive trimming breaks folder nav.
//   - MAX (web.max.ru) is primarily a mobile/desktop-app product; its
//     web presence is thin. Selectors are best-effort.
//   - Selectors WILL need maintenance as services update. The file is
//     intentionally isolated so updates touch nothing else.

import type { WebContentsView } from 'electron'

// ─── Per-service CSS ────────────────────────────────────────

const TELEGRAM_CSS = `
  /* Telegram Web K is already a clean chat UI. Trim only the
     "use mobile app" promo and the cookie consent banner. */
  .tg-widget-promo,
  .promo-banner,
  [class*="InstallPrompt"],
  .cookie-notifier,
  [class*="CookieConsent"] {
    display: none !important;
  }
`

const VK_CSS = `
  /* VK Messenger (vk.com/im): kill the top header, left nav rail,
     right column, and promo blocks. Keep only the chat list + convo.
     Selectors: ID-first (stable), then class fallbacks. */
  #page_header,
  #side_bar,
  #l,
  #left_ads,
  #stl_side,
  #stl_left,
  .vk__page_header,
  .PageHeader,
  .header__row,
  [class*="PageHeader"],
  #side_bar_inner,
  .side_bar_inner,
  .LeftMenu,
  [class*="LeftMenu"],
  .ui_rmenu,
  #ads_left,
  .ads_box,
  #right_box,
  .layout__column_right,
  [class*="LayoutRight"],
  .app_widget,
  .im-page--chat-header-bubble { /* promo in chat list */ }
  /* The above empty rule is a no-op; real hiding below. */
  #page_header,
  #side_bar,
  #side_bar_inner,
  #l,
  #left_ads,
  #ads_left,
  #right_box,
  .vk__page_header,
  [class*="PageHeader"],
  [class*="LeftMenu"],
  .layout__column_right,
  [class*="LayoutRight"],
  .im-page--chat-header-bubble,
  [class*="PromoBanner"],
  [class*="InstallBanner"],
  [class*="CookieConsent"] {
    display: none !important;
  }
  /* Reclaim the freed horizontal space for the chat surface. */
  .layout,
  body.im .layout {
    padding-left: 0 !important;
  }
  .im-page-classic {
    left: 0 !important;
  }
  /* Custom scrollbar in Vox Internum gold/black palette to match
     the surrounding chrome instead of VK's default light-grey. */
  ::-webkit-scrollbar {
    width: 10px !important;
    height: 10px !important;
  }
  ::-webkit-scrollbar-track {
    background: #050505 !important;
  }
  ::-webkit-scrollbar-thumb {
    background: #5a4a3a !important;
    border-radius: 5px !important;
    border: 2px solid #050505 !important;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #c8a86e !important;
  }
  ::-webkit-scrollbar-corner {
    background: #050505 !important;
  }
`

const MAX_CSS = `
  /* MAX (web.max.ru): best-effort. MAX is mobile-first; the web
     presence may show a "download the app" interstitial. Hide it
     and any header chrome that doesn't belong to the chat itself. */
  [class*="DownloadApp"],
  [class*="InstallPrompt"],
  [class*="PromoBanner"],
  [class*="CookieConsent"],
  .app-promo,
  .download-banner {
    display: none !important;
  }
`

const WHATSAPP_CSS = `
  /* WhatsApp Web (web.whatsapp.com): trim the "download the app"
     banner, cookie consent dialog, and any upsell. WhatsApp has
     its own dark mode (toggled in its Settings) — we don't force it. */
  [data-testid="app-download-promo"],
  [class*="download-app"],
  [class*="DownloadPanel"],
  [class*="cookie-policy"],
  [data-testid="cookie-banner"],
  [class*="CookieBanner"],
  [class*="intro-"] {
    display: none !important;
  }
  /* Custom scrollbar in Vox Internum palette. */
  ::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
  ::-webkit-scrollbar-track { background: #050505 !important; }
  ::-webkit-scrollbar-thumb {
    background: #5a4a3a !important; border-radius: 5px !important;
    border: 2px solid #050505 !important;
  }
  ::-webkit-scrollbar-thumb:hover { background: #c8a86e !important; }
  ::-webkit-scrollbar-corner { background: #050505 !important; }
`

const YANDEX_CSS = `
  /* Yandex Mail (mail.yandex.ru): hide the right-side widgets pane
     (news, weather, telemetry promos) and the left "services" rail,
     leaving folders + message list + reading pane. */
  .mail-Layout-Aside,
  .ns-view-leftbox-bottom,
  .mail-Teaser,
  .b-mail-Layout-Columns-Column_right,
  [class*="Layout-Aside"],
  .mail-Layout-Columns-Column_right,
  .ns-view-mail-teaser,
  [class*="Teaser"] {
    display: none !important;
  }
  /* Reclaim width for the message list + reading pane. */
  .mail-Layout-Columns-Main {
    width: 100% !important;
  }
`

const MAILRU_CSS = `
  /* Mail.ru (e.mail.ru): conservative cleanup. We previously used
     aggressive [class*="Promo"] / [class*="app-foot"] attribute
     selectors which broke the VK ID SSO login page (mail.ru now
     redirects to id.vk.ru/auth) → black screen. Now we only hide
     named banner ad slots, never anything that might carry login
     UI. When in doubt, leave it visible. */
  #banner_left,
  #banner_right,
  .b-rb-line,
  [data-testid="promoredlink"] {
    display: none !important;
  }
  /* Custom scrollbar in Vox Internum palette. */
  ::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
  ::-webkit-scrollbar-track { background: #050505 !important; }
  ::-webkit-scrollbar-thumb {
    background: #5a4a3a !important; border-radius: 5px !important;
    border: 2px solid #050505 !important;
  }
  ::-webkit-scrollbar-thumb:hover { background: #c8a86e !important; }
  ::-webkit-scrollbar-corner { background: #050505 !important; }
`

const GMAIL_CSS = `
  /* Gmail: hide ONLY the right-side "side widget" panel (calendar/
     keep/tasks rail) — keeping it minimal. Gmail's sign-in flow
     (accounts.google.com) uses React/web-components that break if
     we touch almost anything; we only act on the inbox view. */
  .nH.bk2,            /* side widget container — only present in inbox */
  .nH.PS {            /* Google One storage upsell — only in inbox */
    display: none !important;
  }
  /* Stretch the main mail area to fill the freed width. */
  .bkK > .nH { width: 100% !important; }
  /* Custom scrollbar in Vox Internum palette. */
  ::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
  ::-webkit-scrollbar-track { background: #050505 !important; }
  ::-webkit-scrollbar-thumb {
    background: #5a4a3a !important; border-radius: 5px !important;
    border: 2px solid #050505 !important;
  }
  ::-webkit-scrollbar-thumb:hover { background: #c8a86e !important; }
  ::-webkit-scrollbar-corner { background: #050505 !important; }
`

/** Map serviceId -> CSS string to inject. Empty = no cleaning. */
const CLEANERS: Record<string, string> = {
  telegram: TELEGRAM_CSS,
  whatsapp: WHATSAPP_CSS,
  vk: VK_CSS,
  max: MAX_CSS,
  yandex: YANDEX_CSS,
  mailru: MAILRU_CSS,
  gmail: GMAIL_CSS
}

/**
 * Inject the cleaner CSS into a view. Call on every `dom-ready`
 * (SPAs rebuild DOM on navigation). Safe to call repeatedly;
 * Electron dedupes identical insertCSS calls.
 *
 * Dark-theme handling: instead of guessing localStorage formats
 * (which differ wildly across services and break on updates), we
 * rely on Electron's nativeTheme.themeSource = 'dark' (set in
 * main/index.ts). Services that respect prefers-color-scheme
 * (Telegram Web K, modern mail) automatically render dark.
 */
export function applyCleaner(view: WebContentsView, serviceId: string): void {
  const css = CLEANERS[serviceId]
  if (!css) return
  void view.webContents.insertCSS(css, { cssOrigin: 'user' })
}
