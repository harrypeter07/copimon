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

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { sockets: new Set() });
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const ws of room.sockets) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
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
  insertItemStmt.run(item.id, roomId, item.text, item.ts);
}

function getLatest(roomId, limit = 100) {
  return selectLatestStmt.all(roomId, limit);
}

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Get latest history for a room
app.get('/rooms/:roomId/history', (req, res) => {
  const { roomId } = req.params;
  const items = getLatest(roomId, 100);
  res.json({ items });
});

// Post new clipboard item
app.post('/rooms/:roomId/clipboard', (req, res) => {
  const { roomId } = req.params;
  const { text } = req.body || {};
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  const item = createItem(text);
  saveItem(roomId, item);
  broadcastToRoom(roomId, { type: 'new_item', roomId, item });
  res.json({ ok: true, item });
});

const server = app.listen(PORT, () => {
  console.log(`copimon server listening on http://localhost:${PORT}`);
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

  // Send initial snapshot
  ws.send(JSON.stringify({ type: 'snapshot', roomId, items: getLatest(roomId, 100) }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'new_item' && typeof msg.text === 'string' && msg.text.length > 0) {
        const item = createItem(msg.text);
        saveItem(roomId, item);
        broadcastToRoom(roomId, { type: 'new_item', roomId, item });
      }
    } catch {}
  });

  ws.on('close', () => {
    room.sockets.delete(ws);
  });
});


