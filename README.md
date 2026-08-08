# ◆ ASTRAL VOX

> Dark Mechanicus messenger & mail aggregator. One Electron app, one
> isolated session per service. Telegram, WhatsApp, VK, MAX, Yandex
> Mail, Mail.ru as embedded web clients — and **Gmail as a native
> IMAP/SMTP client** (because Google blocks Electron sign-in).

WH40k cogitator aesthetic: CRT scanlines, copper/brass/AdMech-red
palette, gothic typography, phosphor glow.

## ⚒ Features

- **7 services** in isolated Chromium partitions (cookies/cache separated):
  - Telegram, WhatsApp, VK, MAX (web clients)
  - Yandex Mail, Mail.ru (web clients)
  - Gmail (**native IMAP fetch + SMTP send** — no webview)
- **Smart Proxy routing** — per-service: SYSTEM (env proxy) / DIRECT / custom SOCKS5
- **Inquisition Firewall** — telemetry blocking (Yandex.Metrica, GA, Tencent) + permission revocation
- **Camouflage** — strips Electron signatures, patches `navigator.webdriver`
- **CSS Cleaner** — removes web-app chrome per service (headers, promos, custom scrollbars)
- **MCP server** on `127.0.0.1:9751` — LLM dashboard bridge with HITL approval
- **License system** — Cloudflare Worker backend + local dev server
- **Cogitator theme** — CRT scanlines, copper glow, gothic headings

## ⚙ Stack

- Electron 30+ (`WebContentsView`, not deprecated `<webview>`)
- electron-vite + TypeScript
- Raw TLS IMAP/SMTP (no external mail libs — full protocol implementation)
- MCP SDK (`@modelcontextprotocol/sdk`)
- electron-builder (AppImage / NSIS / DMG)

## ➜ Build

```bash
cd vox-internum-desktop
npm install
npm run dev               # dev mode
npm run build:linux       # → release/Vox Internum-0.1.0.AppImage
```

## ◆ Gmail setup (IMAP)

Gmail uses native IMAP — Google blocks Electron web sign-in.
1. Enable 2-Step Verification: [myaccount.google.com](https://myaccount.google.com/security)
2. Create App Password: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. In ASTRAL VOX: click **GM** → enter email + App Password → **CONNECT**

## ✗ What doesn't work (honestly)

- **Gmail web sign-in** — Google's anti-automation blocks Electron. We use IMAP instead.
- **WeChat** — web version dying, registration requires mobile. Not included.
- **Native clients for messengers** — TG/VK/WhatsApp use proprietary protocols, only web embeds possible.

## 📜 License

MIT
