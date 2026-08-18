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
//
// DO NOT inject global ::-webkit-scrollbar rules. Forcing a 10px black
// horizontal track paints a "black shelf" inside search inputs and
// compact toolbars across WhatsApp / VK / mail.

import type { WebContentsView } from 'electron'

// ─── Per-service CSS ────────────────────────────────────────

const AI_COMMON_CSS = `
  /* Common cleanup for AI chat services. They all have cookie
     consent banners, "download app" promos, and side panels we
     don't need inside Vox Internum. */
  [class*="cookie"],
  [class*="Cookie"],
  [id*="cookie"],
  [class*="download-app"],
  [class*="DownloadApp"],
  [class*="install-prompt"],
  [class*="promo-banner"],
  [class*="PromoBanner"],
  [class*="app-banner"] {
    display: none !important;
  }
`

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
  /* Soften scroll jank: avoid animating backdrop filters on the
     message stack while the user flings history upward. */
  .bubbles .bubble,
  .Message,
  [class*="message"] {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
`

const VK_CSS = `
  /* VK Messenger (vk.com/im): kill the top header, left nav rail,
     right column, and promo blocks. Keep only the chat list + convo.
     Selectors: ID-first (stable), then class fallbacks. */
  #page_header,
  #side_bar,
  #side_bar_inner,
  #l,
  #left_ads,
  #ads_left,
  #right_box,
  #stl_side,
  #stl_left,
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
  /* Collapse leftover header height so search isn't under a black gap. */
  #page_header {
    height: 0 !important;
    min-height: 0 !important;
    overflow: hidden !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .layout,
  body.im .layout,
  #page_layout,
  .App {
    padding-left: 0 !important;
    padding-top: 0 !important;
    margin-top: 0 !important;
  }
  .im-page-classic {
    left: 0 !important;
    top: 0 !important;
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

const OK_CSS = `
  /* Odnoklassniki (ok.ru/messages): conservative cleanup — hide the
     "install mobile app" interstitial and cookie consent only. Never
     touch anything that might carry login UI (mail.ru lesson above). */
  [class*="DownloadApp"],
  [class*="InstallPrompt"],
  [class*="app-promo"],
  [class*="CookieConsent"],
  [class*="cookieBanner"] {
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
  [class*="CookieBanner"] {
    display: none !important;
  }
`

const ZAI_CSS = AI_COMMON_CSS
const KIMI_CSS = AI_COMMON_CSS
const MINIMAX_CSS = AI_COMMON_CSS
const QWEN_CSS = AI_COMMON_CSS

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
`

/** Map serviceId -> CSS string to inject. Empty = no cleaning. */
const CLEANERS: Record<string, string> = {
  telegram: TELEGRAM_CSS,
  whatsapp: WHATSAPP_CSS,
  vk: VK_CSS,
  max: MAX_CSS,
  ok: OK_CSS,
  zai: ZAI_CSS,
  kimi: KIMI_CSS,
  minimax: MINIMAX_CSS,
  qwen: QWEN_CSS,
  yandex: YANDEX_CSS,
  mailru: MAILRU_CSS,
  gmail: GMAIL_CSS
}

/**
 * Inject the cleaner CSS into a view. Call on every `dom-ready`
 * (SPAs rebuild DOM on navigation). Safe to call repeatedly;
 * Electron dedupes identical insertCSS calls.
 *
 * Dark-theme handling: we do NOT force nativeTheme.themeSource —
 * leaving it at 'system' is required (forcing 'dark' broke mail.ru).
 * Services that respect prefers-color-scheme can still render dark
 * via their own settings (TG: Chat Settings → Night).
 */
export function applyCleaner(view: WebContentsView, serviceId: string): void {
  const css = CLEANERS[serviceId]
  if (!css) return
  void view.webContents.insertCSS(css, { cssOrigin: 'user' })
}
