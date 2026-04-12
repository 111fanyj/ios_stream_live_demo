const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = Number(process.env.PORT || 3000);
const rooms = new Map();
let nextClientId = 1;

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function summarizeSignal(signal) {
  if (!signal || typeof signal !== 'object') {
    return { type: 'unknown' };
  }

  if (signal.type === 'candidate') {
    return {
      type: 'candidate',
      hasCandidate: Boolean(signal.candidate?.candidate)
    };
  }

  if (signal.type === 'offer' || signal.type === 'answer') {
    return {
      type: signal.type,
      sdpLength: typeof signal.sdp === 'string' ? signal.sdp.length : 0
    };
  }

  return { type: signal.type ?? 'unknown' };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      publisher: null,
      viewers: new Map(),
      probes: new Map(),
      publisherConnectedAt: null
    });
  }

  return rooms.get(roomId);
}

function makeClientId() {
  const sequence = nextClientId;
  nextClientId += 1;
  return `client-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function getViewerIds(room) {
  return Array.from(room.viewers.keys());
}

function getProbeIds(room) {
  return Array.from(room.probes.keys());
}

function getClientById(room, clientId) {
  if (!clientId) {
    return null;
  }

  if (room.publisher && room.publisher.clientId === clientId) {
    return room.publisher;
  }

  return room.viewers.get(clientId) ?? null;
}

function broadcastRoomState(roomId) {
  const room = getRoom(roomId);
  const payload = JSON.stringify({
    type: 'room_state',
    roomId,
    hasPublisher: Boolean(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    viewerCount: room.viewers.size,
    probeCount: room.probes.size,
    publisherConnectedAt: room.publisherConnectedAt,
    transport: 'webrtc-datachannel'
  });

  log('room_state_broadcast', {
    roomId,
    hasPublisher: Boolean(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    viewerCount: room.viewers.size,
    viewerIds: getViewerIds(room),
    probeCount: room.probes.size,
    probeIds: getProbeIds(room)
  });

  for (const viewer of room.viewers.values()) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(payload);
    }
  }

  for (const probe of room.probes.values()) {
    if (probe.readyState === WebSocket.OPEN) {
      probe.send(payload);
    }
  }

  if (room.publisher?.readyState === WebSocket.OPEN) {
    room.publisher.send(payload);
  }
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
    probeCount: room.probes.size,
    publisherConnectedAt: room.publisherConnectedAt,
    transport: 'webrtc-datachannel'
  }));

  res.json({ ok: true, rooms: roomSummary });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type');
  const roomId = url.searchParams.get('roomId') || 'default';
  const expectedToken = process.env.STREAM_TOKEN;
  const incomingToken = url.searchParams.get('token');

  log('ws_connection_attempt', {
    path: url.pathname,
    search: url.search,
    clientType,
    roomId,
    ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] ?? 'unknown'
  });

  if (!clientType || !['publisher', 'viewer', 'probe'].includes(clientType)) {
    log('client_rejected', { reason: 'invalid_client_type', clientType, roomId });
    safeSend(ws, { type: 'error', message: 'Missing or invalid client type' });
    ws.close();
    return;
  }

  if (expectedToken && incomingToken !== expectedToken) {
    log('client_rejected', { reason: 'invalid_token', clientType, roomId });
    safeSend(ws, { type: 'error', message: 'Invalid token' });
    ws.close();
    return;
  }

  const room = getRoom(roomId);
  ws.clientType = clientType;
  ws.roomId = roomId;
  ws.clientId = makeClientId();

  log('client_connected', { clientType, roomId, clientId: ws.clientId, ip: req.socket.remoteAddress });

  if (clientType === 'publisher') {
    if (room.publisher && room.publisher.readyState === WebSocket.OPEN) {
      safeSend(room.publisher, { type: 'warning', message: 'Publisher replaced by a new connection' });
      room.publisher.close();
    }

    room.publisher = ws;
    room.publisherConnectedAt = new Date().toISOString();

    safeSend(ws, {
      type: 'publisher_ready',
      clientId: ws.clientId,
      roomId,
      viewerCount: room.viewers.size,
      viewerIds: getViewerIds(room)
    });

    for (const viewerId of getViewerIds(room)) {
      safeSend(ws, {
        type: 'viewer_joined',
        viewerId
      });
    }

    broadcastRoomState(roomId);
  } else if (clientType === 'viewer') {
    room.viewers.set(ws.clientId, ws);
    safeSend(ws, {
      type: 'viewer_ready',
      clientId: ws.clientId,
      roomId,
      hasPublisher: Boolean(room.publisher),
      publisherId: room.publisher?.clientId ?? null,
      viewerCount: room.viewers.size,
      transport: 'webrtc-datachannel'
    });

    if (room.publisher) {
      safeSend(room.publisher, {
        type: 'viewer_joined',
        viewerId: ws.clientId
      });
    }

    broadcastRoomState(roomId);
  } else {
    room.probes.set(ws.clientId, ws);
    safeSend(ws, {
      type: 'probe_ready',
      clientId: ws.clientId,
      roomId,
      hasPublisher: Boolean(room.publisher),
      publisherId: room.publisher?.clientId ?? null,
      viewerCount: room.viewers.size,
      probeCount: room.probes.size,
      transport: 'webrtc-datachannel'
    });

    broadcastRoomState(roomId);
  }

  ws.on('message', (rawMessage) => {
    if (ws.clientType === 'probe') {
      log('probe_message_ignored', {
        roomId: ws.roomId,
        clientId: ws.clientId,
        size: rawMessage.length ?? rawMessage.toString().length
      });
      safeSend(ws, { type: 'warning', message: 'Probe clients do not participate in signaling' });
      return;
    }

    log('message_received', {
      clientType: ws.clientType,
      roomId: ws.roomId,
      clientId: ws.clientId,
      size: rawMessage.length ?? rawMessage.toString().length
    });

    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (_error) {
      log('message_rejected', {
        clientType: ws.clientType,
        roomId: ws.roomId,
        clientId: ws.clientId,
        reason: 'invalid_json'
      });
      safeSend(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    log('message_parsed', {
      clientType: ws.clientType,
      roomId: ws.roomId,
      clientId: ws.clientId,
      type: message.type,
      targetId: message.targetId ?? null,
      signal: summarizeSignal(message.signal)
    });

    if (message.type !== 'signal' || !message.targetId || !message.signal) {
      log('message_rejected', {
        clientType: ws.clientType,
        roomId: ws.roomId,
        clientId: ws.clientId,
        reason: 'unsupported_message_format',
        type: message.type
      });
      safeSend(ws, { type: 'error', message: 'Unsupported message format' });
      return;
    }

    const targetClient = getClientById(room, message.targetId);
    if (!targetClient) {
      log('message_rejected', {
        clientType: ws.clientType,
        roomId: ws.roomId,
        clientId: ws.clientId,
        reason: 'target_unavailable',
        targetId: message.targetId
      });
      safeSend(ws, { type: 'error', message: 'Target client is unavailable' });
      return;
    }

    if (targetClient.clientType === ws.clientType) {
      log('message_rejected', {
        clientType: ws.clientType,
        roomId: ws.roomId,
        clientId: ws.clientId,
        reason: 'same_client_type',
        targetId: message.targetId,
        signal: summarizeSignal(message.signal)
      });
      safeSend(ws, { type: 'error', message: 'Signals must be sent to the opposite client type' });
      return;
    }

    log('signal_relaying', {
      roomId,
      sourceId: ws.clientId,
      sourceType: ws.clientType,
      targetId: message.targetId,
      targetType: targetClient.clientType,
      signal: summarizeSignal(message.signal)
    });

    safeSend(targetClient, {
      type: 'signal',
      roomId,
      sourceId: ws.clientId,
      signal: message.signal
    });

    if (message.signal.type === 'offer' || message.signal.type === 'answer') {
      log('webrtc_description_relayed', {
        roomId,
        sourceId: ws.clientId,
        targetId: message.targetId,
        descriptionType: message.signal.type
      });
      return;
    }

    if (message.signal.type === 'candidate') {
      log('webrtc_candidate_relayed', {
        roomId,
        sourceId: ws.clientId,
        targetId: message.targetId
      });
    }
  });

  ws.on('error', (error) => {
    log('client_error', {
      clientType: ws.clientType,
      roomId: ws.roomId,
      clientId: ws.clientId,
      message: error.message
    });
  });

  ws.on('close', () => {
    const currentRoom = getRoom(ws.roomId);
    if (ws.clientType === 'publisher' && currentRoom.publisher === ws) {
      currentRoom.publisher = null;
      currentRoom.publisherConnectedAt = null;

      for (const viewer of currentRoom.viewers.values()) {
        safeSend(viewer, {
          type: 'publisher_left',
          publisherId: ws.clientId
        });
      }
    }

    if (ws.clientType === 'viewer') {
      currentRoom.viewers.delete(ws.clientId);

      if (currentRoom.publisher) {
        safeSend(currentRoom.publisher, {
          type: 'viewer_left',
          viewerId: ws.clientId
        });
      }
    }

    if (ws.clientType === 'probe') {
      currentRoom.probes.delete(ws.clientId);
    }

    if (!currentRoom.publisher && currentRoom.viewers.size === 0 && currentRoom.probes.size === 0) {
      log('room_removed', { roomId: ws.roomId });
      rooms.delete(ws.roomId);
      return;
    }

    log('client_closed', {
      clientType: ws.clientType,
      roomId: ws.roomId,
      clientId: ws.clientId,
      hasPublisher: Boolean(currentRoom.publisher),
      viewers: currentRoom.viewers.size,
      probes: currentRoom.probes.size
    });

    broadcastRoomState(ws.roomId);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ios-stream-viewer server listening on http://0.0.0.0:${port}`);
});