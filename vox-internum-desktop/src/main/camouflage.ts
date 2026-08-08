// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Camouflage Engine
// ═══════════════════════════════════════════════════════════
// Removes the "Electron" signature from outgoing requests so that
// web apps (Gmail, WhatsApp, Telegram Web) accept the client as a
// regular Chrome browser instead of blocking it.
//
// Three layers, all applied per session:
//
//   1. Network headers — webRequest.onBeforeSendHeaders rewrites:
//        User-Agent:      strip "Electron/X.Y.Z" tail
//        Sec-CH-UA:       rewrite to plain Chrome brand list
//        Sec-CH-UA-Platform / -Mobile / -PlatformVersion
//        Accept-Language: ru-RU + en-US fallback
//
//   2. setUserAgent — the protocol-level UA (covers redirects and
//      any path that bypasses the webRequest hook).
//
//   3. preload script — fixes navigator.webdriver = false and
//      removes the chrome.app / chrome.runtime absence signal that
//      some bot detectors (Google sign-in especially) check.
//
// Layer 3 runs via webPreferences.preload on every navigation; it
// must run BEFORE the page's own scripts. Electron guarantees this
// when the preload is set on the WebContentsView.

import { join } from 'path'
import type { Session } from 'electron'

// The Chrome version we impersonate. Keep in sync with the Sec-CH-UA
// brand list below. Bumped when Electron's bundled Chromium advances.
// We derive MAJOR from Electron's bundled Chromium so the UA always
// matches the rendering engine — Google cross-checks UA vs the
// actual JavaScript engine feature set, and a mismatch flags us.
const CHROME_VERSION_MAJOR = String(
  Number((process.versions.chrome || '124').split('.')[0])
)
const CHROME_VERSION = `${CHROME_VERSION_MAJOR}.0.0.0`

// Plain-Chrome User-Agent (Windows 10, the most common desktop profile).
// Matches what the real Google Chrome sends on Win10. Ferdium PR #2360
// uses the same plain format (no Electron token, no edition tag).
const PLAIN_CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`

// Sec-CH-UA brand list — matches Chrome's actual format.
const PLAIN_CH_SEC_CH_UA =
  `"Google Chrome";v="${CHROME_VERSION_MAJOR}", ` +
  `"Chromium";v="${CHROME_VERSION_MAJOR}", ` +
  `"Not.A/Brand";v="24"`

/**
 * Strip the " Electron/X.Y.Z" segment from a User-Agent string.
 *   "Mozilla/5.0 ... Chrome/125.0.0.0 Electron/30.5.1 Safari/537.36"
 *   → "Mozilla/5.0 ... Chrome/125.0.0.0 Safari/537.36"
 *
 * Exported for unit testing.
 */
export function stripElectronFromUA(ua: string): string {
  if (!ua) return ua
  // Collapse the trailing double space left by removing the middle token.
  return ua.replace(/\s*Electron\/[\d.]+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * Apply Camouflage to a session.
 *
 * Idempotent; safe to call on the same session multiple times.
 */
export function applyCamouflage(session: Session): void {
  // ── Layer 1: rewrite outgoing headers ─────────────────────
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }

    // User-Agent: strip Electron tail. Falls back to plain Chrome if empty.
    if (headers['User-Agent']) {
      const stripped = stripElectronFromUA(headers['User-Agent'])
      headers['User-Agent'] = stripped || PLAIN_CHROME_UA
    } else {
      headers['User-Agent'] = PLAIN_CHROME_UA
    }

    // Client Hints: Google and WhatsApp check these to detect non-standard
    // browsers. Match what plain Chrome on Windows sends.
    headers['Sec-CH-UA'] = PLAIN_CH_SEC_CH_UA
    headers['Sec-CH-UA-Mobile'] = '?0'
    headers['Sec-CH-UA-Platform'] = '"Windows"'
    headers['Sec-CH-UA-Platform-Version'] = '"15.0.0"'

    // Accept-Language: RU primary (matches our target market), EN fallback.
    if (!headers['Accept-Language']) {
      headers['Accept-Language'] = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    }

    return callback({ requestHeaders: headers })
  })

  // ── Layer 2: protocol-level UA (covers redirects) ─────────
  session.setUserAgent(PLAIN_CHROME_UA)
}

/**
 * Path to the navigator-fixup preload script. Set this on every
 * WebContentsView's webPreferences.preload so that, before the page's
 * own JS runs, we patch:
 *   - navigator.webdriver -> false
 *   - window.chrome.app / runtime -> minimal stubs
 *
 * These are the signals Google sign-in and similar bot-detectors
 * probe for. With them gone, the embedded browser looks like a
 * normal Chrome tab.
 *
 * The main bundle is at out/main/index.js so __dirname = out/main.
 * The camouflage preload is built as a second entry into out/preload/.
 * Resolve one directory up + into preload/.
 */
export function camouflagePreloadPath(): string {
  return join(__dirname, '..', 'preload', 'camouflage.js')
}
