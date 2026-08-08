// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Inquisition Firewall
// ═══════════════════════════════════════════════════════════
// Two layers of defense against the embedded messengers:
//
//   1. Network — webRequest.onBeforeRequest cancels any request
//      to a known telemetry/analytics/fingerprinting domain.
//      Messengers load cleanly; their trackers never fire.
//
//   2. Hardware — setPermissionRequestHandler refuses microphone,
//      camera, clipboard-read, notifications, etc. The messenger
//      thinks the device has no mic/cam (like a kiosk).
//
// Applied per-session (every partition gets the same rules).

import type { Session } from 'electron'
import { isTelemetry } from './blocklist'

/** Hardware permissions we never grant to embedded messengers. */
const BLOCKED_PERMISSIONS: readonly string[] = [
  'media',
  'audioCapture',
  'videoCapture',
  'microphone',
  'camera',
  // 'notifications' is intentionally ALLOWED — we surface OS-native
  // desktop notifications via setNotificationCallback in view-manager,
  // so the user gets a popup when a message arrives in any service.
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fileSystem',
  'midi',
  'midiSysex'
]

/**
 * Apply the full Inquisition Firewall to a session.
 *
 * Idempotent — safe to call multiple times (handlers replace).
 *
 * When `tagForLogs` is set, blocked requests are also written to
 * stdout tagged with that string — used to diagnose which blocklist
 * entry breaks a given service's SPA.
 */
export function applyInquisition(session: Session, tagForLogs?: string): void {
  // ── Layer 1: network telemetry block ─────────────────────
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isTelemetry(details.url)) {
      if (tagForLogs) {
        console.log(`[vox-internum:fw:${tagForLogs}] BLOCKED ${details.url.slice(0, 120)}`)
      }
      return callback({ cancel: true })
    }
    return callback({})
  })

  // ── Layer 2: permission handler ──────────────────────────
  // We DENY hardware permissions that embed nothing useful (mic/cam)
  // but ALLOW the permissions Google sign-in needs to look "secure":
  // notifications (we surface OS-native), clipboard, fullscreen,
  // and crucially hid/serial/usb — these are probed by Google's
  // FIDO2/security-key path. If they are denied, Google marks the
  // browser as "not secure" and refuses login. (Technique copied
  // from Ferdium's fix for the same Google block, PR #2360.)
  const ALLOWED_PERMISSIONS: readonly string[] = [
    'notifications',
    'fullscreen',
    'pointerLock',
    'display-capture',
    'idle-detection',
    'clipboard-read',
    'clipboard-sanitized-write',
    'speaker-selection',
    'hid',
    'serial',
    'usb'
  ]
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (BLOCKED_PERMISSIONS.includes(permission)) {
      return callback(false)
    }
    return callback(true)
  })
  session.setPermissionCheckHandler((_wc, permission) => {
    if (BLOCKED_PERMISSIONS.includes(permission)) {
      return false
    }
    // Explicitly allow security-key permissions even when not
    // requested — Google's check runs without an interactive prompt.
    if (ALLOWED_PERMISSIONS.includes(permission)) {
      return true
    }
    return true
  })
}
