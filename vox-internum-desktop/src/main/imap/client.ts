// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — IMAP High-level Client
// ═══════════════════════════════════════════════════════════
// Wraps ImapConnection to provide the operations Vox Internum's
// mail UI needs:
//   - listMailboxes(): LIST "" "*" → array of mailbox paths
//   - selectMailbox(name): SELECT INBOX → {exists, uidvalidity}
//   - fetchEnvelopes(start, end): FETCH n:m ENVELOPE → headers list
//
// This is the surface the renderer calls via IPC. Parsing of FETCH
// envelope bodies (RFC 2822 nested parens) is intentionally minimal
// here — full MIME is Phase 2.

import { ImapConnection } from './connection'
import { parseMessage } from './mime/parser'
import { findPlainText, findHtml, collectAttachments } from './mime/parser'

export interface MailboxInfo {
  name: string
  /** \HasChildren, \Noselect, etc. — raw flags string. */
  flags: string
  /** Delimiter (usually "." for dovecot, "/" for Gmail). */
  delimiter: string
}

export interface SelectResult {
  exists: number
  /** UIDVALIDITY value from the SELECT response. */
  uidValidity: number
}

export interface MailEnvelope {
  seq: number
  date: string
  subject: string
  from: string
  to: string
  /** Inferred unread state from \Recent or \Seen absence — best-effort. */
  recent: boolean
}

/**
 * High-level IMAP client. Owns one ImapConnection and exposes
 * promise-based methods for the operations Vox Internum needs.
 * Construct one per mail account; reuse across operations; destroy
 * via disconnect() when the user signs out.
 */
export class ImapClient {
  private conn: ImapConnection

  constructor() {
    this.conn = new ImapConnection()
  }

  /** Connect + login in one shot. */
  async connect(
    opts: { host: string; port: number },
    user: string,
    pass: string
  ): Promise<void> {
    await this.conn.connect(opts)
    await this.conn.login(user, pass)
  }

  async disconnect(): Promise<void> {
    await this.conn.logout()
  }

  /** True if the underlying connection is alive and authenticated. */
  isConnected(): boolean {
    return this.conn.state === 'AUTHENTICATED' || this.conn.state === 'SELECTED'
  }

  /**
   * LIST all mailboxes. Returns parsed MailboxInfo[].
   * Untagged LIST responses look like:
   *   LIST (\HasNoChildren) "." "INBOX"
   *   LIST (\HasChildren) "." "Trash"
   */
  async listMailboxes(): Promise<MailboxInfo[]> {
    const { untagged } = await this.conn.runWithUntagged('LIST "" "*"')
    const out: MailboxInfo[] = []
    for (const u of untagged) {
      if (!u.text.startsWith('LIST ')) continue
      // Parse: LIST (\\Flags) "delim" "Name"
      // The flags are in parens; the delimiter and name are quoted.
      const m = u.text.match(/^LIST\s+(\([^)]*\)|NIL)\s+"(.)"\s+"([^"]*)"$/)
      if (m) {
        out.push({
          flags: m[1].replace(/[()\\]/g, ''),
          delimiter: m[2],
          name: m[3]
        })
      }
    }
    return out
  }

  /**
   * SELECT a mailbox. Returns the EXISTS count + UIDVALIDITY.
   * Switches connection state to SELECTED.
   */
  async selectMailbox(name: string): Promise<SelectResult> {
    const { untagged } = await this.conn.runWithUntagged(`SELECT "${name}"`)
    let exists = 0
    let uidValidity = 0
    for (const u of untagged) {
      const e = u.text.match(/^(\d+)\s+EXISTS$/)
      if (e) exists = parseInt(e[1], 10)
      const uv = u.text.match(/UIDVALIDITY\s+(\d+)/i)
      if (uv) uidValidity = parseInt(uv[1], 10)
    }
    return { exists, uidValidity: uidValidity }
  }

  /**
   * FETCH envelopes for a sequence range (e.g. "1:10").
   * Returns parsed envelopes with seq/date/subject/from.
   *
   * Untagged FETCH responses look like (one per message):
   *   * 5 FETCH (ENVELOPE ("Date" "Subject" (("From"NIL"addr"(...))) ...))
   *
   * We use a defensive regex + paren-trimming rather than a full
   * S-expression parser — envelopes are predictable enough for the
   * header fields Vox Internum shows in the inbox list. Full MIME
   * parsing of message bodies is Phase 2.
   */
  async fetchEnvelopes(range: string): Promise<MailEnvelope[]> {
    const { untagged } = await this.conn.runWithUntagged(
      `FETCH ${range} (ENVELOPE FLAGS)`
    )
    const out: MailEnvelope[] = []
    for (const u of untagged) {
      // u.text like: "5 FETCH (ENVELOPE (...) FLAGS (\Recent))"
      const seqMatch = u.text.match(/^(\d+)\s+FETCH\s+\((.*)\)\s*$/s)
      if (!seqMatch) continue
      const seq = parseInt(seqMatch[1], 10)
      const body = seqMatch[2]
      // Pull the ENVELOPE (...) sub-list. Find the balanced parens.
      const envStr = extractParen(body, 'ENVELOPE')
      if (!envStr) continue
      const flagsStr = extractParen(body, 'FLAGS')
      const env = parseEnvelope(envStr)
      out.push({
        seq,
        date: env.date,
        subject: env.subject,
        from: env.from,
        to: env.to,
        recent: /\\Recent/i.test(flagsStr || '')
      })
    }
    return out
  }

  /**
   * Fetch the full RFC822 body for a single message and parse it
   * into a ParsedMail tree. Use this when the user opens a message
   * in the reading pane — envelopes only have headers, this gives
   * you the decoded text/html and attachments list.
   *
   * IMAP literal: "* SEQ FETCH (RFC822 {NNN}\r\n<raw message>\r\n)"
   * The parser already inlined the literal in the response text;
   * we extract RFC822 (...) and feed it to parseMessage.
   */
  async fetchMessage(seq: number): Promise<ParsedMail> {
    const { untagged } = await this.conn.runWithUntagged(
      `FETCH ${seq} RFC822`
    )
    let raw = ''
    for (const u of untagged) {
      // u.text: "5 FETCH (RFC822 {NNN}\r\nfull message\r\n)"
      const m = u.text.match(/^\d+\s+FETCH\s+\(RFC822\s+(.*)\)\s*$/s)
      if (m) {
        raw = m[1]
        break
      }
    }
    if (!raw) throw new Error('FETCH RFC822 returned no body')
    const tree = parseMessage(raw)
    return {
      seq,
      text: findPlainText(tree) || stripHtml(findHtml(tree)),
      html: findHtml(tree),
      attachments: collectAttachments(tree).map((a) => ({
        filename: a.filename || 'untitled',
        type: a.type,
        size: Buffer.byteLength(a.text, 'latin1')
      }))
    }
  }
}

/** A fetched, decoded, ready-to-render message. */
export interface ParsedMail {
  seq: number
  /** Best plain-text body for display (plain preferred, else stripped html). */
  text: string
  /** HTML body if available (UI sanitizes before render). */
  html: string
  /** Attachment metadata (binary bodies fetched separately via fetchAttachment). */
  attachments: Array<{ filename: string; type: string; size: number }>
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Strip HTML tags + collapse whitespace. Used when a message has no
 * text/plain part — we fall back to de-tagged HTML. Crude but
 * sufficient for an inbox preview; the reading pane shows real HTML.
 */
function stripHtml(html: string): string {
  if (!html) return ''
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Paren / envelope helpers ───────────────────────────────

/**
 * Find the balanced parenthesised group following `KEY` in body.
 * Returns the inner text (without outer parens) or '' if not found.
 * IMAP uses nested parens heavily; we can't regex-match a group
 * with arbitrary nesting, so we count paren depth.
 */
function extractParen(body: string, key: string): string {
  const idx = body.indexOf(key)
  if (idx === -1) return ''
  let i = body.indexOf('(', idx + key.length)
  if (i === -1) return ''
  let depth = 1
  const start = i + 1
  i++
  // Walk and track depth. Respect double-quoted strings so parens
  // inside strings don't break counting.
  let inQuote = false
  while (i < body.length && depth > 0) {
    const c = body[i]
    if (inQuote) {
      if (c === '\\' && i + 1 < body.length) {
        i += 2
        continue
      }
      if (c === '"') inQuote = false
      i++
      continue
    }
    if (c === '"') inQuote = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  if (depth !== 0) return '' // unbalanced
  return body.slice(start, i - 1)
}

/**
 * Parse an ENVELOPE parenthesised body. The structure (RFC 3501 §7.4.2):
 *   ENVELOPE = (date subject from sender reply-to to cc bcc
 *               in-reply-to message-id)
 * Each of from/sender/.../cc/bcc is NIL or a parenthesized list of
 * (personal-name smtp-name mailbox-name host-name) address tuples,
 * themselves wrapped in another paren list.
 *
 * We extract the first few fields with a forgiving strategy: split
 * top-level by spaces (respecting strings/NIL), then for from/to
 * pull out the first mailbox@host.
 */
function parseEnvelope(env: string): {
  date: string
  subject: string
  from: string
  to: string
} {
  // Top-level tokens: date, subject, from, sender, reply-to, to, cc, bcc, ...
  const tokens = splitTopLevel(env)
  const date = decodeAtom(tokens[0])
  const subject = decodeAtom(tokens[1])
  const from = extractFirstAddress(tokens[2])
  // to is index 5 (after sender at 3, reply-to at 4)
  const to = extractFirstAddress(tokens[5])
  return { date, subject, from, to }
}

/** Split a parenthesised body by top-level spaces, respecting "strings". */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inQuote = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuote) {
      cur += c
      if (c === '\\' && i + 1 < s.length) {
        cur += s[++i]
        continue
      }
      if (c === '"') inQuote = false
      continue
    }
    if (c === '"') {
      inQuote = true
      cur += c
      continue
    }
    if (c === '(') {
      depth++
      cur += c
      continue
    }
    if (c === ')') {
      depth--
      cur += c
      continue
    }
    if (c === ' ' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** Decode an envelope atom: NIL, "quoted string", or bare token. */
function decodeAtom(s: string): string {
  if (s === 'NIL') return ''
  if (s.startsWith('"') && s.endsWith('"')) {
    // Unescape and decode RFC 2047 encoded-words (?charset?encoding?text?).
    const inner = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    return decodeEncodedWords(inner)
  }
  return decodeEncodedWords(s)
}

/**
 * Decode RFC 2047 encoded-words: =?UTF-8?B?...?= or =?UTF-8?Q?...?=
 * Subjects with Cyrillic/special chars are encoded this way.
 */
function decodeEncodedWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _cs, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        // Base64
        return Buffer.from(text, 'base64').toString('utf8')
      }
      // Quoted-Printable
      return text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_x: string, h: string) =>
          String.fromCharCode(parseInt(h, 16))
        )
    } catch {
      return text
    }
  })
}

/**
 * Extract "mailbox@host" from an address-list token.
 * The token is either "NIL" or "((personal smtp mailbox host) (...))".
 * We grab the first tuple's mailbox + host.
 */
function extractFirstAddress(addrListToken: string): string {
  if (addrListToken === 'NIL' || !addrListToken) return ''
  // Strip outer parens: ((...)(...)) → (...)(...)
  let s = addrListToken
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1)
  // First tuple: (personal smtp mailbox host)
  const tupleMatch = s.match(/^\(([^)]*)\)/)
  if (!tupleMatch) return ''
  const parts = splitTopLevel(tupleMatch[1])
  const mailbox = decodeAtom(parts[2] || '')
  const host = decodeAtom(parts[3] || '')
  if (mailbox && host) return `${mailbox}@${host}`
  return mailbox || host
}
