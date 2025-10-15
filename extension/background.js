// Minimal background: manages WS connection per room and shares history via chrome.storage

const DEFAULTS = {
  serverUrl: 'http://localhost:3001',
  roomId: 'default',
};

let ws;
let reconnectTimer;

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

function connectWS(serverUrl, roomId) {
  const wsUrl = serverUrl.replace('http', 'ws') + `/ws?roomId=${encodeURIComponent(roomId)}`;
  try { if (ws) ws.close(); } catch {}
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    // No-op
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        await setHistory(msg.items || []);
      } else if (msg.type === 'new_item') {
        const items = await getHistory();
        const updated = [msg.item, ...items].slice(0, 100);
        await setHistory(updated);
      }
    } catch {}
  };

  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => scheduleReconnect();
}

async function scheduleReconnect() {
  const { serverUrl, roomId } = await getConfig();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectWS(serverUrl, roomId), 2000);
}

async function pushClipboardText(text) {
  const { serverUrl, roomId } = await getConfig();
  // Try WS first
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'new_item', text }));
      return;
    }
  } catch {}
  // Fallback REST
  await fetch(`${serverUrl}/rooms/${encodeURIComponent(roomId)}/clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { serverUrl, roomId } = await getConfig();
  connectWS(serverUrl, roomId);
  // Warm up clipboard permission if possible by querying state
  try { await navigator.permissions?.query?.({ name: 'clipboard-write' }); } catch {}
});

chrome.runtime.onStartup.addListener(async () => {
  const { serverUrl, roomId } = await getConfig();
  connectWS(serverUrl, roomId);
  try { await navigator.permissions?.query?.({ name: 'clipboard-write' }); } catch {}
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
      await pushClipboardText(msg.text);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'copimon.getItems') {
      const items = await getHistory();
      sendResponse({ items });
    }
  })();
  return true; // async
});


