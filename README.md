# CopiMon — Minimal realtime cross-browser clipboard rooms

A simple setup with a Node.js server and a Chrome extension (MV3) to share copied text across multiple browsers in realtime, grouped by room IDs. No auth, in-memory history, easy to run.

## Project structure

```
server/
  index.js
  package.json
extension/
  manifest.json
  background.js
  content.js
  options.html
```

## Architecture plan

- **Data model**: In-memory per-room history. Room key is a string. Each item is `{ id, text, ts }`.
- **Server**: Express for REST, `ws` for realtime. Broadcasts new items to all clients in a room, caps history at 100.
- **Client (Chrome extension MV3)**:
  - Background service worker keeps a WebSocket to the server; falls back to REST for posting.
  - Content script captures copy events and sends text to background.
  - On Ctrl/Cmd+V, content script shows an overlay listing recent items; selecting inserts into the active editable or writes to clipboard.
  - Options page stores `serverUrl` and `roomId` in `chrome.storage.sync`.

## How it works

1. User copies text → content script sends `{ text }` to background.
2. Background posts via WS (or REST) to the server.
3. Server saves the item in memory and broadcasts to the room.
4. Background updates local `copiMonItems` history.
5. User presses Ctrl/Cmd+V → overlay shows latest items; chosen text is inserted or copied.

## Run the server

1. Install Node.js 18+.
2. In a terminal:
```bash
cd server
npm install
npm start
```
- Server listens on `http://localhost:3001` by default.
- Persistence: Uses SQLite (`copimon.sqlite` in the `server/` directory by default). Override path with `COPIMON_DB` env var.
- Endpoints:
  - `GET /health` → `{ ok: true }`
  - `GET /rooms/:roomId/history` → `{ items: [...] }`
  - `POST /rooms/:roomId/clipboard` body `{ text }` → `{ ok, item }`
  - WebSocket: `ws://localhost:3001/ws?roomId=ROOM`

Note: History is persisted in SQLite; delete the DB file to reset.

## Load the Chrome extension (MV3)

1. Open Chrome → `chrome://extensions`.
2. Enable Developer mode (top-right).
3. Click "Load unpacked" → select the `extension/` folder.
4. Open extension "Details" → "Extension options" and set:
   - Server URL: `https://copimon.onrender.com` (or your deployed origin)
   - Room ID: e.g. `default` or a shared string among users

### Permissions

Manifest includes host permissions for `http://*/*` and `https://*/*` and `http://localhost:3001/*`. You can restrict to your server origin.

## Usage

- Copy text on any page (Ctrl+C / Cmd+C). It uploads to the server automatically.
- On any client in the same room, press Ctrl/Cmd+V to open the overlay of recent items; click to paste.
- If no editable field is focused, the chosen text is written to the clipboard.

### Clipboard permissions and fallbacks
- When inserting into inputs/textareas, no special permission is needed.
- If inserting is not possible, the extension writes to the clipboard. It tries the async Clipboard API first and falls back to `document.execCommand('copy')` during a user gesture (click/Enter in overlay), which is widely supported.
- Some pages may restrict clipboard access; the fallback path is handled automatically by the content script.

## Configuration & storage

- `serverUrl` and `roomId` in `chrome.storage.sync`.
- Latest history snapshot stored in `chrome.storage.local` under key `copiMonItems`.

## Deployment notes

- No auth; anyone knowing the server and room can read/write.
- For production, place the server behind HTTPS/WSS and enable CORS for your extension origin(s).
- Consider persistence (Redis/DB) and auth in the future if needed.

### Deploy to Render (free plan)

1. Push this repository to GitHub.
2. In Render, create a new Web Service:
   - Root directory: `server/`
   - Build command: `npm install`
   - Start command: `node index.js`
   - Environment: Node 18
   - Environment variables:
     - `PORT`: `10000` (Render provides PORT; our server reads it)
     - `COPIMON_DB`: `copimon.sqlite`
3. After deploy, note your service URL, e.g. `https://copimon-server.onrender.com`.
4. In the extension Options page, set Server URL to your Render URL.

Notes:
- Render free instances may spin down when idle; the extension will reconnect automatically.
- Ensure the Render URL is allowed by extension host permissions (manifest already includes `https://*/*`).

## API summary

- `GET /rooms/:roomId/history`
- `POST /rooms/:roomId/clipboard` → `{ text: string }`
- WS messages:
  - Server → client: `{ type: 'snapshot', items }`, `{ type: 'new_item', item }`
  - Client → server: `{ type: 'new_item', text }`

## Troubleshooting

- If overlay doesn't appear on Ctrl/Cmd+V, some sites block content scripts; test on another site.
- Check Service Worker logs (chrome://extensions → Inspect views) for connection issues.
- Ensure your server is reachable and CORS is enabled (server already enables CORS).

## License

MIT
