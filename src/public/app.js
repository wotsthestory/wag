/**
 * ============================================================================
 * WAG Web GUI — Frontend Application
 * ============================================================================
 * A vanilla-JS single-page application that communicates with the WAG backend
 * via REST API and WebSocket for real-time updates.
 *
 * No build step required. Open index.html in any modern browser.
 * ============================================================================
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------
  const statusPill = document.getElementById('statusPill');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  const qrSection = document.getElementById('qrSection');
  const qrImage = document.getElementById('qrImage');
  const userSection = document.getElementById('userSection');
  const disconnectedSection = document.getElementById('disconnectedSection');
  const userId = document.getElementById('userId');
  const userName = document.getElementById('userName');

  const btnLogout = document.getElementById('btnLogout');
  const btnRefresh = document.getElementById('btnRefresh');
  const btnSend = document.getElementById('btnSend');
  const sendForm = document.getElementById('sendForm');
  const sendTo = document.getElementById('sendTo');
  const sendMessage = document.getElementById('sendMessage');
  const sendResult = document.getElementById('sendResult');

  const logContainer = document.getElementById('logContainer');
  const btnClear = document.getElementById('btnClear');
  const btnReconnect = document.getElementById('btnReconnect');

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let ws = null;
  let reconnectTimer = null;
  let currentStatus = 'disconnected';

  // ---------------------------------------------------------------------------
  // WebSocket Connection
  // ---------------------------------------------------------------------------
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      appendLog({ t: new Date().toISOString(), level: 'error', msg: `WS init error: ${e.message}` });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      appendLog({ t: new Date().toISOString(), level: 'info', msg: 'WebSocket connected' });
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleWsMessage(payload);
      } catch (e) {
        console.warn('Invalid WS payload', event.data);
      }
    };

    ws.onclose = () => {
      appendLog({ t: new Date().toISOString(), level: 'warn', msg: 'WebSocket closed' });
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      appendLog({ t: new Date().toISOString(), level: 'error', msg: 'WebSocket error' });
      ws.close();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  }

  // ---------------------------------------------------------------------------
  // WS Message Handlers
  // ---------------------------------------------------------------------------
  function handleWsMessage(payload) {
    switch (payload.type) {
      case 'status':
        updateStatus(payload.data);
        break;
      case 'qr':
        showQR(payload.data);
        break;
      case 'info':
        showUserInfo(payload.data);
        break;
      case 'log':
        appendLog(payload.data);
        break;
      case 'state':
        // Snapshot sent on first connect
        if (payload.data.status) updateStatus(payload.data.status);
        if (payload.data.qr) showQR(payload.data.qr);
        if (payload.data.log) payload.data.log.forEach(appendLog);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // UI Updates
  // ---------------------------------------------------------------------------
  function updateStatus(status) {
    currentStatus = status;
    statusText.textContent = status;
    statusDot.className = 'dot ' + status;

    // Enable/disable send button based on connection
    btnSend.disabled = status !== 'open';
    btnLogout.disabled = false;

    if (status === 'open') {
      qrSection.classList.add('hidden');
      disconnectedSection.classList.add('hidden');
      userSection.classList.remove('hidden');
    } else if (status === 'pairing') {
      qrSection.classList.remove('hidden');
      disconnectedSection.classList.add('hidden');
      userSection.classList.add('hidden');
    } else {
      qrSection.classList.add('hidden');
      disconnectedSection.classList.remove('hidden');
      userSection.classList.add('hidden');
    }
  }

  function showQR(dataUrl) {
    if (!dataUrl) {
      qrSection.classList.add('hidden');
      qrImage.src = '';
      return;
    }
    qrImage.src = dataUrl;
    qrSection.classList.remove('hidden');
    disconnectedSection.classList.add('hidden');
  }

  function showUserInfo(info) {
    userId.textContent = info?.id || '—';
    userName.textContent = info?.name || '—';
    userSection.classList.remove('hidden');
  }

  function appendLog(entry) {
    const el = document.createElement('div');
    el.className = 'log-entry';

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date(entry.t).toLocaleTimeString();

    const lvl = document.createElement('span');
    lvl.className = 'lvl lvl-' + (entry.level || 'info');
    lvl.textContent = entry.level || 'info';

    const msg = document.createElement('span');
    msg.className = 'msg';
    let text = entry.msg || entry.text || JSON.stringify(entry);
    if (entry.from) text = `[${entry.from}] ${text}`;
    if (entry.to) text = `→ [${entry.to}] ${text}`;
    msg.textContent = text;

    el.appendChild(ts);
    el.appendChild(lvl);
    el.appendChild(msg);

    logContainer.appendChild(el);
    logContainer.scrollTop = logContainer.scrollHeight;

    // Auto-truncate DOM nodes to keep performance high
    while (logContainer.children.length > 300) {
      logContainer.removeChild(logContainer.firstChild);
    }
  }

  // ---------------------------------------------------------------------------
  // REST API Helpers
  // ---------------------------------------------------------------------------
  async function apiGet(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Event Listeners
  // ---------------------------------------------------------------------------

  // Refresh status button
  btnRefresh.addEventListener('click', async () => {
    try {
      const data = await apiGet('/api/status');
      updateStatus(data.status);
      if (data.user) showUserInfo(data.user);
    } catch (e) {
      sendResult.textContent = 'Error: ' + e.message;
      sendResult.className = 'result error';
    }
  });

  // Logout button
  btnLogout.addEventListener('click', async () => {
    if (!confirm('This will delete your WhatsApp session. You will need to re-scan the QR code. Continue?')) {
      return;
    }
    try {
      const data = await apiPost('/api/logout', {});
      sendResult.textContent = data.message;
      sendResult.className = 'result success';
      updateStatus('disconnected');
    } catch (e) {
      sendResult.textContent = 'Error: ' + e.message;
      sendResult.className = 'result error';
    }
  });

  // Send message form
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    sendResult.textContent = 'Sending…';
    sendResult.className = 'result';
    btnSend.disabled = true;

    try {
      const data = await apiPost('/api/send', {
        to: sendTo.value.trim(),
        message: sendMessage.value.trim()
      });
      sendResult.textContent = `Sent! ID: ${data.id}`;
      sendResult.className = 'result success';
      sendMessage.value = '';
    } catch (err) {
      sendResult.textContent = 'Error: ' + err.message;
      sendResult.className = 'result error';
    } finally {
      btnSend.disabled = currentStatus !== 'open';
    }
  });

  // Clear log
  btnClear.addEventListener('click', () => {
    logContainer.innerHTML = '';
  });

  // Reconnect WS manually
  btnReconnect.addEventListener('click', () => {
    if (ws) ws.close();
    connectWebSocket();
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    connectWebSocket();
    try {
      const data = await apiGet('/api/status');
      updateStatus(data.status);
      if (data.user) showUserInfo(data.user);
    } catch (e) {
      appendLog({ t: new Date().toISOString(), level: 'error', msg: `Status fetch failed: ${e.message}` });
    }
  }

  boot();
})();
