const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = Number(process.env.PORT || 3000);
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      publisher: null,
      viewers: new Set(),
      lastFrame: null,
      lastMeta: null,
      publisherConnectedAt: null
    });
  }

  return rooms.get(roomId);
}

function broadcastRoomState(roomId) {
  const room = getRoom(roomId);
  const payload = JSON.stringify({
    type: 'room_state',
    roomId,
    hasPublisher: Boolean(room.publisher),
    viewerCount: room.viewers.size,
    publisherConnectedAt: room.publisherConnectedAt,
    lastMeta: room.lastMeta
  });

  for (const viewer of room.viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(payload);
    }
  }
}

function sendLastFrame(ws, roomId) {
  const room = getRoom(roomId);
  if (!room.lastFrame || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(room.lastFrame));
}

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  const roomSummary = Array.from(rooms.entries()).map(([roomId, room]) => ({
    roomId,
    hasPublisher: Boolean(room.publisher),
    viewerCount: room.viewers.size,
    lastMeta: room.lastMeta
  }));

  res.json({ ok: true, rooms: roomSummary });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type');
  const roomId = url.searchParams.get('roomId') || 'default';
  const expectedToken = process.env.STREAM_TOKEN;
  const incomingToken = url.searchParams.get('token');

  if (!clientType || !['publisher', 'viewer'].includes(clientType)) {
    safeSend(ws, { type: 'error', message: 'Missing or invalid client type' });
    ws.close();
    return;
  }

  if (expectedToken && incomingToken !== expectedToken) {
    safeSend(ws, { type: 'error', message: 'Invalid token' });
    ws.close();
    return;
  }

  const room = getRoom(roomId);
  ws.clientType = clientType;
  ws.roomId = roomId;

  if (clientType === 'publisher') {
    if (room.publisher && room.publisher.readyState === WebSocket.OPEN) {
      safeSend(room.publisher, { type: 'warning', message: 'Publisher replaced by a new connection' });
      room.publisher.close();
    }

    room.publisher = ws;
    room.publisherConnectedAt = new Date().toISOString();

    safeSend(ws, {
      type: 'publisher_ready',
      roomId,
      viewerCount: room.viewers.size
    });
    broadcastRoomState(roomId);
  } else {
    room.viewers.add(ws);
    safeSend(ws, {
      type: 'viewer_ready',
      roomId,
      hasPublisher: Boolean(room.publisher),
      viewerCount: room.viewers.size
    });
    broadcastRoomState(roomId);
    sendLastFrame(ws, roomId);
  }

  ws.on('message', (rawMessage) => {
    if (ws.clientType !== 'publisher') {
      return;
    }

    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (_error) {
      safeSend(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    if (message.type !== 'frame' || typeof message.imageData !== 'string') {
      safeSend(ws, { type: 'error', message: 'Unsupported message format' });
      return;
    }

    room.lastFrame = {
      type: 'frame',
      roomId,
      imageData: message.imageData,
      mimeType: message.mimeType || 'image/jpeg',
      width: message.width || null,
      height: message.height || null,
      timestamp: message.timestamp || Date.now(),
      sequence: message.sequence || null
    };
    room.lastMeta = {
      width: room.lastFrame.width,
      height: room.lastFrame.height,
      timestamp: room.lastFrame.timestamp,
      sequence: room.lastFrame.sequence
    };

    for (const viewer of room.viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(JSON.stringify(room.lastFrame));
      }
    }
  });

  ws.on('close', () => {
    const currentRoom = getRoom(ws.roomId);
    if (ws.clientType === 'publisher' && currentRoom.publisher === ws) {
      currentRoom.publisher = null;
      currentRoom.publisherConnectedAt = null;
    }

    if (ws.clientType === 'viewer') {
      currentRoom.viewers.delete(ws);
    }

    if (!currentRoom.publisher && currentRoom.viewers.size === 0) {
      rooms.delete(ws.roomId);
      return;
    }

    broadcastRoomState(ws.roomId);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ios-stream-viewer server listening on http://0.0.0.0:${port}`);
});