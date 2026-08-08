// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Inquisition Blocklist
// ═══════════════════════════════════════════════════════════
// Domains whose requests are cancelled at the session level
// (webRequest.onBeforeRequest). Covers known telemetry / analytics /
// fingerprinting endpoints loaded by the web versions of Telegram,
// VK, MAX, Mail.ru, Yandex and WeChat.
//
// Sources: EasyPrivacy filter list, public ad-block registries,
// vendor documentation. Trimmed to high-confidence entries only —
// we never want to break a messenger's own login/CDN traffic.
//
// Maintenance: append a domain here; no other change needed. The
// matching is suffix-based (mc.yandex.ru also blocks
// mc.webvisor.com via its own entry, etc.).

/**
 * Suffix-matched blocked hosts. A request is cancelled if its
 * hostname ENDS WITH any of these (subdomain-aware).
 */
export const TELEMETRY_DOMAINS: readonly string[] = [
  // ── Yandex / Metrica ─────────────────────────────────────
  'mc.yandex.ru',
  'mc.yandex.com',
  'mc.webvisor.org',
  'mc.webvisor.com',
  'metrica.yandex.com',
  'verify.ssp.yandex.net',
  'cdn.rotatric.ru',
  'an.yandex.ru',

  // ── Google Analytics / Ads ───────────────────────────────
  'www.google-analytics.com',
  'ssl.google-analytics.com',
  'stats.g.doubleclick.net',
  'www.googletagmanager.com',
  'googletagmanager.com',
  'www.googleadservices.com',
  'googleads.g.doubleclick.net',
  'adservice.google.com',

  // ── Tencent / QQ / WeChat trackers ──────────────────────
  'beacon.tencent.com',
  'ping.fore.qq.com',
  'hm.baidu.com',
  'report.qq.com',
  'analytics.qq.com',
  'pingjs.qq.com',
  'tcss.qq.com',
  'hm.mmstat.com', // Alibaba

  // ── Mail.ru / VK trackers ────────────────────────────────
  // IMPORTANT: ad.mail.ru hosts vkAuth.html which mail.ru SPA needs
  // to verify the VK ID session post-login. Blocking it turns the
  // inbox black after ~1s (page renders, then auth iframe fails).
  // We only block the obvious tracking pixels + rs.mail.ru stat hits,
  // leaving ad.mail.ru alone.
  'pixel.mail.ru',
  'rs.mail.ru',
  'statad.mail.ru',
  'top-fw.mail.ru',
  'tracker.vk.com',

  // ── Facebook Meta pixel (some embedded chats) ────────────
  'connect.facebook.net',
  'www.facebook.com/tr',

  // ── Generic fingerprinting / bot-detection ───────────────
  'cdn.fingerprintjs.com',
  'pixel.advertising.com'
]

/**
 * Returns true if the given URL's hostname should be blocked.
 * Suffix match against TELEMETRY_DOMAINS.
 */
export function isTelemetry(url: string): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  for (const d of TELEMETRY_DOMAINS) {
    if (host === d || host.endsWith('.' + d)) return true
  }
  return false
}
