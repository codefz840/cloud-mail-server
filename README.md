# cloud-mail-server

> IMAP / SMTP middleware that bridges standard email clients (Thunderbird, Outlook, Apple Mail …) to a self-hosted [cloud-mail](https://github.com/maillab/cloud-mail) worker.

Because cloud-mail runs entirely on **Cloudflare Workers** (HTTP-only), email clients cannot connect to it directly using the IMAP or SMTP protocols.  
cloud-mail-server runs **locally** (or on any server you control) and acts as a protocol translator:

```
Email Client ──IMAP/SMTP──▶ cloud-mail-server ──HTTPS──▶ cloud-mail Worker
```

---

## Features

| Protocol | Port (default) | What it does |
|----------|---------------|--------------|
| **IMAP4rev1** | 143 | Receive, read and delete mail via the cloud-mail API |
| **SMTP** | 587 | Send mail via the cloud-mail API |

### IMAP capabilities
- **INBOX** folder – received emails (`type=0`), plus dynamic `INBOX/<address>` subfolders when an account has multiple receive addresses
- **Sent** folder – sent emails (`type=1`)
- **Trash** folder – session-local trash (emails moved/copied here are held in memory for the duration of the session; cloud-mail has no native trash concept)
- `FETCH` with `FLAGS`, `UID`, `INTERNALDATE`, `RFC822.SIZE`, `RFC822`, `ENVELOPE`, `BODY[…]`, `BODYSTRUCTURE`
- `COPY` / `UID COPY` – copy messages to Trash (RFC 3501 §6.4.7)
- `MOVE` / `UID MOVE` – move messages to Trash, immediately deleting them from the API (RFC 6851)
- `STORE` – mark as `\Seen` / `\Deleted`
- `EXPUNGE` – permanently delete flagged messages (expunging Trash also permanently deletes any copied-but-not-yet-expunged messages)
- `SEARCH` – returns all messages (basic support)
- `IDLE` – acknowledged (polling re-SELECT for new mail)

---

## Requirements

- **Node.js** ≥ 18
- A running [cloud-mail](https://github.com/maillab/cloud-mail) worker (the `CLOUD_MAIL_URL`)

---

## Quick start

```bash
# 1. Clone & install
git clone https://github.com/codefz840/cloud-mail-server.git
cd cloud-mail-server
npm install

# 2. Configure
cp .env.example .env
# Edit .env and set CLOUD_MAIL_URL to your cloud-mail worker URL

# 3. Start
npm start
```

---

## Configuration

All settings are read from environment variables (or a `.env` file in the project root).

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUD_MAIL_URL` | *(required)* | Base URL of your cloud-mail worker, e.g. `https://mail.example.com` |
| `IMAP_PORT` | `143` | TCP port for the IMAP server |
| `SMTP_PORT` | `587` | TCP port for the SMTP server |
| `HOST` | `0.0.0.0` | Network interface to bind (use `127.0.0.1` for localhost-only) |

Example `.env`:

```env
CLOUD_MAIL_URL=https://mail.example.com
IMAP_PORT=143
SMTP_PORT=587
HOST=127.0.0.1
```

---

## Configuring your email client

### Thunderbird

1. **Add Account** → *Manual setup*
2. **Incoming (IMAP)**
   - Server: `localhost` (or the IP where cloud-mail-server runs)
   - Port: `143`
   - Connection security: **None** (or STARTTLS if you add TLS)
   - Authentication: **Normal password**
   - Username: your cloud-mail email address (e.g. `you@example.com`)
3. **Outgoing (SMTP)**
   - Server: `localhost`
   - Port: `587`
   - Connection security: **None**
   - Authentication: **Normal password**
   - Username: your cloud-mail email address

### Apple Mail / Outlook

Use the same settings:
- IMAP host `localhost`, port `143`, no TLS, normal-password auth
- SMTP host `localhost`, port `587`, no TLS, normal-password auth

> **Tip:** If you run cloud-mail-server on a remote server, replace `localhost` with that server's IP/hostname.  
> You can also configure TLS (e.g. via a reverse proxy with Nginx or Caddy) and use ports 993 (IMAP) / 465 (SMTP) for encrypted connections.

---

## Project structure

```
cloud-mail-server/
├── src/
│   ├── api/
│   │   └── cloud-mail-client.js   # HTTP client for the cloud-mail REST API
│   ├── imap/
│   │   └── imap-server.js         # IMAP4rev1 TCP server
│   ├── smtp/
│   │   └── smtp-server.js         # SMTP server (smtp-server package)
│   ├── utils/
│   │   └── mime-builder.js        # Converts cloud-mail objects → RFC 2822 MIME
│   └── index.js                   # Entry point
├── tests/
│   ├── mime-builder.test.js
│   └── imap-helpers.test.js
├── .env.example
├── config.js
└── package.json
```

---

## Development

```bash
# Run with auto-restart on file changes (Node ≥ 18)
npm run dev

# Run tests
npm test
```

Integration tests for the cloud-mail API also use these environment variables when set:

```env
TEST_MAIL_USER=your-test-mail-address@example.com
TEST_MAIL_PASS=your-test-mail-password
CLOUD_MAIL_URL=https://mail.example.com
```

## CI

GitHub Actions runs `npm test` on every push and pull request. When `TEST_MAIL_USER`, `TEST_MAIL_PASS`, and `CLOUD_MAIL_URL` are configured as repository secrets or variables, the integration suite exercises the live cloud-mail API as part of the run.

---

## Licence

MIT
