// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — SMTP Client (Raw TLS, RFC 5321)
// ═══════════════════════════════════════════════════════════
// Sends mail via Gmail's SMTP (smtp.gmail.com:465, implicit TLS).
// AUTH LOGIN with base64 user + App Password. Minimal — no
// STARTTLS upgrade path (we always use implicit TLS on 465).
//
// One connection per send (simpler than pooled; Gmail tolerates
// this for personal-volume mail). Caller passes the already-decrypted
// App Password — this module never touches storage.

import { connect as tlsConnect, type TLSSocket } from 'tls'

export interface SmtpSendOptions {
  host: string
  port: number
  user: string
  password: string
  from: string
  to: string
  subject: string
  text: string
  /** Optional in-reply-to Message-ID (for threading replies). */
  inReplyTo?: string
}

export interface SmtpSendResult {
  ok: boolean
  /** Server message on success or error detail on failure. */
  message: string
}

/**
 * Send a plain-text email via SMTP. Returns ok:true on 250 queued.
 * Throws never — failures return { ok:false, message }.
 *
 * SMTP dialogue (simplified):
 *   S: 220 smtp.gmail.com ESMTP
 *   C: EHLO vox-internum
 *   S: 250 ...
 *   C: AUTH LOGIN
 *   S: 334 VXNlcm5hbWU6            (base64 "Username:")
 *   C: <base64 user>
 *   S: 334 UGFzc3dvcmQ6            (base64 "Password:")
 *   C: <base64 pass>
 *   S: 235 2.7.0 Accepted
 *   C: MAIL FROM:<user@gmail.com>
 *   S: 250 2.1.0 OK
 *   C: RCPT TO:<recipient@x.com>
 *   S: 250 2.1.5 OK
 *   C: DATA
 *   S: 354  Go ahead
 *   C: <headers>\r\n\r\n<body>\r\n.\r\n
 *   S: 250 2.0.0 OK <msgid>
 *   C: QUIT
 */
export async function sendMail(opts: SmtpSendOptions): Promise<SmtpSendResult> {
  let sock: TLSSocket | null = null
  try {
    sock = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ host: opts.host, port: opts.port, servername: opts.host })
      s.setTimeout(15000)
      s.once('secureConnect', () => {
        s.setTimeout(0)
        resolve(s)
      })
      s.once('timeout', () => reject(new Error('SMTP connect timeout')))
      s.once('error', (e) => reject(new Error(`SMTP TLS: ${e.message}`)))
    })

    const dialogue = new SmtpDialogue(sock)
    // 220 greeting
    const greet = await dialogue.readLine()
    if (!greet.startsWith('220')) return { ok: false, message: `greeting: ${greet}` }

    // EHLO
    const ehlo = await dialogue.command('EHLO vox-internum\r\n')
    if (!ehlo.startsWith('250')) return { ok: false, message: `EHLO: ${ehlo}` }

    // AUTH LOGIN
    const authStart = await dialogue.command('AUTH LOGIN\r\n')
    if (!authStart.startsWith('334')) return { ok: false, message: `AUTH: ${authStart}` }
    // Server asks for username (base64 "Username:")
    const userResp = await dialogue.command(Buffer.from(opts.user).toString('base64') + '\r\n')
    if (!userResp.startsWith('334')) return { ok: false, message: `user: ${userResp}` }
    // Server asks for password
    const passResp = await dialogue.command(Buffer.from(opts.password).toString('base64') + '\r\n')
    if (!passResp.startsWith('235')) return { ok: false, message: `auth failed: ${passResp}` }

    // MAIL FROM / RCPT TO
    const mail = await dialogue.command(`MAIL FROM:<${opts.from}>\r\n`)
    if (!mail.startsWith('250')) return { ok: false, message: `MAIL FROM: ${mail}` }
    // Allow comma-separated recipients
    const recipients = opts.to.split(',').map((s) => s.trim()).filter(Boolean)
    for (const r of recipients) {
      const rcpt = await dialogue.command(`RCPT TO:<${r}>\r\n`)
      if (!rcpt.startsWith('250')) return { ok: false, message: `RCPT TO ${r}: ${rcpt}` }
    }

    // DATA — build RFC 5322 message
    const data = await dialogue.command('DATA\r\n')
    if (!data.startsWith('354')) return { ok: false, message: `DATA: ${data}` }

    const date = new Date().toUTCString()
    const headers = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${encodeHeader(opts.subject)}`,
      `Date: ${date}`,
      `Message-ID: <${Date.now()}.${randHex(8)}@vox-internum>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`
    ]
    if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`)
    const body = toQuotedPrintable(opts.text || '')
    const raw = headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.\r\n'
    const endResp = await dialogue.command(raw)
    if (!endResp.startsWith('250')) return { ok: false, message: `queue: ${endResp}` }

    // QUIT
    void dialogue.command('QUIT\r\n').catch(() => undefined)
    return { ok: true, message: endResp }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  } finally {
    sock?.destroy()
  }
}

// ─── Helpers ────────────────────────────────────────────────

/** Minimal SMTP dialogue: line-buffered reader + raw writer. */
class SmtpDialogue {
  private sock: TLSSocket
  private buf = ''
  constructor(sock: TLSSocket) {
    this.sock = sock
  }
  /** Read one CRLF-terminated server line (multiline 250-foo folded into last). */
  readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const onTimeout = (): void => reject(new Error('SMTP read timeout'))
      this.sock.setTimeout(15000)
      this.sock.once('timeout', onTimeout)
      const tryRead = (): void => {
        const i = this.buf.indexOf('\r\n')
        if (i !== -1) {
          const line = this.buf.slice(0, i)
          this.buf = this.buf.slice(i + 2)
          // Multiline response: "250-first\r\n250 last\r\n" — keep reading
          // while the 4th char is '-'.
          if (line.length >= 4 && line[3] === '-') {
            tryRead()
            return
          }
          this.sock.removeListener('timeout', onTimeout)
          this.sock.setTimeout(0)
          resolve(line)
        }
      }
      this.sock.on('data', (c: Buffer) => {
        this.buf += c.toString('latin1')
        tryRead()
      })
      tryRead()
    })
  }
  /** Send a command, await the response line. */
  async command(cmd: string): Promise<string> {
    this.sock.write(cmd, 'latin1')
    return this.readLine()
  }
}

/** RFC 2047 encode header if it contains non-ASCII (e.g. Cyrillic subject). */
function encodeHeader(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

/** RFC 2045 quoted-printable encode for the body. */
function toQuotedPrintable(s: string): string {
  const bytes = Buffer.from(s, 'utf8')
  let out = ''
  let lineLen = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    let seg: string
    if (b === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) {
      out += '\r\n'
      lineLen = 0
      i++
      continue
    }
    if (b === 0x0a) {
      out += '\r\n'
      lineLen = 0
      continue
    }
    if (b === 0x20 || b === 0x09 || (b >= 0x21 && b <= 0x7e)) {
      seg = String.fromCharCode(b)
    } else {
      seg = '=' + b.toString(16).toUpperCase().padStart(2, '0')
    }
    // Soft-wrap at 76 cols. Reserve 1 char for the leading '=' soft break.
    if (lineLen + seg.length > 75) {
      out += '=\r\n'
      lineLen = 0
    }
    out += seg
    lineLen += seg.length
  }
  return out
}

function randHex(n: number): string {
  return Array.from(randomBytesInit(n), (b) => b.toString(16).padStart(2, '0')).join('')
}
function randomBytesInit(n: number): Uint8Array {
  // Lazy import to avoid top-level crypto binding in renderer builds.
  const { randomBytes } = require('crypto') as typeof import('crypto')
  return randomBytes(n)
}
