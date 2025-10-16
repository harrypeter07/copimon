import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '200kb' }));

// In-memory sockets per room (history is persisted in SQLite)
const rooms = new Map();
// Ephemeral server logs for popup consumption
const recentLogs = [];
function log(level, message, meta) {
  const entry = { ts: Date.now(), level, message, meta: meta || null };
  recentLogs.unshift(entry);
  if (recentLogs.length > 500) recentLogs.length = 500;
  try { console.log(`[${new Date(entry.ts).toISOString()}] [${level}] ${message}`, meta || ''); } catch {}
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { sockets: new Set() });
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  let sent = 0;
  for (const ws of room.sockets) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(payload));
        sent++;
      } catch (e) {
        log('error', 'broadcast failed', { error: e.message });
      }
    }
  }
  if (payload?.type === 'new_item') {
    log('info', 'broadcast', { roomId, id: payload.item?.id, clients: sent });
  }
}

// SQLite setup
const db = new Database(process.env.COPIMON_DB || 'copimon.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS clipboard_items (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_room_ts ON clipboard_items(room_id, ts DESC);
`);

const insertItemStmt = db.prepare('INSERT INTO clipboard_items (id, room_id, text, ts) VALUES (?, ?, ?, ?)');
const selectLatestStmt = db.prepare('SELECT id, text, ts FROM clipboard_items WHERE room_id = ? ORDER BY ts DESC LIMIT ?');

function createItem(text) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, ts: Date.now() };
}

function saveItem(roomId, item) {
  try {
    insertItemStmt.run(item.id, roomId, item.text, item.ts);
    log('info', 'item_saved', { roomId, id: item.id });
  } catch (e) {
    log('error', 'save_failed', { error: e.message });
  }
}

function getLatest(roomId, limit = 100) {
  return selectLatestStmt.all(roomId, limit);
}

// REST endpoints
app.get('/health', (_req, res) => {
  log('info', 'health_check');
  res.json({ ok: true, timestamp: Date.now() });
});

// Get server logs
app.get('/logs', (_req, res) => {
  log('info', 'logs_requested');
  res.json({ logs: recentLogs.slice(0, 100) });
});

// Get latest history for a room
app.get('/rooms/:roomId/history', (req, res) => {
  const { roomId } = req.params;
  const items = getLatest(roomId, 100);
  log('info', 'history', { roomId, count: items.length });
  res.json({ items });
});

// Post new clipboard item
app.post('/rooms/:roomId/clipboard', (req, res) => {
  const { roomId } = req.params;
  const { text } = req.body || {};
  if (typeof text !== 'string' || text.length === 0) {
    log('warn', 'invalid_text', { roomId });
    return res.status(400).json({ error: 'text is required' });
  }
  const item = createItem(text);
  saveItem(roomId, item);
  log('info', 'new_item_rest', { roomId, id: item.id, len: item.text.length });
  broadcastToRoom(roomId, { type: 'new_item', roomId, item });
  res.json({ ok: true, item });
});

const server = app.listen(PORT, () => {
  console.log(`copimon server listening on http://localhost:${PORT}`);
  log('info', 'server_started', { port: PORT });
});

// WebSocket: ws://host/ws?roomId=xyz
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (!url || !url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const roomId = url.searchParams.get('roomId') || 'default';
  const room = getOrCreateRoom(roomId);
  room.sockets.add(ws);
  log('info', 'ws_open', { roomId, sockets: room.sockets.size });

  // Send initial snapshot
  const items = getLatest(roomId, 100);
  try {
    ws.send(JSON.stringify({ type: 'snapshot', roomId, items }));
    log('info', 'ws_snapshot', { roomId, count: items.length });
  } catch (e) {
    log('error', 'snapshot_failed', { error: e.message });
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'new_item' && typeof msg.text === 'string' && msg.text.length > 0) {
        const item = createItem(msg.text);
        saveItem(roomId, item);
        log('info', 'new_item_ws', { roomId, id: item.id, len: item.text.length });
        broadcastToRoom(roomId, { type: 'new_item', roomId, item });
      }
    } catch (e) {
      log('error', 'ws_message_error', { error: e.message });
    }
  });

  ws.on('close', () => {
    room.sockets.delete(ws);
    log('info', 'ws_close', { roomId, sockets: room.sockets.size });
  });

  ws.on('error', (err) => {
    log('error', 'ws_error', { roomId, error: err.message });
  });
});