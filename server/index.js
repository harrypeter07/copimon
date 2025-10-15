import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '200kb' }));

// In-memory store: roomId -> { history: Array<{ id, text, ts }>, sockets: Set<ws> }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { history: [], sockets: new Set() });
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

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Get latest history for a room
app.get('/rooms/:roomId/history', (req, res) => {
  const { roomId } = req.params;
  const room = getOrCreateRoom(roomId);
  res.json({ items: room.history });
});

// Post new clipboard item
app.post('/rooms/:roomId/clipboard', (req, res) => {
  const { roomId } = req.params;
  const { text } = req.body || {};
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  const room = getOrCreateRoom(roomId);
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, ts: Date.now() };
  room.history.unshift(item);
  // cap history to 100 items
  if (room.history.length > 100) room.history.length = 100;
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
  ws.send(JSON.stringify({ type: 'snapshot', roomId, items: room.history }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'new_item' && typeof msg.text === 'string' && msg.text.length > 0) {
        const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: msg.text, ts: Date.now() };
        room.history.unshift(item);
        if (room.history.length > 100) room.history.length = 100;
        broadcastToRoom(roomId, { type: 'new_item', roomId, item });
      }
    } catch {}
  });

  ws.on('close', () => {
    room.sockets.delete(ws);
  });
});


