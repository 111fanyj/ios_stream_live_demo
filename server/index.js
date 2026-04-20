const express = require('express');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const JSZip = require('jszip');
const { WebSocket, WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = Number(process.env.PORT || 3000);
const automationRoot = path.join(__dirname, 'data', 'automation');
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
    transport: 'webrtc-video-track'
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

function sanitizePackageId(packageId) {
  const value = String(packageId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    return null;
  }

  return value;
}

function sanitizeAssetId(assetId) {
  const value = String(assetId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    return null;
  }

  return value;
}

function packageDirectory(packageId) {
  return path.join(automationRoot, packageId);
}

function revisionDirectory(packageId, revision) {
  return path.join(packageDirectory(packageId), String(revision));
}

function metadataPath(packageId) {
  return path.join(packageDirectory(packageId), 'metadata.json');
}

async function readJSON(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function writeJSON(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listPackageIds() {
  try {
    const entries = await fs.readdir(automationRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function readPackageMetadata(packageId) {
  return readJSON(metadataPath(packageId), {
    packageId,
    name: packageId,
    latestRevision: 0,
    activeRevision: null,
    revisions: []
  });
}

function normalizeAutomationPayload(body, revision) {
  const automation = body?.automation && typeof body.automation === 'object' ? body.automation : body;
  const packageId = sanitizePackageId(automation?.packageId);
  if (!packageId) {
    const error = new Error('packageId must use 1-64 letters, numbers, "_" or "-"');
    error.statusCode = 400;
    throw error;
  }

  const steps = Array.isArray(automation.steps) ? automation.steps : [];
  const normalized = {
    schemaVersion: 1,
    packageId,
    revision,
    name: String(automation.name || packageId).slice(0, 120),
    steps
  };

  return normalized;
}

function decodeImageAsset(asset) {
  const assetId = sanitizeAssetId(asset?.assetId);
  if (!assetId) {
    const error = new Error('image assetId must use letters, numbers, "_" or "-"');
    error.statusCode = 400;
    throw error;
  }

  const raw = String(asset.dataUrl || asset.base64 || '');
  const match = raw.match(/^data:image\/png;base64,(.+)$/);
  const base64 = match ? match[1] : raw;
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) {
    const error = new Error(`image asset "${assetId}" is empty`);
    error.statusCode = 400;
    throw error;
  }

  return { assetId, data };
}

async function buildAutomationZip(automation, images) {
  const zip = new JSZip();
  zip.file('automation.json', JSON.stringify(automation, null, 2));
  const imageFolder = zip.folder('images');
  for (const image of images) {
    imageFolder.file(`${image.assetId}.png`, image.data);
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

async function saveAutomationPackage(body) {
  const candidatePackageId = sanitizePackageId(body?.automation?.packageId || body?.packageId);
  if (!candidatePackageId) {
    const error = new Error('packageId must use 1-64 letters, numbers, "_" or "-"');
    error.statusCode = 400;
    throw error;
  }

  const metadata = await readPackageMetadata(candidatePackageId);
  const revision = Number(metadata.latestRevision || 0) + 1;
  const automation = normalizeAutomationPayload(body, revision);
  const images = Array.isArray(body?.images) ? body.images.map(decodeImageAsset) : [];
  const createdAt = new Date().toISOString();
  const dir = revisionDirectory(automation.packageId, revision);
  const imagesDir = path.join(dir, 'images');

  await fs.mkdir(imagesDir, { recursive: true });
  await writeJSON(path.join(dir, 'automation.json'), automation);
  for (const image of images) {
    await fs.writeFile(path.join(imagesDir, `${image.assetId}.png`), image.data);
  }

  const zipBuffer = await buildAutomationZip(automation, images);
  const zipPath = path.join(dir, 'package.zip');
  await fs.writeFile(zipPath, zipBuffer);

  const revisionEntry = {
    packageId: automation.packageId,
    revision,
    name: automation.name,
    createdAt,
    zipSize: zipBuffer.length,
    imageCount: images.length,
    stepCount: automation.steps.length,
    downloadUrl: `/api/automation/packages/${automation.packageId}/download?revision=${revision}`
  };

  const nextMetadata = {
    packageId: automation.packageId,
    name: automation.name,
    latestRevision: revision,
    activeRevision: revision,
    updatedAt: createdAt,
    revisions: [
      ...metadata.revisions.filter((entry) => entry.revision !== revision),
      revisionEntry
    ]
  };

  await writeJSON(metadataPath(automation.packageId), nextMetadata);
  return revisionEntry;
}

function broadcastAutomationEvent(roomId, source, event) {
  const room = getRoom(roomId);
  const payload = JSON.stringify({
    type: 'automation_event',
    roomId,
    sourceId: source.clientId,
    event
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

  log('automation_event_broadcast', {
    roomId,
    sourceId: source.clientId,
    eventType: event?.type,
    stepId: event?.stepId
  });
}

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  const roomSummary = Array.from(rooms.entries()).map(([roomId, room]) => ({
    roomId,
    hasPublisher: Boolean(room.publisher),
    viewerCount: room.viewers.size,
    probeCount: room.probes.size,
    publisherConnectedAt: room.publisherConnectedAt,
    transport: 'webrtc-video-track'
  }));

  res.json({ ok: true, rooms: roomSummary });
});

app.get('/api/automation/packages', async (_req, res, next) => {
  try {
    const packageIds = await listPackageIds();
    const packages = await Promise.all(packageIds.map(readPackageMetadata));
    res.json({ packages });
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/packages', async (req, res, next) => {
  try {
    const revision = await saveAutomationPackage(req.body);
    res.status(201).json({ ok: true, revision });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/packages/:packageId', async (req, res, next) => {
  try {
    const packageId = sanitizePackageId(req.params.packageId);
    if (!packageId) {
      res.status(400).json({ error: 'Invalid packageId' });
      return;
    }

    const metadata = await readPackageMetadata(packageId);
    if (metadata.latestRevision === 0) {
      res.status(404).json({ error: 'Package not found' });
      return;
    }

    res.json(metadata);
  } catch (error) {
    next(error);
  }
});

app.post('/api/automation/packages/:packageId/active', async (req, res, next) => {
  try {
    const packageId = sanitizePackageId(req.params.packageId);
    const revision = Number(req.body?.revision);
    if (!packageId || !Number.isInteger(revision) || revision < 1) {
      res.status(400).json({ error: 'Invalid packageId or revision' });
      return;
    }

    const metadata = await readPackageMetadata(packageId);
    if (!metadata.revisions.some((entry) => entry.revision === revision)) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }

    metadata.activeRevision = revision;
    metadata.updatedAt = new Date().toISOString();
    await writeJSON(metadataPath(packageId), metadata);
    res.json({ ok: true, packageId, activeRevision: revision });
  } catch (error) {
    next(error);
  }
});

app.get('/api/automation/packages/:packageId/download', async (req, res, next) => {
  try {
    const packageId = sanitizePackageId(req.params.packageId);
    if (!packageId) {
      res.status(400).json({ error: 'Invalid packageId' });
      return;
    }

    const metadata = await readPackageMetadata(packageId);
    const requestedRevision = req.query.revision === 'latest' || !req.query.revision
      ? metadata.latestRevision
      : Number(req.query.revision);
    const revision = Number.isInteger(requestedRevision) ? requestedRevision : Number(requestedRevision);
    if (!revision || !metadata.revisions.some((entry) => entry.revision === revision)) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }

    const zipPath = path.join(revisionDirectory(packageId, revision), 'package.zip');
    res.download(zipPath, `${packageId}-r${revision}.zip`);
  } catch (error) {
    next(error);
  }
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
      transport: 'webrtc-video-track'
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
      transport: 'webrtc-video-track'
    });

    broadcastRoomState(roomId);
  }

  ws.on('message', (rawMessage) => {
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

    if (message.type === 'automation_event') {
      if (ws.clientType !== 'publisher') {
        log('automation_event_rejected', {
          roomId: ws.roomId,
          clientId: ws.clientId,
          clientType: ws.clientType,
          reason: 'publisher_only'
        });
        safeSend(ws, { type: 'error', message: 'Only publisher clients can send automation events' });
        return;
      }

      broadcastAutomationEvent(ws.roomId, ws, message.event || {});
      return;
    }

    if (ws.clientType === 'probe') {
      log('probe_message_ignored', {
        roomId: ws.roomId,
        clientId: ws.clientId,
        size: rawMessage.length ?? rawMessage.toString().length
      });
      safeSend(ws, { type: 'warning', message: 'Probe clients do not participate in signaling' });
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

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  log('http_error', { statusCode, message: error.message });
  res.status(statusCode).json({ error: error.message || 'Internal server error' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ios-stream-viewer server listening on http://0.0.0.0:${port}`);
});
