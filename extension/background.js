// Minimal background: manages WS connection per room and shares history via chrome.storage

const DEFAULTS = {
  serverUrl: 'https://copimon.onrender.com',
  roomId: 'default',
};

let ws;
let reconnectTimer;
let status = { state: 'disconnected', lastError: null };
let logs = [];
let sendQueue = [];

function pushLog(message) {
  const entry = { ts: Date.now(), message };
  logs.unshift(entry);
  if (logs.length > 200) logs.length = 200;
  chrome.storage.local.set({ copiMonLogs: logs });
}

function setStatus(newState, error = null) {
  status = { state: newState, lastError: error ? String(error) : null };
  chrome.storage.local.set({ copiMonStatus: status });
}

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, resolve);
  });
}

async function setHistory(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ copiMonItems: items }, resolve);
  });
}

async function getHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ copiMonItems: [] }, (res) => resolve(res.copiMonItems));
  });
}

function buildWsUrl(serverUrl, roomId) {
  try {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = `roomId=${encodeURIComponent(roomId)}`;
    return url.toString();
  } catch (e) {
    console.error('CopiMon: invalid serverUrl', serverUrl, e);
    pushLog(`Invalid serverUrl: ${serverUrl}`);
    return null;
  }
}

function connectWS(serverUrl, roomId) {
  const wsUrl = buildWsUrl(serverUrl, roomId);
  if (!wsUrl) return;
  try { if (ws) ws.close(); } catch {}
  try {
    pushLog(`WS connecting ${wsUrl}`);
    setStatus('connecting');
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error('CopiMon: WebSocket constructor failed', e);
    pushLog(`WS constructor failed: ${e?.message || e}`);
    setStatus('disconnected', e?.message || String(e));
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    pushLog('WS connected');
    setStatus('connected');
    flushQueue();
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        await setHistory(msg.items || []);
        pushLog(`Snapshot received: ${Array.isArray(msg.items) ? msg.items.length : 0} items`);
        flushQueue();
      } else if (msg.type === 'new_item') {
        const items = await getHistory();
        const updated = [msg.item, ...items].slice(0, 100);
        await setHistory(updated);
        pushLog('New item received');
        flushQueue();
      }
    } catch {}
  };

  ws.onclose = (ev) => {
    pushLog(`WS closed code=${ev?.code ?? 'n/a'} reason=${ev?.reason || 'n/a'}`);
    setStatus('disconnected');
    scheduleReconnect();
  };
  ws.onerror = (e) => {
    pushLog('WS error');
    setStatus('disconnected', e?.message || 'ws error');
    scheduleReconnect();
  };
}

async function scheduleReconnect() {
  const { serverUrl, roomId } = await getConfig();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectWS(serverUrl, roomId), 2000);
}

async function flushQueue() {
  if (!sendQueue.length) return;
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      while (sendQueue.length) {
        const text = sendQueue.shift();
        ws.send(JSON.stringify({ type: 'new_item', text }));
        pushLog('Flushed queued item via WS');
      }
      return;
    }
  } catch (e) {
    pushLog('Error flushing queue: ' + (e?.message || e));
  }
  // Try REST flush
  const snapshot = [...sendQueue];
  sendQueue = [];
  for (const text of snapshot) {
    try {
      const { serverUrl, roomId } = await getConfig();
      const resp = await fetch(`${serverUrl}/rooms/${encodeURIComponent(roomId)}/clipboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      pushLog(`Flushed queued item via REST: ${resp.ok ? 'ok' : 'fail ' + resp.status}`);
      if (!resp.ok) {
        // Put back if failed
        sendQueue.unshift(text);
        break;
      }
    } catch (e) {
      pushLog('REST flush failed: ' + (e?.message || e));
      sendQueue.unshift(text);
      break;
    }
  }
}

async function pushClipboardText(text) {
  const { serverUrl, roomId } = await getConfig();
  // Try WS first
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'new_item', text }));
      pushLog('Sent item via WS');
      return;
    }
  } catch {}
  // Queue and try REST immediately
  sendQueue.push(text);
  const resp = await fetch(`${serverUrl}/rooms/${encodeURIComponent(roomId)}/clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  pushLog(`Sent item via REST: ${resp.ok ? 'ok' : 'fail ' + resp.status}`);
  if (resp.ok) {
    // Remove one instance from queue
    const idx = sendQueue.indexOf(text);
    if (idx !== -1) sendQueue.splice(idx, 1);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { serverUrl, roomId } = await getConfig();
  connectWS(serverUrl, roomId);
  // Warm up clipboard permission if possible by querying state
  try { await navigator.permissions?.query?.({ name: 'clipboard-write' }); } catch {}
  chrome.storage.local.set({ copiMonLogs: logs, copiMonStatus: status });
});

chrome.runtime.onStartup.addListener(async () => {
  const { serverUrl, roomId } = await getConfig();
  connectWS(serverUrl, roomId);
  try { await navigator.permissions?.query?.({ name: 'clipboard-write' }); } catch {}
  chrome.storage.local.set({ copiMonLogs: logs, copiMonStatus: status });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.serverUrl || changes.roomId)) {
    const serverUrl = changes.serverUrl ? changes.serverUrl.newValue : undefined;
    const roomId = changes.roomId ? changes.roomId.newValue : undefined;
    (async () => {
      const cfg = await getConfig();
      connectWS(serverUrl || cfg.serverUrl, roomId || cfg.roomId);
    })();
  }
});

// Messages from content: { type: 'copimon.copy', text }
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'copimon.copy' && typeof msg.text === 'string') {
      // Opportunistic connect when a copy arrives
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        const cfg = await getConfig();
        connectWS(cfg.serverUrl, cfg.roomId);
      }
      await pushClipboardText(msg.text);
      sendResponse({ ok: true });
      pushLog('Copy event captured from content');
      chrome.storage.local.set({ copiMonLastCopyAt: Date.now(), copiMonLastCopyLen: msg.text.length });
    } else if (msg && msg.type === 'copimon.getItems') {
      const items = await getHistory();
      sendResponse({ items });
    } else if (msg && msg.type === 'copimon.getStatus') {
      sendResponse({ status });
    } else if (msg && msg.type === 'copimon.getLogs') {
      sendResponse({ logs });
    } else if (msg && msg.type === 'copimon.clearLogs') {
      logs = [];
      chrome.storage.local.set({ copiMonLogs: logs });
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'copimon.reconnect') {
      const { serverUrl, roomId } = await getConfig();
      connectWS(serverUrl, roomId);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'copimon.testSend') {
      const text = `Test ${new Date().toLocaleTimeString()}`;
      await pushClipboardText(text);
      sendResponse({ ok: true });
    }
  })();
  return true; // async
});


