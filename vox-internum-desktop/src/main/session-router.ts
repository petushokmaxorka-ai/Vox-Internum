// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Smart Proxy Router
// ═══════════════════════════════════════════════════════════
// Per-service proxy routing. Each service lives in its own session
// partition (see view-manager.ts); this module applies a proxy to
// that session on demand.
//
// WHY PER-SERVICE, NOT GLOBAL:
// The killer feature. VK/MAX run DIRECT (no latency, RU-internal
// reachability), while Telegram/WhatsApp/Gmail route through a
// user-supplied SOCKS5/HTTP proxy to bypass regional blocking.
// A system-wide VPN breaks RU-internal services; per-session proxy
// keeps both worlds working in one app.
//
// AUTH HANDLING:
// Electron's setProxy() takes proxyRules without inline credentials
// (socks5://user:pass@host:port is unreliable across platforms).
// We split credentials out and feed them via the WebContents 'login'
// event — the documented, reliable path. NOTE: in Electron 30 the
// 'login' event lives on WebContents (and ClientRequest), NOT on
// Session — this was the source of much overload-resolution pain.

import type { Session, WebContents } from 'electron'
import { session as sessionModule } from 'electron'
import { partitionFor } from './services'

/** Result of parsing a raw proxy URL. */
export interface ParsedProxy {
  /** Rules string for session.setProxy({ proxyRules }), or 'direct://'. */
  proxyRules: string
  /** Extracted credentials, if any. */
  username?: string
  password?: string
  /** Whether this is a direct (no-proxy) config. */
  direct: boolean
  /** Original error if parsing failed (still falls back to direct). */
  error?: string
  /**
   * Optional proxy mode override. When set to 'system', applyProxy
   * calls session.setProxy({ mode: 'system' }) which makes Electron
   * honour the OS/HTTP_PROXY env proxy. Used as the default for
   * services without an explicit user proxy so regionally-blocked
   * services (Telegram in RU) work without manual Smart Proxy config.
   */
  mode?: 'system'
}

/**
 * Parse a raw proxy URL into rules + credentials.
 *
 * Accepted forms:
 *   ''                          -> direct
 *   'direct://'                 -> direct
 *   'socks5://host:port'        -> no auth
 *   'socks5://user:pass@h:port' -> auth via login handler
 *   'http://[user:pass@]h:port' -> same
 *
 * Also accepts scheme-less 'host:port' (treated as socks5).
 */
export function parseProxy(raw: string): ParsedProxy {
  const input = (raw ?? '').trim()
  if (!input || input.toLowerCase() === 'direct://') {
    return { proxyRules: 'direct://', direct: true }
  }

  try {
    // URL needs a scheme to parse; prepend socks5:// if missing.
    const withScheme = /^[a-z0-9]+:\/\//i.test(input) ? input : `socks5://${input}`
    const u = new URL(withScheme)
    const scheme = u.protocol.replace(':', '') // socks5 | http | https | socks4
    if (!['socks5', 'socks4', 'http', 'https', 'socks'].includes(scheme)) {
      return { proxyRules: 'direct://', direct: true, error: `unsupported scheme: ${scheme}` }
    }
    if (!u.hostname || !u.port) {
      return { proxyRules: 'direct://', direct: true, error: 'missing host or port' }
    }

    const proxyRules = `${scheme}://${u.hostname}:${u.port}`
    const hasAuth = Boolean(u.username || u.password)
    return {
      proxyRules,
      direct: false,
      username: hasAuth ? decodeURIComponent(u.username || '') : undefined,
      password: hasAuth ? decodeURIComponent(u.password || '') : undefined
    }
  } catch (e) {
    return { proxyRules: 'direct://', direct: true, error: (e as Error).message }
  }
}

// ─── Auth credential store (per partition) ──────────────────
// WebContents 'login' handlers read from here. applyProxy() updates
// the entry for a partition; view-manager installs one login handler
// per view that reads via its partition.
const credsByPartition = new Map<string, { username: string; password: string }>()

/**
 * Install a 'login' handler on a WebContents that supplies proxy
 * credentials for its owning service's partition.
 *
 * Call once per view at creation time (before loadURL). The handler
 * reads from the creds map, so applyProxy() updates take effect
 * without re-installing.
 */
export function attachLoginHandler(wc: WebContents, serviceId: string): void {
  const partition = partitionFor(serviceId)
  // WebContents 'login' signature (Electron 30):
  //   (event, request, authInfo, callback)
  // authInfo.isProxy distinguishes proxy auth from web Basic Auth.
  wc.on('login', (_event, _request, authInfo, callback) => {
    if (authInfo.isProxy) {
      const c = credsByPartition.get(partition)
      if (c) {
        callback(c.username, c.password)
        return
      }
    }
    callback(undefined, undefined)
  })
}

/**
 * Apply a parsed proxy to a session and update the credential store.
 *
 * The login handlers installed via attachLoginHandler read the new
 * creds on the next proxy challenge.
 *
 * Returns the proxyRules string that was set (for logging / UI).
 */
export async function applyProxy(
  serviceId: string,
  parsed: ParsedProxy
): Promise<string> {
  const partition = partitionFor(serviceId)
  const ses: Session = sessionModule.fromPartition(partition)

  if (parsed.mode === 'system') {
    // Honour the OS / HTTP_PROXY env proxy. Returns a sentinel for logs.
    await ses.setProxy({ mode: 'system' })
    return 'system'
  }

  await ses.setProxy({ proxyRules: parsed.proxyRules })

  if (!parsed.direct && parsed.username != null) {
    credsByPartition.set(partition, {
      username: parsed.username,
      password: parsed.password ?? ''
    })
  } else {
    credsByPartition.delete(partition)
  }

  return parsed.proxyRules
}

/**
 * Read the system proxy from environment variables (HTTP_PROXY /
 * HTTPS_PROXY / ALL_PROXY) and apply it explicitly to a service's
 * session. Used as the default for services without a user-configured
 * Smart Proxy, so regionally-blocked services (Telegram in RU) work
 * out of the box when the user has a proxy configured at the OS level.
 *
 * We do NOT rely on Electron's {mode:'system'} — it is unreliable
 * across Electron versions and ignores env vars in some builds.
 * Reading env and applying proxyRules explicitly is robust.
 *
 * Returns the proxy URL applied, or 'direct' if none found.
 */
export async function applySystemProxy(serviceId: string): Promise<string> {
  const partition = partitionFor(serviceId)
  const ses: Session = sessionModule.fromPartition(partition)

  // Prefer ALL_PROXY (socks), then HTTPS_PROXY, then HTTP_PROXY,
  // then TELEGRAM_PROXY_URL (heretic-os.env convention).
  const env = process.env
  let chosen = (
    env['ALL_PROXY'] || env['all_proxy'] ||
    env['HTTPS_PROXY'] || env['https_proxy'] ||
    env['HTTP_PROXY'] || env['http_proxy'] ||
    env['TELEGRAM_PROXY_URL'] ||
    ''
  ).trim()

  // On this host :7890 is SOCKS (xray), not HTTP — rewrite mistaken scheme.
  if (/^https?:\/\/(127\.0\.0\.1|localhost):7890$/i.test(chosen)) {
    chosen = 'socks5://127.0.0.1:7890'
  }

  if (!chosen) {
    await ses.setProxy({ proxyRules: 'direct://' })
    return 'direct'
  }

  const parsed = parseProxy(chosen)
  if (parsed.error || parsed.direct) {
    await ses.setProxy({ proxyRules: 'direct://' })
    return 'direct'
  }

  await ses.setProxy({ proxyRules: parsed.proxyRules })
  if (parsed.username != null) {
    credsByPartition.set(partition, {
      username: parsed.username,
      password: parsed.password ?? ''
    })
  }

  console.log(
    `[vox-internum:proxy] ${serviceId} using system proxy ${parsed.proxyRules}` +
      (parsed.username ? ' (with auth)' : '')
  )
  return parsed.proxyRules
}
