/**
 * ============================================================================
 * WAG — WhatsApp Ghost (WhatsApp Web Automation Gateway)
 * ============================================================================
 *
 * A containerised Node.js service that bridges WhatsApp Web (via Baileys)
 * with a modern REST API and WebSocket-enabled web GUI.
 *
 * Architecture:
 *   ┌─────────────┐     HTTP/WebSocket      ┌──────────────┐
 *   │   Browser   │  ───────────────────►  │  Express +   │
 *   │  (Web GUI)  │  ◄───────────────────  │   WebSocket  │
 *   └─────────────┘                        └──────┬───────┘
 *                                                 │
 *                                            ┌────┴────┐
 *                                            │ Baileys │  ◄──► WhatsApp Web
 *                                            │ Library │       (Multi-Device)
 *                                            └────┬────┘
 *                                                 │
 *                                            ┌────┴────┐
 *                                            │ Session │
 *                                            │  Store  │  (./data/session)
 *                                            └─────────┘
 *
 * Key Components:
 *   • REST API    — Send messages, query status, list chats
 *   • WebSocket   — Real-time QR codes, connection events, incoming messages
 *   • Baileys     — Official-ish WhatsApp Web multi-device protocol library
 *   • Static SPA  — Single-page web GUI served from ./public
 *
 * Environment Variables:
 *   PORT          — HTTP listener port (default: 3000)
 *   SESSION_PATH  — Directory for auth state persistence (default: ./data/session)
 *   NODE_ENV      — 'production' disables verbose logging
 *
 * CLI Access:
 *   docker exec -it wag sh
 *   # Inside container: node -e "..." or inspect ./data/session
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const http = require('http');

// Baileys imports — the de-facto open-source WhatsApp Web library
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'data', 'session');
const LOG_DIR = path.join(__dirname, 'data', 'logs');

// Ensure directories exist
[SESSION_PATH, LOG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------
let sock = null;                 // Active Baileys socket instance
let qrString = null;             // Latest QR pairing string (raw)
let qrDataUrl = null;            // Latest QR pairing string (data URL image)
let connectionStatus = 'disconnected'; // disconnected / connecting / connected / error
let connectionInfo = null;       // Baileys connection info object
let messageLog = [];             // Circular buffer of recent events for the GUI
const MAX_LOG = 200;

// ---------------------------------------------------------------------------
// Helper: append to in-memory log (broadcasts via WebSocket)
// ---------------------------------------------------------------------------
function addLog(entry) {
  const record = { t: new Date().toISOString(), ...entry };
  messageLog.push(record);
  if (messageLog.length > MAX_LOG) messageLog.shift();
  broadcastWs({ type: 'log', data: record });
}

// ---------------------------------------------------------------------------
// WebSocket Server Setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  addLog({ level: 'info', msg: 'WebSocket client connected' });

  // Send current state snapshot to new client
  ws.send(JSON.stringify({
    type: 'state',
    data: {
      status: connectionStatus,
      qr: qrDataUrl,
      log: messageLog.slice(-50)
    }
  }));

  ws.on('close', () => {
    clients.delete(ws);
    addLog({ level: 'info', msg: 'WebSocket client disconnected' });
  });

  ws.on('error', (err) => {
    clients.delete(ws);
    addLog({ level: 'error', msg: `WebSocket error: ${err.message}` });
  });
});

function broadcastWs(payload) {
  const json = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(json);
    }
  }
}

// ---------------------------------------------------------------------------
// Baileys Socket Lifecycle
// ---------------------------------------------------------------------------
async function startWhatsApp() {
  if (sock) {
    addLog({ level: 'warn', msg: 'Socket already initialised; skipping startWhatsApp()' });
    return;
  }

  connectionStatus = 'connecting';
  broadcastWs({ type: 'status', data: connectionStatus });
  addLog({ level: 'info', msg: 'Initialising Baileys socket…' });

  // Load or create multi-file auth state (enables persistent sessions across restarts)
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  // Fetch latest Baileys version to minimise ban risk
  const { version, isLatest } = await fetchLatestBaileysVersion();
  addLog({ level: 'info', msg: `Baileys version: ${version.join('.')} (latest: ${isLatest})` });

  sock = makeWASocket({
    version,
    logger: {
      // Minimal Pino-compatible logger to suppress verbose Baileys output
      level: 'silent',
      child: function() { return this; },
      debug: function() {},
      info: function() {},
      warn: function() {},
      error: function() {},
      fatal: function() {},
      trace: function() {},
      silent: function() {}
    },
    auth: state,
    browser: Browsers.ubuntu('Chrome'), // mimic a real Ubuntu + Chrome pairing
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false, // stay "offline" to reduce visibility
    syncFullHistory: false,     // don't pull entire chat history on reconnect
  });

  // -------------------------------------------------------------------------
  // Connection Update Handler
  // -------------------------------------------------------------------------
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 400 });
      connectionStatus = 'pairing';
      broadcastWs({ type: 'qr', data: qrDataUrl });
      broadcastWs({ type: 'status', data: connectionStatus });
      addLog({ level: 'info', msg: 'New QR code generated for pairing' });
    }

    if (connection) {
      connectionStatus = connection; // 'connecting' | 'open' | 'close' | 'error'
      broadcastWs({ type: 'status', data: connectionStatus });
      addLog({ level: 'info', msg: `Connection state: ${connection}` });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      addLog({
        level: 'warn',
        msg: `Connection closed. Reason: ${lastDisconnect?.error?.output?.statusCode || 'unknown'}`
      });

      sock = null;
      qrString = null;
      qrDataUrl = null;
      broadcastWs({ type: 'qr', data: null });

      if (shouldReconnect) {
        addLog({ level: 'info', msg: 'Reconnecting in 5 seconds…' });
        setTimeout(startWhatsApp, 5000);
      } else {
        connectionStatus = 'logged_out';
        broadcastWs({ type: 'status', data: connectionStatus });
        addLog({ level: 'error', msg: 'Session logged out. Delete session data to re-pair.' });
      }
    }

    if (connection === 'open') {
      qrString = null;
      qrDataUrl = null;
      connectionInfo = sock.user;
      broadcastWs({ type: 'qr', data: null });
      broadcastWs({ type: 'info', data: { id: sock.user?.id, name: sock.user?.name } });
      addLog({ level: 'info', msg: `Connected as ${sock.user?.id || 'unknown'}` });
    }
  });

  // -------------------------------------------------------------------------
  // Credentials Update Handler (critical for session persistence)
  // -------------------------------------------------------------------------
  sock.ev.on('creds.update', saveCreds);

  // -------------------------------------------------------------------------
  // Incoming Message Handler
  // -------------------------------------------------------------------------
  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      if (!msg.key.fromMe && m.type === 'notify') {
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '[media/unknown]';
        addLog({ level: 'msg_in', from, text: text.substring(0, 200) });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Express Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple request logger
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ---------------------------------------------------------------------------
// REST API Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/status
 * Returns the current WhatsApp connection state and logged-in user info.
 */
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    user: connectionInfo
      ? { id: connectionInfo.id, name: connectionInfo.name }
      : null,
    qr: qrDataUrl ? true : false, // indicate QR availability without sending huge payload
    uptime: process.uptime()
  });
});

/**
 * GET /api/qr
 * Returns the current pairing QR code as a PNG image.
 * Useful for embedding directly in an <img> tag.
 */
app.get('/api/qr', async (req, res) => {
  if (!qrString) {
    return res.status(404).json({
      error: 'No QR code available',
      status: connectionStatus
    });
  }
  try {
    const png = await QRCode.toBuffer(qrString, { margin: 2, width: 400, type: 'png' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/send
 * Send a text message to a given WhatsApp JID or phone number.
 *
 * Body:
 *   to      (string)  — Phone number (e.g. "447123456789") or full JID (e.g. "447123456789@s.whatsapp.net")
 *   message (string)  — Text to send
 *
 * Response:
 *   { success: true, id: string } on success
 *   { success: false, error: string } on failure
 */
app.post('/api/send', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing "to" or "message" field' });
  }

  if (!sock || connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected', status: connectionStatus });
  }

  // Normalise input: if user supplies just a number, append WhatsApp JID suffix
  const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  try {
    const result = await sock.sendMessage(jid, { text: String(message) });
    addLog({ level: 'msg_out', to: jid, text: String(message).substring(0, 200) });
    res.json({ success: true, id: result?.key?.id });
  } catch (err) {
    addLog({ level: 'error', msg: `Send failed: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/chats
 * Returns a lightweight list of recent chats (if available).
 * Note: Baileys does not store history server-side by default; this relies on
 * the local store which is ephemeral unless backed by a DB.
 */
app.get('/api/chats', async (req, res) => {
  if (!sock || connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp not connected', status: connectionStatus });
  }
  try {
    const chats = await sock.groupFetchAllParticipating().catch(() => ({}));
    const groupList = Object.values(chats).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0
    }));
    res.json({ groups: groupList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/logout
 * Disconnect and clear the current session.
 * WARNING: This deletes auth credentials; you will need to re-scan QR code.
 */
app.post('/api/logout', async (req, res) => {
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      // ignore
    }
    sock = null;
  }
  // Clear session files
  try {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    fs.mkdirSync(SESSION_PATH, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: `Failed to clear session: ${e.message}` });
  }
  connectionStatus = 'disconnected';
  connectionInfo = null;
  qrString = null;
  qrDataUrl = null;
  broadcastWs({ type: 'status', data: connectionStatus });
  broadcastWs({ type: 'qr', data: null });
  addLog({ level: 'warn', msg: 'Session logged out and cleared' });
  res.json({ success: true, message: 'Logged out. Session cleared.' });
});

/**
 * GET /api/health
 * Kubernetes / Docker health-check compatible endpoint.
 */
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', wa: connectionStatus, uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// SPA Fallback — serve index.html for any non-API route
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Global Error Handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  addLog({ level: 'error', msg: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start Server & WhatsApp Socket
// ---------------------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WAG] Server listening on http://0.0.0.0:${PORT}`);
  console.log(`[WAG] Session path: ${path.resolve(SESSION_PATH)}`);
  console.log(`[WAG] WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
  startWhatsApp();
});
