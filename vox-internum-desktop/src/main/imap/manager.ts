// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — IMAP Account Manager
// ═══════════════════════════════════════════════════════════
// Owns the single live ImapClient for the user's Gmail account.
// Lazily connects on first fetch; auto-reconnects if the socket
// drops. Gmail limits concurrent IMAP sessions (~15 per account),
// so we MUST reuse one connection — never open per-request.
//
// The renderer talks to this module via IPC (main/index.ts wires
// the handlers); this manager is the only place that holds the
// open ImapClient.

import { ImapClient, type MailEnvelope, type ParsedMail } from './client'
import {
  hasGmailAccount,
  getGmailEmail,
  getGmailAppPassword,
  GMAIL_IMAP
} from './accounts'

let client: ImapClient | null = null
let connectPromise: Promise<ImapClient> | null = null
let lastMailbox = 'INBOX'

/** True if the user has configured a Gmail account (email + App Password). */
export function isGmailConfigured(): boolean {
  return hasGmailAccount()
}

/** Returns the connected client, connecting lazily if needed. */
async function ensureConnected(): Promise<ImapClient> {
  if (client && client.isConnected()) return client
  if (connectPromise) return connectPromise
  connectPromise = (async () => {
    if (!hasGmailAccount()) {
      throw new Error('Gmail account not configured')
    }
    const c = new ImapClient()
    await c.connect(GMAIL_IMAP, getGmailEmail(), getGmailAppPassword())
    client = c
    return c
  })()
  try {
    return await connectPromise
  } finally {
    connectPromise = null
  }
}

/** Disconnect + drop the cached client. Call on sign-out. */
export async function disconnectGmail(): Promise<void> {
  if (client) {
    try {
      await client.disconnect()
    } catch {
      // ignore
    }
    client = null
  }
}

/**
 * Fetch the inbox: a page of envelopes. Sequence numbers are
 * 1..EXISTS; we page newest-first. `page` is 1-based; `pageSize`
 * defaults to 30. Returns the envelopes + paging metadata so the
 * UI can show "page 2 of 17" and NEXT/PREV buttons.
 */
export async function fetchInboxPage(
  page = 1,
  pageSize = 30
): Promise<{
  list: MailEnvelope[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}> {
  const c = await ensureConnected()
  const sel = await c.selectMailbox(lastMailbox)
  if (sel.exists === 0) {
    return { list: [], page, pageSize, total: 0, totalPages: 0 }
  }
  const totalPages = Math.ceil(sel.exists / pageSize)
  const safePage = Math.min(Math.max(1, page), Math.max(1, totalPages))
  // Newest first: page 1 = top pageSize messages.
  const end = sel.exists - (safePage - 1) * pageSize
  const start = Math.max(1, end - pageSize + 1)
  const list = await c.fetchEnvelopes(`${start}:${end}`)
  // Reverse so newest is first within the page.
  list.reverse()
  return {
    list,
    page: safePage,
    pageSize,
    total: sel.exists,
    totalPages
  }
}

/** Fetch + parse one full message by sequence number. */
export async function fetchMessage(seq: number): Promise<ParsedMail> {
  const c = await ensureConnected()
  return c.fetchMessage(seq)
}

/** Send an outbound message via Gmail SMTP. */
export async function sendGmailMessage(input: {
  to: string
  subject: string
  text: string
  inReplyTo?: string
}): Promise<{ ok: boolean; message?: string }> {
  if (!hasGmailAccount()) {
    return { ok: false, message: 'Gmail account not configured' }
  }
  // Lazy import to keep the SMTP code out of the IMAP connection path.
  const { sendMail } = await import('../smtp/client')
  const { GMAIL_SMTP, getGmailEmail, getGmailAppPassword } = await import('./accounts')
  return sendMail({
    host: GMAIL_SMTP.host,
    port: GMAIL_SMTP.port,
    user: getGmailEmail(),
    password: getGmailAppPassword(),
    from: getGmailEmail(),
    to: input.to,
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo
  })
}
