// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Service Registry
// ═══════════════════════════════════════════════════════════
// The list of messengers aggregated by Vox Internum.
// Each gets an isolated session partition (persist:vox-internum-<id>),
// so cookies/cache/localStorage are fully separated between services.
//
// To add a service: append here. Sidebar, views, badges all derive
// from this single source.

import type { ServiceConfig } from '../shared/types'

export const SERVICES: ServiceConfig[] = [
  // ── Messengers ────────────────────────────────────────────
  {
    id: 'telegram',
    label: 'TG',
    name: 'Telegram',
    // /k/ — K-team variant, best-behaved for embedding in Electron.
    url: 'https://web.telegram.org/k/',
    category: 'messenger'
  },
  {
    id: 'whatsapp',
    label: 'WA',
    name: 'WhatsApp',
    url: 'https://web.whatsapp.com/',
    category: 'messenger'
  },
  {
    id: 'vk',
    label: 'VK',
    name: 'VK Messenger',
    url: 'https://vk.com/im',
    category: 'messenger'
  },
  {
    id: 'max',
    label: 'MX',
    name: 'MAX',
    url: 'https://web.max.ru/',
    category: 'messenger'
  },
  // ── Mail relays ───────────────────────────────────────────
  {
    id: 'gmail',
    label: 'GM',
    name: 'Gmail',
    // No web URL — Google blocks Electron sign-in. Rendered natively
    // via IMAP. See renderer/gmail-imap.ts.
    url: '',
    category: 'mail',
    kind: 'native'
  },
  {
    id: 'yandex',
    label: 'YX',
    name: 'Yandex Mail',
    url: 'https://mail.yandex.ru/',
    category: 'mail'
  },
  {
    id: 'mailru',
    label: 'MR',
    name: 'Mail.ru',
    url: 'https://e.mail.ru/inbox/',
    category: 'mail'
  }
]

/** Partition name for a service — persisted across restarts. */
export function partitionFor(serviceId: string): string {
  return `persist:vox-internum-${serviceId}`
}

/** Default service shown on first launch. */
export const DEFAULT_SERVICE = 'telegram'

export function findService(id: string): ServiceConfig | undefined {
  return SERVICES.find((s) => s.id === id)
}
