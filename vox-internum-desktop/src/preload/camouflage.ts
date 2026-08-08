// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Camouflage Preload (runs inside each messenger view)
// ═══════════════════════════════════════════════════════════
// Runs BEFORE the page's own scripts (Electron preload guarantee).
// Patches the navigator/window signals that bot detectors use to
// flag Electron/Chromium automation:
//
//   - navigator.webdriver   → false   (Selenium/Puppeteer fingerprint)
//   - window.chrome.app     → stub    (absence signals non-Chrome)
//   - window.chrome.runtime → stub    (same)
//   - navigator.languages   → ['ru-RU','ru','en-US','en']
//
// IMPORTANT: this preload has NO Node.js access (contextIsolation,
// sandbox). It runs in an isolated world and can only touch the
// page's JS context via Object.defineProperty. We deliberately do
// NOT touch Canvas/WebGL here — naive Canvas fakes make the
// fingerprint MORE unique (FingerprintJS detects the override).
// Per-domain Canvas randomization is a later-phase research task.

// Camouflage must never break the page. Wrap every patch in try/catch
// so a failure on one property doesn't prevent the rest from applying.

// Google Identity Services (accounts.google.com) and VK ID SSO
// (id.vk.ru) refuse to render sign-in buttons when navigator.webdriver
// has been patched — even to false — because they detect the property
// has been overridden. Skip ALL camouflage on these auth domains;
// rely on the network-level UA/Client Hints rewrite (camouflage.ts)
// alone, which is invisible to JS.
let __voxSkipCamouflage = false
try {
  const host = location.hostname
  if (
    host === 'accounts.google.com' ||
    host.endsWith('.accounts.google.com') ||
    host === 'id.vk.ru' ||
    host.endsWith('.id.vk.ru')
  ) {
    __voxSkipCamouflage = true
  }
} catch { /* ignore */ }

// Only run patches if we did NOT opt out above.
if (!__voxSkipCamouflage) {
try {
  // navigator.webdriver = false  (the headline Selenium signal)
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true
  })
} catch { /* page may have frozen navigator; ignore */ }

try {
  // navigator.languages → realistic RU/EN order
  Object.defineProperty(navigator, 'languages', {
    get: () => ['ru-RU', 'ru', 'en-US', 'en'],
    configurable: true
  })
} catch { /* ignore */ }

// window.chrome presence: real Chrome exposes chrome.app and
// chrome.runtime. Electron does too, but with a thinner shape that
// some detectors probe. Stub to the canonical Chrome shape.
try {
  const w = window as unknown as {
    chrome?: Record<string, unknown>
  }
  if (!w.chrome || typeof w.chrome !== 'object') {
    w.chrome = {}
  }
  const ch = w.chrome as Record<string, unknown>
  if (!ch.app) {
    ch.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false
    }
  }
  if (!ch.runtime) {
    ch.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }
    }
  }
} catch { /* ignore */ }

// Marker so the main process can verify the preload ran (dev only).
;(window as unknown as { __vox_camouflage?: boolean }).__vox_camouflage = true
} // end of "not skipped" branch
