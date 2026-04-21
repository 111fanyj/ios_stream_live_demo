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
const automationSessions = new Map();
let nextClientId = 1;
let nextAutomationSequence = 1;

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function makeStatusError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
      executor: null,
      viewers: new Map(),
      probes: new Map(),
      publisherConnectedAt: null,
      executorConnectedAt: null
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

function getExecutorId(room) {
  return room.executor?.clientId ?? null;
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
    hasExecutor: Boolean(room.executor),
    executorId: getExecutorId(room),
    viewerCount: room.viewers.size,
    probeCount: room.probes.size,
    publisherConnectedAt: room.publisherConnectedAt,
    executorConnectedAt: room.executorConnectedAt,
    transport: 'webrtc-video-track'
  });

  log('room_state_broadcast', {
    roomId,
    hasPublisher: Boolean(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    hasExecutor: Boolean(room.executor),
    executorId: getExecutorId(room),
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

  if (room.executor?.readyState === WebSocket.OPEN) {
    room.executor.send(payload);
  }
}

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isClientOpen(ws) {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function sendToPublisher(roomId, payload) {
  const publisher = getRoom(roomId).publisher;
  if (!isClientOpen(publisher)) {
    return false;
  }

  publisher.send(JSON.stringify(payload));
  return true;
}

function sendToExecutor(roomId, payload) {
  const executor = getRoom(roomId).executor;
  if (!isClientOpen(executor)) {
    return false;
  }

  executor.send(JSON.stringify(payload));
  return true;
}

function makeAutomationId(prefix) {
  const sequence = nextAutomationSequence;
  nextAutomationSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function normalizePoint(point) {
  if (!point || typeof point !== 'object') {
    return null;
  }

  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y))
  };
}

function regionContainsPoint(region, point) {
  if (!region) {
    return true;
  }

  const normalized = normalizePoint(point);
  if (!normalized) {
    return false;
  }

  const regionX = Number(region.x ?? 0);
  const regionY = Number(region.y ?? 0);
  const regionWidth = Number(region.width ?? 0);
  const regionHeight = Number(region.height ?? 0);
  return normalized.x >= regionX &&
    normalized.x <= regionX + regionWidth &&
    normalized.y >= regionY &&
    normalized.y <= regionY + regionHeight;
}

function matchesText(text, query, mode) {
  const rawText = String(text || '').trim();
  const rawQuery = String(query || '').trim();
  if (!rawText || !rawQuery) {
    return false;
  }

  const value = rawText.toLocaleLowerCase();
  const expected = rawQuery.toLocaleLowerCase();
  if (mode === 'equals') {
    return value === expected;
  }

  return value.includes(expected);
}

function resolveAutomationTarget(session, target) {
  if (!target || typeof target !== 'object') {
    return null;
  }

  if (typeof target.ref === 'string' && target.ref) {
    return normalizePoint(session.variables[target.ref]);
  }

  return normalizePoint(target);
}

function collectImageAssetIds(steps) {
  const assetIds = new Set();
  for (const step of steps) {
    if (step?.type === 'waitForImage' && typeof step.assetId === 'string' && step.assetId) {
      assetIds.add(step.assetId);
    }
  }
  return Array.from(assetIds.values());
}

function getAutomationSession(roomId, sessionId) {
  const session = automationSessions.get(roomId);
  if (!session) {
    return null;
  }

  if (sessionId && session.sessionId !== sessionId) {
    return null;
  }

  return session;
}

function clearAutomationTimer(session) {
  if (session?.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function clearPendingSessionCommand(session, key) {
  if (session?.[key]?.timeoutHandle) {
    clearTimeout(session[key].timeoutHandle);
  }
  if (session) {
    session[key] = null;
  }
}

function clearPendingPublisherCommand(session) {
  clearPendingSessionCommand(session, 'pendingPublisherCommand');
}

function clearPendingExecutorCommand(session) {
  clearPendingSessionCommand(session, 'pendingExecutorCommand');
}

function broadcastAutomationPayload(roomId, payload) {
  const room = getRoom(roomId);
  for (const viewer of room.viewers.values()) {
    safeSend(viewer, payload);
  }

  for (const probe of room.probes.values()) {
    safeSend(probe, payload);
  }
}

function buildAutomationStatusPayload(session, status, message, extra = {}) {
  return {
    type: 'automation_status',
    roomId: session.roomId,
    sessionId: session.sessionId,
    ownerViewerId: session.ownerViewerId,
    packageId: session.packageId,
    revision: session.revision,
    status,
    message,
    stepId: extra.stepId ?? null,
    currentStepIndex: session.currentStepIndex,
    currentStepNumber: Math.min(session.currentStepIndex + 1, session.document.steps.length),
    stepCount: session.document.steps.length,
    detail: extra.detail
  };
}

function broadcastAutomationStatus(session, status, message, extra = {}) {
  const payload = buildAutomationStatusPayload(session, status, message, extra);
  broadcastAutomationPayload(session.roomId, payload);
  log('automation_status', {
    roomId: session.roomId,
    sessionId: session.sessionId,
    status,
    message,
    stepId: extra.stepId ?? null,
    currentStepIndex: session.currentStepIndex,
    stepCount: session.document.steps.length
  });
}

function broadcastAutomationStatusSnapshot(roomId, payload) {
  broadcastAutomationPayload(roomId, {
    type: 'automation_status',
    roomId,
    sessionId: payload.sessionId ?? null,
    ownerViewerId: payload.ownerViewerId ?? null,
    packageId: payload.packageId ?? null,
    revision: payload.revision ?? null,
    status: payload.status,
    message: payload.message,
    stepId: payload.stepId ?? null,
    currentStepIndex: payload.currentStepIndex ?? 0,
    currentStepNumber: payload.currentStepNumber ?? 0,
    stepCount: payload.stepCount ?? 0,
    detail: payload.detail
  });
}

function broadcastAutomationAction(session, step, action, command) {
  const payload = {
    type: 'automation_action',
    roomId: session.roomId,
    sessionId: session.sessionId,
    ownerViewerId: session.ownerViewerId,
    packageId: session.packageId,
    revision: session.revision,
    stepId: step.id,
    action,
    command
  };

  broadcastAutomationPayload(session.roomId, payload);
  log('automation_action', {
    roomId: session.roomId,
    sessionId: session.sessionId,
    action,
    stepId: step.id,
    command
  });
}

function broadcastExecutorResult(session, result) {
  const payload = {
    type: 'executor_result',
    roomId: session.roomId,
    sessionId: session.sessionId,
    ownerViewerId: session.ownerViewerId,
    packageId: session.packageId,
    revision: session.revision,
    stepId: result.stepId ?? null,
    requestId: result.requestId,
    action: result.action,
    status: result.status,
    payload: result.payload,
    error: result.error ?? null
  };

  broadcastAutomationPayload(session.roomId, payload);
  log('executor_result_broadcast', {
    roomId: session.roomId,
    sessionId: session.sessionId,
    requestId: result.requestId,
    action: result.action,
    status: result.status,
    stepId: result.stepId ?? null
  });
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

async function loadAutomationBundle(packageId, requestedRevision) {
  const metadata = await readPackageMetadata(packageId);
  if (metadata.latestRevision === 0) {
    throw makeStatusError('Package not found', 404);
  }

  const revision = requestedRevision == null
    ? Number(metadata.activeRevision || metadata.latestRevision)
    : Number(requestedRevision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw makeStatusError('Invalid revision', 400);
  }

  if (!metadata.revisions.some((entry) => entry.revision === revision)) {
    throw makeStatusError('Revision not found', 404);
  }

  const dir = revisionDirectory(packageId, revision);
  const document = await readJSON(path.join(dir, 'automation.json'));
  if (!document || !Array.isArray(document.steps)) {
    throw makeStatusError('automation.json is missing or invalid', 500);
  }

  const imageAssets = {};
  for (const assetId of collectImageAssetIds(document.steps)) {
    const imagePath = path.join(dir, 'images', `${assetId}.png`);
    try {
      const imageData = await fs.readFile(imagePath);
      imageAssets[assetId] = `data:image/png;base64,${imageData.toString('base64')}`;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw makeStatusError(`Missing image asset: ${assetId}`, 500);
      }
      throw error;
    }
  }

  return { document, imageAssets, metadata, revision };
}

function scheduleAutomationStep(session, delayMs) {
  clearAutomationTimer(session);
  session.timer = setTimeout(() => {
    const activeSession = getAutomationSession(session.roomId, session.sessionId);
    if (!activeSession) {
      return;
    }

    try {
      executeAutomationStep(activeSession);
    } catch (error) {
      finalizeAutomationSession(activeSession.roomId, 'error', error.message || '执行步骤失败', {
        stepId: activeSession.document.steps[activeSession.currentStepIndex]?.id ?? null
      });
    }
  }, Math.max(0, delayMs));
}

function dispatchSessionCommand(session, commandKey, send, messageType, nameField, nameValue, payload, options = {}) {
  const requestId = makeAutomationId('automation-request');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 12_000);
  const command = {
    type: messageType,
    roomId: session.roomId,
    sessionId: session.sessionId,
    requestId,
    [nameField]: nameValue,
    packageId: session.packageId,
    revision: session.revision,
    stepId: options.stepId ?? null,
    payload
  };

  clearPendingSessionCommand(session, commandKey);
  if (!send(session.roomId, command)) {
    throw makeStatusError(options.unavailableMessage || '目标端不可用', 409);
  }

  const timeoutHandle = setTimeout(() => {
    const activeSession = getAutomationSession(session.roomId, session.sessionId);
    if (!activeSession || activeSession[commandKey]?.requestId !== requestId) {
      return;
    }

    finalizeAutomationSession(activeSession.roomId, 'error', `${options.timeoutLabel || nameValue} 超时`, {
      stepId: options.stepId ?? null,
      sendStopCommand: options.sendStopCommandOnTimeout
    });
  }, timeoutMs);

  session[commandKey] = {
    requestId,
    [nameField]: nameValue,
    stepId: options.stepId ?? null,
    timeoutHandle,
    nextDelayMs: Math.max(0, Number(options.nextDelayMs) || 0)
  };

  log(`${messageType}_dispatched`, {
    roomId: session.roomId,
    sessionId: session.sessionId,
    [nameField]: nameValue,
    requestId,
    stepId: options.stepId ?? null
  });

  return requestId;
}

function dispatchPublisherCommand(session, method, payload, options = {}) {
  return dispatchSessionCommand(
    session,
    'pendingPublisherCommand',
    sendToPublisher,
    'automation_command',
    'method',
    method,
    payload,
    {
      unavailableMessage: 'Publisher is unavailable',
      sendStopCommandOnTimeout: false,
      timeoutLabel: `方法 ${method}`,
      ...options
    }
  );
}

function dispatchExecutorCommand(session, action, payload, options = {}) {
  return dispatchSessionCommand(
    session,
    'pendingExecutorCommand',
    sendToExecutor,
    'executor_command',
    'action',
    action,
    payload,
    {
      unavailableMessage: 'Executor is unavailable',
      sendStopCommandOnTimeout: true,
      timeoutLabel: `动作 ${action}`,
      ...options
    }
  );
}

function finalizeAutomationSession(roomId, status, message, options = {}) {
  const session = automationSessions.get(roomId);
  if (!session) {
    return;
  }

  clearAutomationTimer(session);
  clearPendingPublisherCommand(session);
  clearPendingExecutorCommand(session);
  automationSessions.delete(roomId);

  if (options.sendStopCommand !== false) {
    sendToPublisher(roomId, {
      type: 'automation_command',
      roomId,
      sessionId: session.sessionId,
      requestId: makeAutomationId('automation-request'),
      method: 'StopCheck',
      packageId: session.packageId,
      revision: session.revision,
      stepId: options.stepId ?? null,
      payload: {
        reason: message
      }
    });
  }

  broadcastAutomationStatus(session, status, message, {
    stepId: options.stepId ?? null,
    detail: options.detail
  });
}

function buildCheckStepPayload(session, step) {
  const payloadStep = {
    ...step
  };

  if (step.type === 'waitForImage') {
    const imageDataURL = session.imageAssets[step.assetId];
    if (!imageDataURL) {
      throw makeStatusError(`Image asset is unavailable: ${step.assetId || 'unknown'}`, 500);
    }
    payloadStep.imageDataURL = imageDataURL;
  }

  return payloadStep;
}

function selectTextMatch(step, payload) {
  const candidates = Array.isArray(payload?.ocrCandidates) ? payload.ocrCandidates : [];
  for (const candidate of candidates) {
    if (!matchesText(candidate?.text, step.query, step.match || 'contains')) {
      continue;
    }

    const point = normalizePoint(candidate?.point);
    if (!point || !regionContainsPoint(step.region, point)) {
      continue;
    }

    return {
      point,
      text: String(candidate.text || ''),
      confidence: Number(candidate.confidence) || 0
    };
  }

  return null;
}

function selectImageMatch(step, payload) {
  const match = payload?.bestImageMatch;
  if (!match || typeof match !== 'object') {
    return null;
  }

  const point = normalizePoint(match.point);
  const score = Number(match.score);
  if (!point || !Number.isFinite(score)) {
    return null;
  }

  if (!regionContainsPoint(step.region, point)) {
    return null;
  }

  const threshold = Number(step.threshold ?? 0.84);
  if (score < threshold) {
    return null;
  }

  return { point, score };
}

function handleCheckNextItemResult(session, payload, responseStepId) {
  const step = session.document.steps[session.currentStepIndex];
  if (!step) {
    finalizeAutomationSession(session.roomId, 'completed', '自动化流程完成');
    return;
  }

  if (responseStepId && responseStepId !== step.id) {
    throw makeStatusError(`检查结果与当前步骤不一致: expected ${step.id}, received ${responseStepId}`, 409);
  }

  const waitState = session.waitState && session.waitState.stepId === step.id
    ? session.waitState
    : { stepId: step.id, startedAt: Date.now(), attempts: 0 };
  session.waitState = waitState;

  let matched = null;
  if (step.type === 'waitForText') {
    matched = selectTextMatch(step, payload);
  } else if (step.type === 'waitForImage') {
    matched = selectImageMatch(step, payload);
  } else {
    throw makeStatusError(`Unsupported wait step type: ${step.type}`, 400);
  }

  if (matched) {
    if (step.saveAs) {
      session.variables[step.saveAs] = matched.point;
    }

    broadcastAutomationStatus(session, 'matched', `命中步骤 ${step.id}`, {
      stepId: step.id,
      detail: matched
    });
    session.currentStepIndex += 1;
    session.waitState = null;
    scheduleAutomationStep(session, 0);
    return;
  }

  const timeoutMs = Number(step.timeoutMs) || 10_000;
  const pollIntervalMs = Number(step.pollIntervalMs) || 500;
  const elapsedMs = Date.now() - waitState.startedAt;
  if (elapsedMs >= timeoutMs) {
    finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 等待超时`, {
      stepId: step.id,
      detail: {
        elapsedMs,
        timeoutMs
      }
    });
    return;
  }

  broadcastAutomationStatus(session, 'polling', `步骤 ${step.id} 未命中，继续检查`, {
    stepId: step.id,
    detail: {
      attempts: waitState.attempts,
      elapsedMs,
      payload
    }
  });
  scheduleAutomationStep(session, pollIntervalMs);
}

function executeAutomationStep(session) {
  if (session.pendingPublisherCommand || session.pendingExecutorCommand) {
    return;
  }

  if (!isClientOpen(getRoom(session.roomId).publisher)) {
    finalizeAutomationSession(session.roomId, 'error', 'Publisher 已断开', {
      sendStopCommand: false
    });
    return;
  }

  if (session.currentStepIndex >= session.document.steps.length) {
    finalizeAutomationSession(session.roomId, 'completed', '自动化流程完成');
    return;
  }

  const step = session.document.steps[session.currentStepIndex];
  if (!step || typeof step.type !== 'string') {
    throw makeStatusError(`Invalid automation step at index ${session.currentStepIndex}`, 500);
  }

  if (step.type === 'tap') {
    const point = resolveAutomationTarget(session, step.target);
    if (!point) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的点击目标不存在`, {
        stepId: step.id
      });
      return;
    }

    const requestId = dispatchExecutorCommand(session, 'tap', { point }, {
      stepId: step.id,
      timeoutMs: 15_000,
      nextDelayMs: Number(step.postActionDelayMs) || 350
    });
    broadcastAutomationAction(session, step, 'tap', { point, requestId });
    return;
  }

  if (step.type === 'drag') {
    const from = resolveAutomationTarget(session, step.from);
    const to = resolveAutomationTarget(session, step.to);
    if (!from || !to) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的拖拽目标不存在`, {
        stepId: step.id
      });
      return;
    }

    const command = {
      from,
      to,
      holdMs: Number(step.holdMs) || 120,
      durationMs: Number(step.durationMs) || 450
    };
    const requestId = dispatchExecutorCommand(session, 'drag', command, {
      stepId: step.id,
      timeoutMs: Math.max(15_000, command.durationMs + command.holdMs + 5_000),
      nextDelayMs: Number(step.postActionDelayMs) || 500
    });
    broadcastAutomationAction(session, step, 'drag', {
      ...command,
      requestId
    });
    return;
  }

  if (step.type !== 'waitForText' && step.type !== 'waitForImage') {
    finalizeAutomationSession(session.roomId, 'error', `不支持的步骤类型: ${step.type}`, {
      stepId: step.id,
      sendStopCommand: false
    });
    return;
  }

  if (!session.waitState || session.waitState.stepId !== step.id) {
    session.waitState = {
      stepId: step.id,
      startedAt: Date.now(),
      attempts: 0
    };
  }

  session.waitState.attempts += 1;
  const elapsedMs = Date.now() - session.waitState.startedAt;
  const timeoutMs = Number(step.timeoutMs) || 10_000;
  if (elapsedMs >= timeoutMs) {
    finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 等待超时`, {
      stepId: step.id,
      detail: {
        attempts: session.waitState.attempts,
        elapsedMs,
        timeoutMs
      }
    });
    return;
  }

  const payload = {
    step: buildCheckStepPayload(session, step),
    attempt: session.waitState.attempts
  };
  broadcastAutomationStatus(session, 'polling', `正在检查步骤 ${step.id}`, {
    stepId: step.id,
    detail: {
      attempts: session.waitState.attempts,
      elapsedMs
    }
  });
  dispatchPublisherCommand(session, 'checkNextItem', payload, {
    stepId: step.id,
    timeoutMs: Math.max(5_000, Number(step.pollIntervalMs) || 5000)
  });
}

async function startAutomationSession(roomId, viewer, packageId, revision) {
  const room = getRoom(roomId);
  if (!isClientOpen(room.publisher)) {
    throw makeStatusError('当前房间没有可用的 publisher', 409);
  }
  if (!isClientOpen(room.executor)) {
    throw makeStatusError('当前房间没有可用的 executor', 409);
  }

  const bundle = await loadAutomationBundle(packageId, revision);

  if (automationSessions.has(roomId)) {
    finalizeAutomationSession(roomId, 'stopped', '被新的执行请求替换');
  }

  const session = {
    sessionId: makeAutomationId('automation-session'),
    roomId,
    ownerViewerId: viewer.clientId,
    packageId: bundle.document.packageId,
    revision: bundle.revision,
    document: bundle.document,
    imageAssets: bundle.imageAssets,
    variables: {},
    currentStepIndex: 0,
    waitState: null,
    pendingPublisherCommand: null,
    pendingExecutorCommand: null,
    timer: null,
    createdAt: new Date().toISOString()
  };

  automationSessions.set(roomId, session);
  broadcastAutomationStatus(session, 'starting', `准备启动 ${session.packageId} r${session.revision}`);
  dispatchPublisherCommand(session, 'startCheckItem', {
    packageId: session.packageId,
    revision: session.revision,
    stepCount: session.document.steps.length
  }, {
    timeoutMs: 10_000
  });

  return session;
}

function stopAutomationSession(roomId, reason = '用户停止执行') {
  if (!automationSessions.has(roomId)) {
    return false;
  }

  finalizeAutomationSession(roomId, 'stopped', reason);
  return true;
}

function handleAutomationResult(roomId, message) {
  const session = getAutomationSession(roomId, message.sessionId);
  if (!session) {
    log('automation_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      method: message.method,
      reason: 'session_not_found'
    });
    return;
  }

  const pendingCommand = session.pendingPublisherCommand;
  if (!pendingCommand || pendingCommand.requestId !== message.requestId || pendingCommand.method !== message.method) {
    log('automation_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      method: message.method,
      reason: 'request_mismatch'
    });
    return;
  }

  clearPendingPublisherCommand(session);

  if (message.status !== 'ok') {
    finalizeAutomationSession(session.roomId, 'error', message.error || `方法 ${message.method} 执行失败`, {
      stepId: message.stepId || pendingCommand.stepId || null,
      sendStopCommand: false
    });
    return;
  }

  if (message.method === 'startCheckItem') {
    broadcastAutomationStatus(session, 'running', '远程检查会话已启动');
    scheduleAutomationStep(session, 0);
    return;
  }

  if (message.method === 'checkNextItem') {
    handleCheckNextItemResult(session, message.payload || {}, message.stepId || pendingCommand.stepId || null);
  }
}

function handleExecutorResult(roomId, message) {
  const session = getAutomationSession(roomId, message.sessionId);
  if (!session) {
    log('executor_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      action: message.action,
      reason: 'session_not_found'
    });
    return;
  }

  const pendingCommand = session.pendingExecutorCommand;
  if (!pendingCommand || pendingCommand.requestId !== message.requestId || pendingCommand.action !== message.action) {
    log('executor_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      action: message.action,
      reason: 'request_mismatch'
    });
    return;
  }

  clearPendingExecutorCommand(session);
  broadcastExecutorResult(session, {
    requestId: message.requestId,
    action: message.action,
    stepId: message.stepId || pendingCommand.stepId || null,
    status: message.status,
    payload: message.payload || null,
    error: message.error || null
  });

  if (message.status !== 'ok') {
    finalizeAutomationSession(session.roomId, 'error', message.error || `动作 ${message.action} 执行失败`, {
      stepId: message.stepId || pendingCommand.stepId || null
    });
    return;
  }

  const step = session.document.steps[session.currentStepIndex];
  if (!step || step.id !== (message.stepId || pendingCommand.stepId || step.id)) {
    finalizeAutomationSession(session.roomId, 'error', `动作结果与当前步骤不一致`, {
      stepId: message.stepId || pendingCommand.stepId || null,
      sendStopCommand: false
    });
    return;
  }

  broadcastAutomationStatus(session, 'running', `动作 ${message.action} 已完成`, {
    stepId: step.id,
    detail: message.payload || null
  });
  session.currentStepIndex += 1;
  scheduleAutomationStep(session, pendingCommand.nextDelayMs || 0);
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
    hasExecutor: Boolean(room.executor),
    viewerCount: room.viewers.size,
    probeCount: room.probes.size,
    publisherConnectedAt: room.publisherConnectedAt,
    executorConnectedAt: room.executorConnectedAt,
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

  if (!clientType || !['publisher', 'viewer', 'probe', 'executor'].includes(clientType)) {
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
  } else if (clientType === 'executor') {
    if (room.executor && room.executor.readyState === WebSocket.OPEN) {
      safeSend(room.executor, { type: 'warning', message: 'Executor replaced by a new connection' });
      room.executor.close();
    }

    room.executor = ws;
    room.executorConnectedAt = new Date().toISOString();

    safeSend(ws, {
      type: 'executor_ready',
      clientId: ws.clientId,
      roomId,
      hasPublisher: Boolean(room.publisher),
      publisherId: room.publisher?.clientId ?? null,
      viewerCount: room.viewers.size,
      probeCount: room.probes.size,
      transport: 'webrtc-video-track'
    });

    broadcastRoomState(roomId);
  } else if (clientType === 'viewer') {
    room.viewers.set(ws.clientId, ws);
    safeSend(ws, {
      type: 'viewer_ready',
      clientId: ws.clientId,
      roomId,
      hasPublisher: Boolean(room.publisher),
      publisherId: room.publisher?.clientId ?? null,
      hasExecutor: Boolean(room.executor),
      executorId: getExecutorId(room),
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
      hasExecutor: Boolean(room.executor),
      executorId: getExecutorId(room),
      viewerCount: room.viewers.size,
      probeCount: room.probes.size,
      transport: 'webrtc-video-track'
    });

    broadcastRoomState(roomId);
  }

  ws.on('message', async (rawMessage) => {
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

    if (message.type === 'automation_result') {
      if (ws.clientType !== 'publisher') {
        log('automation_result_rejected', {
          roomId: ws.roomId,
          clientId: ws.clientId,
          clientType: ws.clientType,
          reason: 'publisher_only'
        });
        safeSend(ws, { type: 'error', message: 'Only publisher clients can send automation results' });
        return;
      }

      handleAutomationResult(ws.roomId, message);
      return;
    }

    if (message.type === 'executor_result') {
      if (ws.clientType !== 'executor') {
        log('executor_result_rejected', {
          roomId: ws.roomId,
          clientId: ws.clientId,
          clientType: ws.clientType,
          reason: 'executor_only'
        });
        safeSend(ws, { type: 'error', message: 'Only executor clients can send executor results' });
        return;
      }

      handleExecutorResult(ws.roomId, message);
      return;
    }

    if (message.type === 'automation_start') {
      if (ws.clientType !== 'viewer') {
        safeSend(ws, { type: 'warning', message: 'Only viewer clients can start automation' });
        return;
      }

      const packageId = sanitizePackageId(message.packageId);
      const revision = message.revision == null ? null : Number(message.revision);
      if (!packageId || (message.revision != null && (!Number.isInteger(revision) || revision < 1))) {
        broadcastAutomationStatusSnapshot(ws.roomId, {
          sessionId: null,
          ownerViewerId: ws.clientId,
          packageId: packageId ?? null,
          revision: revision ?? null,
          status: 'error',
          message: '执行请求缺少有效的 packageId 或 revision'
        });
        return;
      }

      try {
        await startAutomationSession(ws.roomId, ws, packageId, revision);
      } catch (error) {
        broadcastAutomationStatusSnapshot(ws.roomId, {
          sessionId: null,
          ownerViewerId: ws.clientId,
          packageId,
          revision,
          status: 'error',
          message: error.message || '启动执行失败'
        });
      }
      return;
    }

    if (message.type === 'automation_stop') {
      if (ws.clientType !== 'viewer') {
        safeSend(ws, { type: 'warning', message: 'Only viewer clients can stop automation' });
        return;
      }

      const stopped = stopAutomationSession(ws.roomId, '用户停止执行');
      if (!stopped) {
        broadcastAutomationStatusSnapshot(ws.roomId, {
          sessionId: null,
          ownerViewerId: ws.clientId,
          packageId: null,
          revision: null,
          status: 'stopped',
          message: '当前没有执行中的会话'
        });
      }
      return;
    }

    if (ws.clientType === 'probe' || ws.clientType === 'executor') {
      log('probe_message_ignored', {
        roomId: ws.roomId,
        clientId: ws.clientId,
        clientType: ws.clientType,
        size: rawMessage.length ?? rawMessage.toString().length
      });
      safeSend(ws, {
        type: 'warning',
        message: ws.clientType === 'executor'
          ? 'Executor clients do not participate in signaling'
          : 'Probe clients do not participate in signaling'
      });
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

      if (automationSessions.has(ws.roomId)) {
        finalizeAutomationSession(ws.roomId, 'error', 'Publisher 已断开', {
          sendStopCommand: false
        });
      }

      for (const viewer of currentRoom.viewers.values()) {
        safeSend(viewer, {
          type: 'publisher_left',
          publisherId: ws.clientId
        });
      }
    }

    if (ws.clientType === 'viewer') {
      currentRoom.viewers.delete(ws.clientId);

      const session = automationSessions.get(ws.roomId);
      if (session && session.ownerViewerId === ws.clientId) {
        finalizeAutomationSession(ws.roomId, 'stopped', '控制端已断开', {
          sendStopCommand: true
        });
      }

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

    if (ws.clientType === 'executor' && currentRoom.executor === ws) {
      currentRoom.executor = null;
      currentRoom.executorConnectedAt = null;

      if (automationSessions.has(ws.roomId)) {
        finalizeAutomationSession(ws.roomId, 'error', 'Executor 已断开');
      }
    }

    if (!currentRoom.publisher && !currentRoom.executor && currentRoom.viewers.size === 0 && currentRoom.probes.size === 0) {
      log('room_removed', { roomId: ws.roomId });
      rooms.delete(ws.roomId);
      return;
    }

    log('client_closed', {
      clientType: ws.clientType,
      roomId: ws.roomId,
      clientId: ws.clientId,
      hasPublisher: Boolean(currentRoom.publisher),
      hasExecutor: Boolean(currentRoom.executor),
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
