import { WebSocketServer } from 'ws';

const PORT = Number(process.env.DEV_WS_PORT || 9999);

const rooms = new Map(); // roomId -> Set of clients

const wss = new WebSocketServer({ port: PORT }, () => {
  console.log(`[dev-ws] listening on ws://localhost:${PORT}`);
});

function getRoomSet(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function broadcast(roomId, payload, except) {
  if (!roomId || !rooms.has(roomId)) return;
  for (const client of rooms.get(roomId)) {
    if (client === except) continue;
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

wss.on('connection', (socket) => {
  socket.roomId = null;
  socket.role = null;

  socket.on('message', (data) => {
    let parsed = null;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.room && socket.roomId !== parsed.room) {
      if (socket.roomId && rooms.has(socket.roomId)) {
        rooms.get(socket.roomId).delete(socket);
      }
      socket.roomId = parsed.room;
      getRoomSet(socket.roomId).add(socket);
    }
    if (parsed.role) socket.role = parsed.role;

    // Basic echo for debugging
    if (parsed.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    // Broadcast sync + other messages to peers in the same room
    if (socket.roomId) {
      broadcast(socket.roomId, JSON.stringify(parsed), socket);
    }
  });

  socket.on('close', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      rooms.get(socket.roomId).delete(socket);
      if (!rooms.get(socket.roomId).size) rooms.delete(socket.roomId);
    }
  });
});

wss.on('error', (err) => {
  console.error('[dev-ws] server error:', err);
});
