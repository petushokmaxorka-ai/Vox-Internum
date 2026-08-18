// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Force IPv4 for hosts with broken IPv6
// ═══════════════════════════════════════════════════════════
// agent.minimax.io (Akamai) resolves AAAA but IPv6 is unreachable
// from this network → Chromium Happy-Eyeballs stalls on v6 while
// Firefox / curl -4 load fine.
//
// Strategy (fast + safe):
//   1. Always: disable-ipv6 + dns-result-order=ipv4first (instant).
//   2. If we have a disk cache of MAP rules from a prior run, apply
//      them too (pins exact A records).
//   3. Refresh the cache in the background via Node dns.resolve4
//      for the NEXT launch (host-resolver-rules cannot change after
//      app.whenReady). Never block startup on DNS.

import { resolve4 } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const BROKEN_IPV6_HOSTS = [
  'agent.minimax.io',
  'www.minimax.io',
  'api.minimax.io',
  'platform.minimax.io',
  'account.minimax.io',
  'chat.minimaxi.com',
  'www.minimaxi.com',
  'api.minimaxi.com',
  'platform.minimaxi.com',
  'account.minimaxi.com',
  'agent.minimaxi.com'
]

interface Ipv4CacheFile {
  updatedAt: number
  rules: string
}

function cachePath(): string {
  return join(app.getPath('userData'), 'ipv4-host-map.json')
}

function readCache(): Ipv4CacheFile | null {
  try {
    const p = cachePath()
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Ipv4CacheFile
    if (!raw || typeof raw.rules !== 'string' || !raw.rules) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(rules: string): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const payload: Ipv4CacheFile = { updatedAt: Date.now(), rules }
    writeFileSync(cachePath(), JSON.stringify(payload), 'utf8')
  } catch {
    /* ignore — cache is best-effort */
  }
}

async function resolveIpv4(host: string): Promise<string | null> {
  try {
    const addrs = await resolve4(host)
    const ip = addrs.find((a) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a))
    return ip ?? null
  } catch {
    return null
  }
}

function rulesFromMap(map: Map<string, string>): string {
  const parts: string[] = []
  for (const host of BROKEN_IPV6_HOSTS) {
    const ip = map.get(host)
    if (ip) parts.push(`MAP ${host} ${ip}`)
  }
  return parts.join(', ')
}

async function buildIpv4HostResolverRulesAsync(): Promise<string> {
  const entries = await Promise.all(
    BROKEN_IPV6_HOSTS.map(async (host) => {
      const ip = await resolveIpv4(host)
      return [host, ip] as const
    })
  )
  const map = new Map<string, string>()
  for (const [host, ip] of entries) {
    if (ip) map.set(host, ip)
  }
  return rulesFromMap(map)
}

/** For Chrome CDP spawn — prefer cache; empty if none yet. */
export function buildIpv4HostResolverRules(): string {
  const cached = readCache()
  if (cached?.rules) return cached.rules
  return ''
}

function refreshCacheInBackground(): void {
  void buildIpv4HostResolverRulesAsync()
    .then((rules) => {
      if (rules) {
        writeCache(rules)
        console.log(`[vox-internum:dns] cache refreshed (${rules.split(', ').length} MAP)`)
      }
    })
    .catch(() => undefined)
}

/** Apply before app.whenReady(). Safe to call once at startup. Instant. */
export function applyIpv4HostResolverRules(): string {
  // Instant Chromium knobs — do not wait on DNS.
  app.commandLine.appendSwitch('disable-ipv6')
  app.commandLine.appendSwitch('dns-result-order', 'ipv4first')

  const cached = readCache()
  const rules = cached?.rules ?? ''
  if (rules) {
    app.commandLine.appendSwitch('host-resolver-rules', rules)
    console.log(`[vox-internum:dns] IPv4 force [cache]: ${rules}`)
  } else {
    console.log('[vox-internum:dns] ipv4first + disable-ipv6 (MAP cache empty; refreshing)')
  }

  // Populate / refresh cache for next launch. Never blocks this start.
  refreshCacheInBackground()
  return rules
}
