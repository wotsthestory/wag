# 👻 WAG — WhatsApp Ghost

**Containerised WhatsApp Web automation gateway with a real-time Web GUI.**

WAG wraps the industry-standard [**Baileys**](https://github.com/WhiskeySockets/Baileys) WhatsApp Web library inside a Dockerised Node.js service, adds a REST API, and serves a clean single-page web dashboard. It is designed to run behind an existing **Traefik** reverse proxy (as used in the `tsrv.uk` infrastructure) with automatic TLS, CrowdSec threat detection, and Cloudflare IP restoration.

> **Project origin:** The original *WhatsAppGhost* project on GitHub (`AnLoMinus/WhatsAppGhost`) was a 2022 shell-script toolkit. WAG reimagines that concept as a modern, maintainable, containerised service with a web interface and programmatic API.

---

## 📑 Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Configuration](#configuration)
5. [Usage](#usage)
   - [Web GUI](#web-gui)
   - [REST API](#rest-api)
   - [CLI Access](#cli-access)
6. [Traefik Integration](#traefik-integration)
7. [Session Persistence](#session-persistence)
8. [Security Notes](#security-notes)
9. [Troubleshooting](#troubleshooting)
10. [Development](#development)

---

## Architecture Overview

```
┌─────────────┐      HTTPS (443)       ┌──────────────┐      HTTP (3000)      ┌─────────┐
│   Client    │  ═══════════════════►  │   Traefik    │  ═════════════════►  │   WAG   │
│  (Browser)  │  ◄═══════════════════  │  (v3.6.10)   │  ◄═════════════════  │ (Node)  │
└─────────────┘                        └──────────────┘                       └────┬────┘
                                                                                    │
                                                                              ┌─────┴─────┐
                                                                              │  Baileys  │  ◄──► WhatsApp Web
                                                                              │  Library  │      (Multi-Device)
                                                                              └─────┬─────┘
                                                                                    │
                                                                              ┌─────┴─────┐
                                                                              │  Session  │
                                                                              │   Store   │  (./data/session)
                                                                              └───────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Baileys** | The most actively maintained open-source WhatsApp Web library. No Puppeteer/Chrome overhead. |
| **Express + vanilla JS** | Zero frontend build step; the entire UI ships as static files. |
| **WebSocket** | Real-time QR codes, connection events, and incoming message log without polling. |
| **Multi-file auth state** | Session survives container restarts and image rebuilds (stored in bind mount). |
| **Non-root container user** | Minimises blast radius if the Node process is compromised. |

---

## Prerequisites

- **Docker** ≥ 24.0 and **Docker Compose** ≥ 2.20 (supports Compose Specification without `version:`)
- **Traefik** reverse proxy already running on the Docker `proxy` network (see `/opt/traefik`)
- DNS `A` (and optionally `AAAA`) record for `wag.tsrv.uk` pointing to this host
- Ports `80` and `443` forwarded to the host (handled by Traefik)

---

## Quick Start

### 1. Clone / Navigate

```bash
cd /opt/wag
```

### 2. Environment

```bash
# The repo ships with a pre-configured .env for tsrv.uk.
# If you ever need to regenerate it:
cp .env.example .env
# Edit WAG_DOMAIN if required
```

### 3. Build & Launch

```bash
docker compose up -d --build
```

This will:
- Build the Node.js image from the `Dockerfile`
- Start the `wag` container on the shared `proxy` network
- Register Traefik labels so `https://wag.tsrv.uk` routes to the container
- Persist session data in `./data/`

### 4. Verify

```bash
# Check container health
docker ps | grep wag

# Follow logs (look for the QR code in terminal output)
docker compose logs -f

# Health endpoint
curl -s https://wag.tsrv.uk/api/health | jq
```

### 5. First Pairing

1. Open `https://wag.tsrv.uk` in a browser.
2. The **Live Log** panel shows `Connection state: connecting`.
3. A **QR code** appears under the *Connection* section.
4. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**.
5. Scan the QR code.
6. Status changes to `connected`; your WhatsApp ID and name display.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WAG_DOMAIN` | `wag.tsrv.uk` | FQDN routed by Traefik. Must match DNS. |
| `PORT` | `3000` | Internal HTTP port (rarely needs changing). |
| `NODE_ENV` | `production` | Set to `development` for verbose console logging. |
| `SESSION_PATH` | `/app/data/session` | Directory where Baileys stores auth credentials. |

### Traefik Labels (in `docker-compose.yml`)

The labels tell Traefik how to route, secure, and terminate TLS for WAG:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.wag-http.rule=Host(`wag.tsrv.uk`)"
  - "traefik.http.routers.wag-http.entrypoints=web"
  - "traefik.http.routers.wag-http.middlewares=wag-https-redirect"
  - "traefik.http.middlewares.wag-https-redirect.redirectscheme.scheme=https"
  - "traefik.http.middlewares.wag-https-redirect.redirectscheme.permanent=true"
  - "traefik.http.routers.wag.rule=Host(`wag.tsrv.uk`)"
  - "traefik.http.routers.wag.entrypoints=websecure"
  - "traefik.http.routers.wag.middlewares=secured@file"
  - "traefik.http.routers.wag.tls=true"
  - "traefik.http.routers.wag.tls.certresolver=letsencrypt"
  - "traefik.http.services.wag.loadbalancer.server.port=3000"
```

- **`secured@file`** — A middleware chain defined in `/opt/traefik/data/config.yml` that applies Cloudflare IP restoration, CrowdSec bouncer, rate limiting, gzip compression, and hardened security headers.
- **`letsencrypt`** — The certificate resolver in Traefik that performs DNS-01 challenges via Cloudflare.

---

## Usage

### Web GUI

Navigate to `https://wag.tsrv.uk`.

| Panel | Function |
|-------|----------|
| **Connection** | Displays real-time QR code for pairing, connected user ID, and logout/reset controls. |
| **Send Message** | Form to send a text message to any phone number or JID. Disabled until connected. |
| **Live Log** | Real-time event stream (WebSocket) showing connection state, incoming/outgoing messages, and errors. |

#### Sending a Message via GUI

1. Ensure status shows **Connected** (green dot).
2. Enter a phone number in international format (e.g. `447123456789`) or a full JID (`447123456789@s.whatsapp.net`).
3. Type your message and click **Send**.
4. The result panel shows the message ID on success, or an error if the send failed.

### REST API

All endpoints accept/return `application/json`.

#### `GET /api/health`
Health check (used by Docker `HEALTHCHECK`).

```bash
curl -s https://wag.tsrv.uk/api/health
```
```json
{ "status": "ok", "wa": "open", "uptime": 1234.56 }
```

#### `GET /api/status`
Current WhatsApp connection state and user info.

```bash
curl -s https://wag.tsrv.uk/api/status | jq
```
```json
{
  "status": "open",
  "user": { "id": "447123456789:44@s.whatsapp.net", "name": "Your Name" },
  "qr": false,
  "uptime": 1234.56
}
```

#### `GET /api/qr`
Returns the current pairing QR code as a **PNG image**.

```bash
curl -s https://wag.tsuk.uk/api/qr -o qr.png
```

#### `POST /api/send`
Send a text message.

**Request body:**
```json
{
  "to": "447123456789",
  "message": "Hello from WAG 👻"
}
```

- `to` — Phone number (digits only, international format) **or** a full JID (`number@s.whatsapp.net`).
- `message` — Plain text. WhatsApp formatting (*bold*, _italic_, etc.) is supported.

**Example:**
```bash
curl -X POST https://wag.tsrv.uk/api/send \
  -H "Content-Type: application/json" \
  -d '{"to":"447123456789","message":"Automated test from WAG"}'
```

**Response:**
```json
{ "success": true, "id": "ABC123..." }
```

#### `GET /api/chats`
List participating groups (Baileys group metadata snapshot).

```bash
curl -s https://wag.tsrv.uk/api/chats | jq
```

#### `POST /api/logout`
Disconnect from WhatsApp and **delete the local session**.

```bash
curl -X POST https://wag.tsrv.uk/api/logout
```

⚠️ After logout you **must re-scan the QR code** to reconnect.

### CLI Access

Even though WAG provides a web GUI, full CLI access to the running container is available for debugging, manual file inspection, or ad-hoc Node.js scripting.

```bash
# Interactive shell inside the container
docker exec -it wag sh

# View live logs
docker logs -f wag

# Inspect session files (auth keys — treat as sensitive)
docker exec wag ls -la /app/data/session

# Run a one-off Node command against Baileys
docker exec wag node -e "console.log(require('@whiskeysockets/baileys')"

# Copy session data out for backup
docker cp wag:/app/data/session ./backup-session-$(date +%F)

# Restart the service
docker compose restart wag
```

---

## Traefik Integration

WAG is designed to plug into the existing **Traefik v3** stack at `/opt/traefik`. No changes to Traefik's static configuration are required because all routing is declared dynamically via Docker labels.

### How It Works

1. **Docker Provider** — Traefik polls the Docker socket proxy (`dockersocket`) and watches for containers with `traefik.enable=true`.
2. **Router Rule** — `Host(\`wag.tsrv.uk\`)` matches incoming requests.
3. **Middleware Chain (`secured@file`)** — Applies:
   - **CloudflareWarp** — Restores original client IPs from Cloudflare proxy headers.
   - **CrowdSec Bouncer** — Blocks malicious IPs detected by the CrowdSec engine.
   - **Rate Limit** — 50 req/s average, 100 burst.
   - **Gzip Compress** — Compresses text responses.
   - **Security Headers** — HSTS, CSP, X-Frame-Options, Referrer-Policy, etc.
4. **TLS** — `tls.certresolver=letsencrypt` triggers automatic certificate issuance via Cloudflare DNS-01.

### Network Membership

WAG joins the `proxy` external network:

```yaml
networks:
  proxy:
    name: proxy
    external: true
```

This network is created by `/opt/traefik/docker-compose.yml` and is shared with other services (Open WebUI, SearXNG, etc.).

---

## Session Persistence

Baileys uses a **multi-file auth state** to store WhatsApp Web credentials. WAG persists this in `./data/session/` (bind-mounted to `/app/data/session` inside the container).

### What This Means

- **Container restarts** — You stay logged in. No QR re-scan required.
- **Image rebuilds** — You stay logged in (data is on the host, not in the image).
- **Host reboots** — You stay logged in.
- **Delete `./data/session/`** — You are logged out and must re-pair.

### Backup / Migration

```bash
# Backup
tar czvf wag-session-backup.tar.gz ./data/session

# Restore (after fresh clone)
tar xzvf wag-session-backup.tar.gz
```

### Security Warning

The session directory contains cryptographic keys that allow sending and receiving messages **as you**. Protect it like a password:

- `./data/` is Git-ignored.
- The container runs as a non-root user (`wag:nodejs`) to limit file access.
- Set restrictive host permissions if desired: `chmod 700 ./data`.

---

## Security Notes

- **WhatsApp Multi-Device** — When you pair WAG, it appears as a "Linked Device" in WhatsApp. You can revoke it at any time from your phone.
- **Rate Limiting** — Traefik's rate limiter protects the public endpoint from abuse. The internal API has no additional auth; do not expose port `3000` directly.
- **No Admin UI** — There is no built-in user management. Access control is provided by Traefik middlewares (CrowdSec, IP whitelist, etc.).
- **CSP & Headers** — The `secured@file` chain injects a Content-Security-Policy. The WAG frontend uses inline styles/scripts which are allowed by the current policy (`'unsafe-inline'`).

---

## Troubleshooting

### Container won't start

```bash
# Check build errors
docker compose up --build

# Inspect exit reason
docker logs wag --tail 50
```

### "No QR code available"

- The socket may already be connected (check status).
- If previously paired, the session auto-restores. QR only appears for new pairings.
- If stuck, trigger a logout via API or delete `./data/session/` and restart.

### "WhatsApp not connected" when sending

- Wait for `connection state: open` in the log.
- If the phone loses internet, Baileys will disconnect and auto-reconnect.
- Check `docker logs wag` for `lastDisconnect` reason codes.

### Traefik returns 404 / Gateway Timeout

1. Confirm the `proxy` network exists: `docker network ls | grep proxy`
2. Confirm Traefik is running: `docker ps | grep traefik`
3. Confirm labels are present: `docker inspect wag | jq '.[0].Config.Labels'`
4. Check Traefik dashboard/logs for router/service registration errors.
5. Verify DNS resolves to the correct IP: `dig wag.tsrv.uk +short`

### QR code won't scan

- Ensure the QR image is crisp (not scaled by browser zoom).
- Baileys QR codes expire after ~20 seconds; the web GUI auto-refreshes.
- Try scanning from `docker logs wag` which also prints the QR in terminal ASCII art.

### High memory usage

The container is limited to `512M`. If Node.js exceeds this, the OOM killer may restart it. Reduce memory pressure by:
- Setting `syncFullHistory: false` (already default in `server.js`).
- Avoiding large media downloads.

---

## Development

### Local Node.js (outside Docker)

```bash
cd src
npm install
npm run dev   # uses Node --watch (auto-restart on change)
```

The server listens on `http://localhost:3000`. Open `http://localhost:3000` to test the GUI.

### Rebuild Image After Code Changes

```bash
docker compose up -d --build
```

### Lint / Format

There is no enforced linter; follow the existing style:
- 2-space indentation
- Single quotes for strings
- JSDoc-style comments for routes and complex functions

---

## License

MIT — Use at your own risk. WhatsApp is a trademark of Meta Platforms, Inc. This project is not affiliated with or endorsed by WhatsApp or Meta.

---

## Acknowledgements

- [**Baileys**](https://github.com/WhiskeySockets/Baileys) by WhiskeySockets — the WhatsApp Web protocol implementation.
- Original *WhatsAppGhost* concept by AnLoMinus.
