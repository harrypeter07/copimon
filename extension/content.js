// Content script: capture copy and open overlay on Ctrl+V

let overlayOpen = false;
let overlayRefreshTimer;
let useCtrlVOverlay = false;
let lastSent = { text: '', at: 0 };

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.position = 'fixed';
  toast.style.bottom = '16px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%)';
  toast.style.background = 'rgba(0,0,0,0.8)';
  toast.style.color = 'white';
  toast.style.padding = '8px 12px';
  toast.style.borderRadius = '6px';
  toast.style.zIndex = '2147483647';
  toast.style.fontFamily = 'system-ui, Arial, sans-serif';
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

function safeSendMessage(message, cb) {
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      return cb && cb({});
    }
    chrome.runtime.sendMessage(message, (resp) => {
      const lastErr = chrome.runtime && chrome.runtime.lastError;
      if (lastErr && /Extension context invalidated/i.test(String(lastErr.message))) {
        // Background reloaded; ignore
        return cb && cb({});
      }
      cb && cb(resp || {});
    });
  } catch (e) {
    // Ignore messaging errors
    cb && cb({});
  }
}

function createOverlay(items) {
  const overlay = document.createElement('div');
  overlay.id = 'copimon-overlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.3)';
  overlay.style.zIndex = '2147483647';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  const panel = document.createElement('div');
  panel.style.width = 'min(600px, 90vw)';
  panel.style.maxHeight = '70vh';
  panel.style.overflow = 'auto';
  panel.style.background = 'white';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
  panel.style.padding = '12px';
  panel.style.fontFamily = 'system-ui, Arial, sans-serif';

  const title = document.createElement('div');
  title.textContent = 'CopiMon — Select item to paste';
  title.style.fontSize = '14px';
  title.style.color = '#555';
  title.style.marginBottom = '8px';
  panel.appendChild(title);

  const list = document.createElement('div');
  list.id = 'copimon-list';
  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.tabIndex = 0;
    row.style.padding = '10px';
    row.style.border = '1px solid #eee';
    row.style.borderRadius = '6px';
    row.style.marginBottom = '8px';
    row.style.cursor = 'pointer';
    row.style.whiteSpace = 'pre-wrap';
    row.style.wordBreak = 'break-word';
    row.textContent = item.text;
    row.addEventListener('click', () => pick(item.text));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(item.text); });
    list.appendChild(row);
    if (idx === 0) setTimeout(() => row.focus(), 0);
  });
  panel.appendChild(list);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
  overlay.appendChild(panel);
  return overlay;
}

function closeOverlay() {
  const el = document.getElementById('copimon-overlay');
  if (el) el.remove();
  overlayOpen = false;
  if (overlayRefreshTimer) {
    clearInterval(overlayRefreshTimer);
    overlayRefreshTimer = undefined;
  }
}

async function openOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  safeSendMessage({ type: 'copimon.getItems' }, ({ items }) => {
    const overlay = createOverlay(items || []);
    document.documentElement.appendChild(overlay);
  });
  // Auto-refresh overlay list every 2s
  overlayRefreshTimer = setInterval(() => {
    safeSendMessage({ type: 'copimon.getItems' }, ({ items }) => {
      const list = document.getElementById('copimon-list');
      if (!list || !Array.isArray(items)) return;
      list.innerHTML = '';
      items.forEach((item) => {
        const row = document.createElement('div');
        row.tabIndex = 0;
        row.style.padding = '10px';
        row.style.border = '1px solid #eee';
        row.style.borderRadius = '6px';
        row.style.marginBottom = '8px';
        row.style.cursor = 'pointer';
        row.style.whiteSpace = 'pre-wrap';
        row.style.wordBreak = 'break-word';
        row.textContent = item.text;
        row.addEventListener('click', () => pick(item.text));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(item.text); });
        list.appendChild(row);
      });
    });
  }, 2000);
}

function writeToClipboardWithFallback(text) {
  // Prefer async clipboard API when available and permitted
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      // Fallback to execCommand
      fallbackExecCopy(text);
    });
  }
  fallbackExecCopy(text);
}

function fallbackExecCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.left = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

function pick(text) {
  // Paste into focused element if possible
  const active = document.activeElement;
  const isEditable = active && (active.isContentEditable || ['INPUT', 'TEXTAREA'].includes(active.tagName));
  if (isEditable) {
    const start = active.selectionStart ?? active.selectionEnd ?? active.value?.length ?? 0;
    const end = active.selectionEnd ?? start;
    try {
      const val = active.value ?? '';
      active.value = val.slice(0, start) + text + val.slice(end);
      const pos = start + text.length;
      active.setSelectionRange?.(pos, pos);
      active.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {}
  } else {
    // Fallback: copy to system clipboard (user gesture from click/Enter)
    writeToClipboardWithFallback(text);
  }
  closeOverlay();
  showToast('Pasted');
}

// Capture copy events in page (prefer event.clipboardData)
document.addEventListener('copy', (e) => {
  let text = '';
  try {
    text = e.clipboardData?.getData('text/plain') || '';
  } catch {}
  if (!text) {
    try { text = document.getSelection()?.toString() || ''; } catch {}
  }
  if (text) {
    safeSendMessage({ type: 'copimon.copy', text });
    showToast('Copied to CopiMon');
  }
}, true);

// Also capture cuts
document.addEventListener('cut', () => {
  let text = '';
  try {
    text = document.getSelection()?.toString() || '';
  } catch {}
  if (text) {
    safeSendMessage({ type: 'copimon.copy', text });
    showToast('Copied to CopiMon');
  }
}, true);

// On Ctrl/Cmd+V, open overlay but do NOT block default paste behavior
document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 'v') {
    // Open overlay if user pressed Shift OR if setting is enabled
    if (e.shiftKey || useCtrlVOverlay) {
      // Do not prevent default; allow native paste
      openOverlay();
    }
  }
  // Try to capture actual clipboard contents on Ctrl/Cmd+C
  if (mod && !e.altKey && e.key.toLowerCase() === 'c') {
    // Defer read until after the copy completes in the event loop
    setTimeout(async () => {
      try {
        const text = (await navigator.clipboard?.readText?.()) || '';
        if (text && (text !== lastSent.text || Date.now() - lastSent.at > 1000)) {
          lastSent = { text, at: Date.now() };
          safeSendMessage({ type: 'copimon.copy', text });
          // toast suppressed here to avoid double toasts with copy handler
        }
      } catch {}
    }, 0);
  }
});

// Show a toast on paste as well to indicate action
document.addEventListener('paste', (e) => {
  let text = '';
  try {
    text = e.clipboardData?.getData('text/plain') || '';
  } catch {}
  if (text) {
    // Capture pasted content as well, useful when copy happened elsewhere
    safeSendMessage({ type: 'copimon.copy', text });
  }
  showToast('Pasted');
}, true);

// Handle paste requests from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'copimon.pasteText' && typeof msg.text === 'string') {
    const active = document.activeElement;
    const isEditable = active && (active.isContentEditable || ['INPUT', 'TEXTAREA'].includes(active.tagName));
    if (isEditable) {
      const start = active.selectionStart ?? active.selectionEnd ?? active.value?.length ?? 0;
      const end = active.selectionEnd ?? start;
      try {
        const val = active.value ?? '';
        active.value = val.slice(0, start) + msg.text + val.slice(end);
        const pos = start + msg.text.length;
        active.setSelectionRange?.(pos, pos);
        active.dispatchEvent(new Event('input', { bubbles: true }));
        sendResponse({ ok: true });
        showToast('Pasted');
        return true;
      } catch {}
    }
    // Fallback: write to clipboard
    writeToClipboardWithFallback(msg.text);
    sendResponse({ ok: true, clipboard: true });
    showToast('Copied');
    return true;
  } else if (msg && msg.type === 'copimon.forceCopySelection') {
    let text = '';
    try { text = document.getSelection()?.toString() || ''; } catch {}
    if (!text) {
      const active = document.activeElement;
      const isEditable = active && (active.isContentEditable || ['INPUT', 'TEXTAREA'].includes(active.tagName));
      if (isEditable) {
        try {
          const val = active.value ?? '';
          const start = active.selectionStart ?? 0;
          const end = active.selectionEnd ?? val.length;
          text = val.slice(start, end) || val;
        } catch {}
      }
    }
    if (text) {
      safeSendMessage({ type: 'copimon.copy', text });
      showToast('Copied to CopiMon');
      sendResponse({ ok: true, text });
    } else {
      sendResponse({ ok: false, error: 'no-selection' });
    }
    return true;
  } else if (msg && msg.type === 'copimon.ping') {
    sendResponse({ ok: true });
    return true;
  }
});

// Load user preference for Ctrl+V overlay
try {
  chrome.storage.sync.get({ useCtrlVOverlay: false }, (cfg) => {
    useCtrlVOverlay = !!cfg.useCtrlVOverlay;
  });
} catch {}

// React to changes from popup/options
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.useCtrlVOverlay) {
      useCtrlVOverlay = !!changes.useCtrlVOverlay.newValue;
    }
  });
} catch {}


