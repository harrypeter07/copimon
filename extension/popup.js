const DEFAULTS = { serverUrl: 'https://copimon.onrender.com', roomId: 'default' };

function getSync(keys) { return new Promise(r => chrome.storage.sync.get(keys, r)); }
function setSync(obj) { return new Promise(r => chrome.storage.sync.set(obj, r)); }
function getLocal(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

async function load() {
  const cfg = await getSync(DEFAULTS);
  document.getElementById('serverUrl').value = cfg.serverUrl;
  document.getElementById('roomId').value = cfg.roomId;
  renderItems();
  renderStatus();
  renderLogs();
  // load ctrl+v preference
  const { useCtrlVOverlay = false } = await getSync({ useCtrlVOverlay: false });
  document.getElementById('useCtrlVOverlay').checked = !!useCtrlVOverlay;
}

async function renderItems() {
  const { copiMonItems = [] } = await getLocal({ copiMonItems: [] });
  const itemsEl = document.getElementById('items');
  itemsEl.innerHTML = '';
  if (copiMonItems.length === 0) {
    itemsEl.append(el('div', { className: 'muted', textContent: 'No items yet. Copy some text in a page.' }));
    return;
  }
  for (const item of copiMonItems) {
    const textEl = el('div', { className: 'item', textContent: item.text });
    const actions = el('div', { className: 'actions' },
      el('button', { textContent: 'Paste' }),
      el('button', { textContent: 'Copy' }),
    );
    const wrap = el('div', {}, textEl, actions);
    actions.children[0].addEventListener('click', () => pasteIntoActiveTab(item.text));
    actions.children[1].addEventListener('click', () => copyToClipboard(item.text));
    itemsEl.append(wrap);
  }
}

async function renderStatus() {
  const bgStatus = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'copimon.getStatus' }, (resp) => resolve(resp?.status));
  });
  const localStatus = (await getLocal({ copiMonStatus: { state: 'unknown' } })).copiMonStatus;
  const s = bgStatus || localStatus || { state: 'unknown' };
  const wsState = document.getElementById('wsState');
  wsState.textContent = `WS: ${s.state}${s.lastError ? ' — ' + s.lastError : ''}`;
  wsState.classList.remove('connected', 'connecting', 'disconnected');
  wsState.classList.add(s.state);
}

async function renderLogs() {
  const { copiMonLogs = [] } = await getLocal({ copiMonLogs: [] });
  const logsEl = document.getElementById('logs');
  logsEl.textContent = copiMonLogs.map(l => new Date(l.ts).toLocaleTimeString() + ' ' + l.message).join('\n');
}

async function pasteIntoActiveTab(text) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // Ask content script in the tab to insert text
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'copimon.pasteText', text });
    window.close();
  } catch (e) {
    // If the tab has no content script (e.g., chrome:// pages), just copy
    await copyToClipboard(text);
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const serverUrl = document.getElementById('serverUrl').value.trim();
  const roomId = document.getElementById('roomId').value.trim() || 'default';
  await setSync({ serverUrl, roomId });
  document.getElementById('status').textContent = 'Saved';
  setTimeout(() => { document.getElementById('status').textContent = ''; }, 1500);
});

document.getElementById('useCtrlVOverlay').addEventListener('change', async (e) => {
  await setSync({ useCtrlVOverlay: !!e.target.checked });
});

document.getElementById('refresh').addEventListener('click', async () => {
  await renderItems();
  await renderStatus();
  await renderLogs();
});

document.getElementById('requestClipboard').addEventListener('click', async () => {
  try {
    await navigator.permissions?.query?.({ name: 'clipboard-write' });
    await navigator.clipboard?.writeText(''); // attempt a no-op write to prompt if needed
    document.getElementById('status').textContent = 'Clipboard permission requested';
  } catch {
    document.getElementById('status').textContent = 'Clipboard request failed';
  }
  setTimeout(() => { document.getElementById('status').textContent = ''; }, 1500);
});

document.getElementById('clearLogs').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'copimon.clearLogs' });
  renderLogs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.copiMonItems) {
    renderItems();
  } else if (area === 'local' && changes.copiMonLogs) {
    renderLogs();
  } else if (area === 'local' && changes.copiMonStatus) {
    renderStatus();
  }
});

load();


