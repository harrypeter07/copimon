// Content script: capture copy and open overlay on Ctrl+V

let overlayOpen = false;

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
}

async function openOverlay() {
  if (overlayOpen) return;
  overlayOpen = true;
  chrome.runtime.sendMessage({ type: 'copimon.getItems' }, ({ items }) => {
    const overlay = createOverlay(items || []);
    document.documentElement.appendChild(overlay);
  });
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
}

// Capture copy events in page
document.addEventListener('copy', () => {
  let text = '';
  try {
    text = document.getSelection()?.toString() || '';
  } catch {}
  if (text) {
    chrome.runtime.sendMessage({ type: 'copimon.copy', text });
  }
}, true);

// Global key handler for Ctrl+V to open overlay instead of default paste list
document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'v') {
    // Only intercept if no modifier besides ctrl/cmd
    if (!e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openOverlay();
    }
  }
});

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
        return true;
      } catch {}
    }
    // Fallback: write to clipboard
    writeToClipboardWithFallback(msg.text);
    sendResponse({ ok: true, clipboard: true });
    return true;
  }
});


