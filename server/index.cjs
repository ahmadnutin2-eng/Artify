/**
 * DrawFlow WebSocket Server
 * - Session-based rooms (6-char code)
 * - Max 2 users per room
 * - Stroke event broadcast
 * - Presence sync
 * - Ping/pong latency
 * - CORS-friendly
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;

// ── HTTP server (health check) ──
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size, time: Date.now() }));
  } else {
    res.writeHead(200);
    res.end('DrawFlow WS Server');
  }
});

// ── WebSocket server ──
const wss = new WebSocketServer({ server });

/** @type {Map<string, Set<{ws, userId, name, color, isHost}>>} */
const sessions = new Map();

function broadcast(sessionCode, data, excludeUserId = null) {
  const room = sessions.get(sessionCode);
  if (!room) return;
  const str = JSON.stringify(data);
  for (const client of room) {
    if (excludeUserId && client.userId === excludeUserId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(str);
    }
  }
}

function broadcastUsers(sessionCode) {
  const room = sessions.get(sessionCode);
  if (!room) return;
  const users = [...room].map(c => ({ userId: c.userId, name: c.name, color: c.color, isHost: c.isHost }));
  broadcast(sessionCode, { type: 'users', users });
}

wss.on('connection', (ws) => {
  let currentSession = null;
  let clientInfo = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const { code, userId, name, color, isHost } = msg;
        if (!code || !userId) return;

        // Create session if doesn't exist
        if (!sessions.has(code)) {
          sessions.set(code, new Set());
        }

        const room = sessions.get(code);

        // Enforce max 2 users
        if (room.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session is full (max 2 users)' }));
          return;
        }

        clientInfo = { ws, userId, name: name || 'Artist', color: color || '#4D9EFF', isHost };
        currentSession = code;
        room.add(clientInfo);

        ws.send(JSON.stringify({ type: 'session_created', code }));
        broadcastUsers(code);

        console.log(`[${code}] ${name} joined. Room size: ${room.size}`);
        break;
      }

      case 'strokes': {
        if (!currentSession || !msg.batch) return;
        // Tag strokes with userId and rebroadcast
        broadcast(currentSession, {
          type: 'strokes',
          batch: msg.batch.map(s => ({ ...s, userId: clientInfo?.userId }))
        }, clientInfo?.userId);
        break;
      }

      case 'cursor': {
        if (!currentSession) return;
        broadcast(currentSession, {
          type: 'cursor',
          userId: clientInfo?.userId,
          x: msg.x,
          y: msg.y
        }, clientInfo?.userId);
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentSession && clientInfo) {
      const room = sessions.get(currentSession);
      if (room) {
        room.delete(clientInfo);
        if (room.size === 0) {
          sessions.delete(currentSession);
          console.log(`[${currentSession}] Session closed (empty)`);
        } else {
          broadcastUsers(currentSession);
          console.log(`[${currentSession}] ${clientInfo.name} left. Room size: ${room.size}`);
        }
      }
    }
  });

  ws.on('error', () => {}); // Suppress unhandled errors
});

server.listen(PORT, () => {
  console.log(`\n🚀 DrawFlow WebSocket Server`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   WS:     ws://localhost:${PORT}\n`);
});
