// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — IMAP Parser Unit Tests
// ═══════════════════════════════════════════════════════════
// Tests the pure parser without a network. Run:
//   tsc -p tsconfig.test.json && node --test scripts/test-imap.mjs
//
// For live connection tests against a real IMAP server (gmail/
// yandex), set env vars IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS
// and run scripts/test-imap-live.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ImapParser,
  classifyTagged,
  parseGreetingCapabilities,
  parseCapability
} from '../out/test-src/main/imap/protocol.js'

test('ImapParser: single tagged OK line', () => {
  const p = new ImapParser()
  const r = p.feed(Buffer.from('A1 OK LOGIN completed\r\n'))
  assert.equal(r.length, 1)
  assert.equal(r[0].tag, 'A1')
  assert.equal(r[0].text, 'OK LOGIN completed')
})

test('ImapParser: untagged greeting with CAPABILITY response-code', () => {
  const p = new ImapParser()
  const r = p.feed(
    Buffer.from('* OK [CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN] Gimap ready\r\n')
  )
  assert.equal(r.length, 1)
  assert.equal(r[0].tag, '*')
  const caps = parseGreetingCapabilities(r[0])
  assert.deepEqual(caps, ['imap4rev1', 'starttls', 'auth=plain'])
})

test('ImapParser: untagged CAPABILITY line', () => {
  const p = new ImapParser()
  const r = p.feed(Buffer.from('* CAPABILITY IMAP4rev1 CHILDREN IDLE\r\n'))
  assert.equal(r.length, 1)
  const caps = parseCapability(r[0])
  assert.deepEqual(caps, ['imap4rev1', 'children', 'idle'])
})

test('ImapParser: continuation request "+"', () => {
  const p = new ImapParser()
  const r = p.feed(Buffer.from('+ \r\n'))
  assert.equal(r.length, 1)
  assert.equal(r[0].tag, '+')
})

test('ImapParser: literal in body (CRLF inside literal is data, not delimiter)', () => {
  // "* FETCH (RFC822 {5}\r\nHELLO)\r\n" — the literal "HELLO"
  // contains no CRLF but the pattern must still work. Test with CRLF
  // inside literal to prove the parser keeps the bytes intact.
  const p = new ImapParser()
  const payload = Buffer.concat([
    Buffer.from('* 1 FETCH (BODY {13}\r\n'),
    Buffer.from('HELLO\r\nWORLD'), // 13 bytes with embedded CRLF
    Buffer.from(')\r\n')
  ])
  const r = p.feed(payload)
  assert.equal(r.length, 1)
  assert.equal(r[0].tag, '*')
  assert.ok(r[0].text.includes('HELLO\r\nWORLD'))
})

test('ImapParser: incremental feed (response split across chunks)', () => {
  const p = new ImapParser()
  let r = p.feed(Buffer.from('A1 OK Lo'))
  assert.equal(r.length, 0) // incomplete — no CRLF yet
  r = p.feed(Buffer.from('gin done\r\n'))
  assert.equal(r.length, 1)
  assert.equal(r[0].text, 'OK Login done')
})

test('ImapParser: multiple responses in one chunk', () => {
  const p = new ImapParser()
  const r = p.feed(Buffer.from('* 1 EXISTS\r\n* 2 RECENT\r\nA2 OK SELECT done\r\n'))
  assert.equal(r.length, 3)
  assert.equal(r[0].text, '1 EXISTS')
  assert.equal(r[1].text, '2 RECENT')
  assert.equal(r[2].tag, 'A2')
})

test('classifyTagged: OK / NO / BAD', () => {
  assert.equal(classifyTagged({ tag: 'A1', text: 'OK done', bytes: 0 }), 'OK')
  assert.equal(classifyTagged({ tag: 'A1', text: 'NO bad creds', bytes: 0 }), 'NO')
  assert.equal(classifyTagged({ tag: 'A1', text: 'BAD malformed', bytes: 0 }), 'BAD')
  assert.equal(classifyTagged({ tag: 'A1', text: 'WEIRD', bytes: 0 }), 'OTHER')
})

test('ImapParser: literal whose bytes themselves contain {NNN} pattern', () => {
  // Edge: literal body containing "{5}" — must not be re-interpreted
  // as another literal introducer. The parser already consumed the
  // literal fully before re-scanning for the next CRLF.
  const p = new ImapParser()
  const body = '{5}not-a-literal'
  const payload = Buffer.concat([
    Buffer.from('* 1 FETCH (DATA {'),
    Buffer.from(String(body.length)),
    Buffer.from('}\r\n'),
    Buffer.from(body),
    Buffer.from(')\r\n')
  ])
  const r = p.feed(payload)
  assert.equal(r.length, 1)
  assert.ok(r[0].text.includes(body))
})

test('ImapParser: NO with bracketed response code', () => {
  const p = new ImapParser()
  const r = p.feed(
    Buffer.from('A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n')
  )
  assert.equal(r.length, 1)
  assert.equal(r[0].tag, 'A1')
  assert.equal(classifyTagged(r[0]), 'NO')
  assert.match(r[0].text, /AUTHENTICATIONFAILED/)
})
