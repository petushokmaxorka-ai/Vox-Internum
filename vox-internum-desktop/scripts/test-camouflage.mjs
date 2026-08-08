// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Camouflage unit tests
// ═══════════════════════════════════════════════════════════
// Tests stripElectronFromUA, the only pure function in camouflage.ts.
// Run: tsc -p tsconfig.test.json && node --test scripts/test-camouflage.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripElectronFromUA } from '../out/test-src/main/camouflage.js'

test('stripElectronFromUA: removes single Electron token', () => {
  const input = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Electron/30.5.1 Safari/537.36'
  const out = stripElectronFromUA(input)
  assert.equal(out, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36')
  // Critical: "Electron" word must be gone.
  assert.ok(!/Electron\//.test(out), 'Electron/ token still present')
})

test('stripElectronFromUA: handles double-space collapse', () => {
  // When the token is in the middle, removing it leaves two spaces;
  // the function must collapse runs of whitespace.
  const input = 'A Electron/30.5.1 B'
  const out = stripElectronFromUA(input)
  assert.equal(out, 'A B')
})

test('stripElectronFromUA: no Electron token → unchanged (trimmed)', () => {
  const input = 'Mozilla/5.0 ... Chrome/125.0.0.0 Safari/537.36'
  assert.equal(stripElectronFromUA(input), input)
})

test('stripElectronFromUA: empty string → empty', () => {
  assert.equal(stripElectronFromUA(''), '')
})

test('stripElectronFromUA: multiple Electron tokens (defensive)', () => {
  // Shouldn't happen in practice but must not crash.
  const input = 'X Electron/1.0 Y Electron/2.0 Z'
  const out = stripElectronFromUA(input)
  assert.equal(out, 'X Y Z')
})

test('stripElectronFromUA: trims surrounding whitespace', () => {
  assert.equal(stripElectronFromUA('  Chrome/125  '), 'Chrome/125')
})
