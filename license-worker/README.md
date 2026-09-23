# ◆ Vox Internum — License Worker

> Cloudflare Worker that owns license activation + verification for
> the Vox Internum desktop client. Free-tier-friendly (KV + Worker).
> Does **not** touch payments — the principal issues keys manually
> after accepting money out-of-band (crypto, ЮMoney, Boosty).

## ⚙ Architecture

```
Desktop client ──HTTPS──► Worker ──► LICENSES KV (key → record)
                              └───► TOKENS   KV (token → session)
```

- **Opaque session tokens**, not JWT. TLS + online verification is
  the industry standard for desktop licensing.
- **Device binding**: each license key has up to `MAX_DEVICES` (3)
  activation slots. A `deviceId` (random UUID generated client-side)
  consumes one slot.
- **Revoke**: principal marks a key revoked; all its tokens die.

## ➜ Endpoints

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `POST` | `/activate` | — | `{key, deviceId}` | `{token, expiresAt}` or `{error}` |
| `POST` | `/verify` | — | `{token, deviceId}` | `{valid, expiresAt, reason?}` |
| `POST` | `/admin/create` | Bearer ADMIN_KEY | `{days?}` | `{key, days}` |
| `POST` | `/admin/revoke` | Bearer ADMIN_KEY | `{key}` | `{ok}` |
| `GET`  | `/health` | — | — | `{ok:true, service}` |

## 🚀 Deploy (one-time, ~5 min)

```bash
cd license-worker
npm install

# 1. Create the KV namespaces
npx wrangler kv:namespace create LICENSES
npx wrangler kv:namespace create TOKENS
#   → paste the returned IDs into wrangler.toml (LICENSES and TOKENS bindings)

# 2. Set the admin secret (long random string — keep private!)
npx wrangler secret put ADMIN_KEY
#   → paste a strong secret, e.g.: openssl rand -hex 32

# 3. Deploy
npm run deploy
#   → Worker URL printed, e.g. https://vox-internum-license.<you>.workers.dev
```

Set that URL in the desktop client via the env var
`VOX_LICENSE_URL` (see `vox-internum-desktop/src/main/license.ts`).

## ◆ Issuing a license key (after a sale)

```bash
# Create a 30-day license
curl -X POST https://vox-internum-license.<you>.workers.dev/admin/create \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'
# → {"key":"VOX-ABCD1234-EFGH5678-...","days":30}
```

Send the returned `key` to the buyer (Telegram, email, however you
sold it). They paste it into Vox Internum's license modal; the app
calls `/activate` and stores the token locally.

## ✗ Revoke a key (refund / abuse)

```bash
curl -X POST https://vox-internum-license.<you>.workers.dev/admin/revoke \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"VOX-ABCD1234-EFGH5678-..."}'
```

All tokens for that key are deleted; the next `/verify` returns
`{valid:false, reason:"unknown token"}` and `/activate` answers
`{error:"key revoked"}`.

## 🛠 Local dev

```bash
npm run dev         # wrangler dev on http://localhost:8787
npm run typecheck   # tsc --noEmit
npm run build       # bundle check (wrangler deploy --dry-run → dist/)
# Set VOX_LICENSE_URL=http://localhost:8787 in the desktop client.
```

`/admin/*` stays closed (403) until `ADMIN_KEY` is set — for local dev
put `ADMIN_KEY=<something>` in `.dev.vars` (git-ignored).

## 💰 Money

This Worker is **payment-agnostic**. The flow is:

1. Buyer pays you out-of-band (crypto wallet, ЮMoney, Boosty, etc.).
2. You (manually) call `/admin/create` to generate a key.
3. You send the key to the buyer.

Automated payment + auto-issuance is a later phase (would need a
crypto gateway like Cryptomus or ЮKassa — both require paperwork).

## ✗ Security notes

- `ADMIN_KEY` is a Worker secret — never committed, never logged.
- `/admin/*` uses a constant-time-ish Bearer comparison.
- Tokens are 256-bit random; brute-force is infeasible.
- KV reads are strongly consistent for the same key within a region;
  propagation of revocation across regions may take up to 60s.
- The Worker binds no ports — Cloudflare's edge handles ingress.
  (No AGENTS.md §3.1 concern: it's not a local service.)

*«Decimalis exacta. Contractus servandus.»*
