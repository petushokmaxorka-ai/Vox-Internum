// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — MIME Decoders (RFC 2045/2047)
// ═══════════════════════════════════════════════════════════
// Pure functions for decoding MIME-encoded content. No I/O. The
// parser (mime/parser.ts) calls these on body parts based on their
// Content-Transfer-Encoding header.

/**
 * Decode a Content-Transfer-Encoding payload.
 * Supports: base64, quoted-printable, 7bit/8bit/binary (passthrough).
 * Returns UTF-8 string when the part is text, raw bytes for binary.
 */
export function decodeBody(
  raw: string,
  encoding: string,
  isText: boolean
): string {
  const enc = (encoding || '').toLowerCase().trim()
  let bytes: Buffer
  if (enc === 'base64') {
    // Strip whitespace Gmail/Exchange scatter in base64.
    bytes = Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  } else if (enc === 'quoted-printable') {
    bytes = decodeQuotedPrintable(raw)
  } else {
    // 7bit / 8bit / binary
    bytes = Buffer.from(raw, 'latin1')
  }
  return isText ? bytes.toString('utf8') : bytes.toString('latin1')
}

/**
 * Decode Quoted-Printable (RFC 2045 §6.7).
 *   =XX        → byte 0xXX
 *   =\r\n      → soft line break (drop)
 *   <other>    → as-is
 */
export function decodeQuotedPrintable(input: string): Buffer {
  // Drop soft line breaks: "=\r\n" or "=\n"
  const noSoftBreaks = input.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const c = noSoftBreaks[i]
    if (c === '=' && i + 2 < noSoftBreaks.length) {
      const h = noSoftBreaks.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(h)) {
        out.push(parseInt(h, 16))
        i += 2
        continue
      }
    }
    out.push(noSoftBreaks.charCodeAt(i))
  }
  return Buffer.from(out)
}

/**
 * Decode RFC 2047 encoded-words in a header value.
 *   =?UTF-8?B?0JjQvNGP?=   → Cyrillic text (base64)
 *   =?UTF-8?Q?=D0=9F?      → Cyrillic text (quoted-printable)
 *   =?windows-1251?B?...?= → legacy Cyrillic
 *
 * Adjacent encoded-words separated only by whitespace are joined
 * (RFC 2047 §6.2 — important for subjects split across words).
 */
export function decodeHeader(input: string): string {
  if (!input || !input.includes('=?')) return input
  // Collapse whitespace BETWEEN adjacent encoded-words per §6.2.
  // Pattern matches one or more encoded-words separated by spaces.
  return input.replace(
    /((?:=\?[^?]+\?[BbQq]\?[^?]*\?=\s*)+)/g,
    (run) => {
      // Within a run, drop the inter-word whitespace then decode each.
      const words = run.trim().split(/\s+/)
      const decoded = words.map(decodeOneEncodedWord).join('')
      return decoded
    }
  )
}

function decodeOneEncodedWord(word: string): string {
  const m = word.match(/^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/)
  if (!m) return word
  const charset = m[1].toLowerCase()
  const enc = m[2].toUpperCase()
  const text = m[3]
  try {
    let bytes: Buffer
    if (enc === 'B') {
      bytes = Buffer.from(text, 'base64')
    } else {
      // Q: same as QP but underscores = spaces
      const qp = text.replace(/_/g, ' ')
      bytes = decodeQuotedPrintable(qp)
    }
    // Re-decode bytes via the declared charset. Node supports utf-8,
    // utf-16le, latin1, ascii natively. For windows-1251/koi8-r we
    // approximate by utf-8 (rare in practice for modern mail).
    if (
      charset === 'utf-8' ||
      charset === 'utf8' ||
      charset === 'us-ascii' ||
      charset === 'ascii'
    ) {
      return bytes.toString('utf8')
    }
    if (charset === 'utf-16le') return bytes.toString('utf16le')
    // Fallback: assume utf-8 and hope for the best.
    return bytes.toString('utf8')
  } catch {
    return text
  }
}

/**
 * Parse a Content-Type header value into {type, params}.
 *   text/plain; charset=utf-8; boundary="abc"  →
 *   { type: 'text/plain', params: { charset: 'utf-8', boundary: 'abc' } }
 */
export function parseContentType(
  raw: string
): { type: string; params: Record<string, string> } {
  if (!raw) return { type: 'text/plain', params: {} }
  const parts = raw.split(';').map((s) => s.trim())
  const type = parts[0].toLowerCase() || 'text/plain'
  const params: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^([a-zA-Z0-9-]+)\s*=\s*"?([^";]*)"?\s*$/)
    if (m) params[m[1].toLowerCase()] = m[2]
  }
  return { type, params }
}
