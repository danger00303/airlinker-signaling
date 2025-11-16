const http = require('http');
const WebSocket = require('ws');
const url = require('url');

// --- Create HTTP server that also handles simple GET requests ---
const server = http.createServer((req, res) => {
  const path = url.parse(req.url).pathname;

  // Root route for UptimeRobot & browser checks
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('✅ Airlinker Signaling Server is alive and ready for WebSocket connections.');
    return;
  }

  // Default 404 for anything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocket.Server({ server });
const sessions = new Map();

wss.on('connection', (ws) => {
  let mySession = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, sessionId } = msg;

    if (type === 'create-session') {
      sessions.set(sessionId, { sender: ws, receiver: null });
      mySession = sessionId;
      ws.send(JSON.stringify({ type: 'session-created', sessionId }));
      return;
    }

    if (type === 'join-session') {
      mySession = sessionId;
      const s = sessions.get(sessionId);
      if (!s) return ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      s.receiver = ws;
      ws.send(JSON.stringify({ type: 'session-joined', sessionId }));
      s.sender?.send(JSON.stringify({ type: 'session-joined', sessionId }));
      return;
    }

    // Relay messages between peers
    if (mySession && sessions.has(mySession)) {
      const s = sessions.get(mySession);
      const target = ws === s.sender ? s.receiver : s.sender;
      target?.send(raw);
    }
  });

  ws.on('close', () => {
    if (mySession && sessions.has(mySession)) sessions.delete(mySession);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('✅ AirLinker Signaling Server running on port', PORT));
