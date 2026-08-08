// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — IMAP Protocol Parser
// ═══════════════════════════════════════════════════════════
// Pure parser for IMAP4rev1 server responses (RFC 9051). The
// transport layer (TLS socket) lives in connection.ts. This file
// knows nothing about sockets — it consumes byte buffers and emits
// structured response lines. Keeping it pure makes it unit-testable
// without a real IMAP server.
//
// The hard part: IMAP responses are LINE-delimited (CRLF), BUT a
// line may contain a LITERAL {N}\r\n followed by N raw bytes. Those
// bytes can themselves contain CRLF (e.g. a base64 attachment or
// multipart body), so we cannot naively split on \r\n. We parse a
// byte buffer incrementally, expanding any literal we encounter.

/** A single parsed IMAP server response line. */
export interface ImapResponse {
  /** "*" untagged, "A1" tagged, "+" continuation. */
  tag: string
  /** The full text payload after the tag (or after "+ "). */
  text: string
  /** Raw bytes that this response occupied (for debug). */
  bytes: number
}

/**
 * Stateful parser fed by the socket. Call .feed(chunk: Buffer) with
 * incoming bytes; it returns the complete ImapResponse[] it could
 * extract. Partial lines are buffered until more data arrives.
 *
 * This is the only correct way to parse IMAP — line-splitting is
 * unsafe because of literals, and responses can arrive in arbitrary
 * TCP segment boundaries.
 */
export class ImapParser {
  private buf = Buffer.alloc(0)

  /** Feed a chunk of bytes, return all complete responses parsed. */
  feed(chunk: Buffer): ImapResponse[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: ImapResponse[] = []
    // Loop: each iteration tries to extract exactly one response.
    // If it can't (incomplete), we stop and wait for more data.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = this.tryParseOne()
      if (!r) break
      out.push(r.resp)
      this.buf = this.buf.subarray(r.consumed)
    }
    return out
  }

  /** Reset internal buffer (used after reconnect). */
  reset(): void {
    this.buf = Buffer.alloc(0)
  }

  /**
   * Attempt to extract one response from the start of buf.
   * Returns the response + number of bytes consumed, or null if
   * the buffer doesn't yet contain a complete response.
   */
  private tryParseOne(): { resp: ImapResponse; consumed: number } | null {
    let i = 0
    let text = ''

    // Read tokens, expanding literals as we go.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Find next CRLF from current position.
      const crlf = this.buf.indexOf('\r\n', i, 'ascii')
      if (crlf === -1) {
        // No CRLF at all yet — wait for more.
        return null
      }
      // Accumulate the line up to this CRLF.
      const linePart = this.buf.subarray(i, crlf).toString('ascii')
      text += linePart

      // Check if linePart ends with a literal introducer: {NNN}
      const litMatch = text.match(/\{(\d+)\}\s*$/)
      if (litMatch) {
        const litLen = parseInt(litMatch[1], 10)
        const litStart = crlf + 2 // skip CRLF after {NNN}
        const litEnd = litStart + litLen
        if (litEnd > this.buf.length) {
          // Literal bytes not fully arrived — wait for more.
          return null
        }
        // Append the raw literal bytes (as latin1 — we preserve bytes;
        // callers interpret them per their charset).
        text = text.slice(0, text.length - litMatch[0].length)
        const literal = this.buf.subarray(litStart, litEnd).toString('latin1')
        text += literal
        i = litEnd
        // Continue the loop: there may be more text on the line after
        // the literal (e.g. "...{5}\r\nHELLO) more text\r\n").
        continue
      }

      // No literal pending → this CRLF ends the response.
      const consumed = crlf + 2
      const resp = parseLine(text)
      return { resp: { ...resp, bytes: consumed }, consumed }
    }
  }
}

/**
 * Parse a complete IMAP response line (literals already inlined)
 * into tag + text. The text retains any literal bytes embedded.
 *
 *   "* OK [CAPABILITY ...] ready"          → { tag: '*', text: 'OK [...]' }
 *   "A1 OK LOGIN completed"                → { tag: 'A1', text: 'OK LOGIN completed' }
 *   "+ " (continuation for AUTHENTICATE)   → { tag: '+', text: '' }
 */
function parseLine(text: string): ImapResponse {
  // Continuation requests start with '+'.
  if (text.startsWith('+')) {
    // RFC: "+ " then optional base64. We strip the leading "+ ".
    const rest = text.startsWith('+ ') ? text.slice(2) : text.slice(1)
    return { tag: '+', text: rest, bytes: 0 }
  }
  // Untagged responses start with '* '.
  if (text.startsWith('* ')) {
    return { tag: '*', text: text.slice(2), bytes: 0 }
  }
  // Tagged responses: "<tag> <rest>". Tag is the first token.
  const sp = text.indexOf(' ')
  if (sp === -1) {
    // Malformed; treat whole as tag.
    return { tag: text, text: '', bytes: 0 }
  }
  return { tag: text.slice(0, sp), text: text.slice(sp + 1), bytes: 0 }
}

// ─── Tagged-response classification ─────────────────────────
// After parsing, callers need to know if a tagged response means
// OK (success) or NO/BAD (failure).

export type TaggedStatus = 'OK' | 'NO' | 'BAD' | 'OTHER'

export function classifyTagged(resp: ImapResponse): TaggedStatus {
  if (resp.text.startsWith('OK ')) return 'OK'
  if (resp.text.startsWith('NO ')) return 'NO'
  if (resp.text.startsWith('BAD ')) return 'BAD'
  return 'OTHER'
}

// ─── Untagged-response extraction helpers ───────────────────
// Useful for pulling CAPABILITY/LIST/STATUS data out of the
// untagged "* ..." stream.

/** Extract the response CODE (the word right after *) — OK/BYE/LIST/STATUS/FETCH/EXISTS/etc. */
export function untaggedCode(resp: ImapResponse): string {
  // The first token of the text. For "* 1 FETCH ..." text is
  // "1 FETCH ..." so the code is actually the second token — but
  // for most responses it's the first. We handle both: number prefix.
  const m = resp.text.match(/^(\d+)\s+(\S+)/)
  if (m) return m[2]
  const sp = resp.text.indexOf(' ')
  return sp === -1 ? resp.text : resp.text.slice(0, sp)
}

/**
 * Extract CAPABILITY list from an untagged "* CAPABILITY a b c" line.
 * Returns the lowercased capability tokens (e.g. ['imap4rev1','starttls']).
 */
export function parseCapability(resp: ImapResponse): string[] {
  // text = "CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN"
  if (!resp.text.startsWith('CAPABILITY ')) return []
  return resp.text.slice('CAPABILITY '.length).split(/\s+/).map((s) => s.toLowerCase())
}

/**
 * Parse "* OK [CAPABILITY a b c] greeting" — the initial greeting
 * often carries capability in a bracketed response code.
 */
export function parseGreetingCapabilities(resp: ImapResponse): string[] {
  const m = resp.text.match(/\[CAPABILITY ([^\]]+)\]/i)
  if (!m) return []
  return m[1].split(/\s+/).map((s) => s.toLowerCase())
}
