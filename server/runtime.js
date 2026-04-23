const fs = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');
const { WebSocket } = require('ws');

const automationRoot = path.join(__dirname, 'data', 'automation');
const rooms = new Map();
const automationSessions = new Map();
const calibrationSessions = new Map();
const debugFrameRequests = new Map();
let nextClientId = 1;
let nextAutomationSequence = 1;

const defaultCalibration = Object.freeze({
  scaleX: 0.26233594111346115,
  scaleY: 0.260289536357444,
  offsetX: 0,
  offsetY: 0,
  kPixelsPerHidUnit: null
});
const defaultCalibrationUpdatedAt = '2026-04-22T03:34:21.344Z';

const calibrationSampleSteps = [
  { id: 'raw-red', label: '红色点', dx: 18, dy: 26, color: '#ff2d55' },
  { id: 'raw-green', label: '绿色点', dx: 26, dy: 48, color: '#34c759' },
  { id: 'raw-blue', label: '蓝色点', dx: 34, dy: 72, color: '#007aff' },
  { id: 'raw-yellow', label: '黄色点', dx: 44, dy: 96, color: '#ffcc00' },
  { id: 'raw-magenta', label: '品红点', dx: 56, dy: 120, color: '#ff2dff' },
  { id: 'raw-cyan', label: '青色点', dx: 68, dy: 144, color: '#00c7ff' },
  { id: 'raw-orange', label: '橙色点', dx: 80, dy: 168, color: '#ff9500' },
  { id: 'raw-purple', label: '紫色点', dx: 92, dy: 192, color: '#af52de' }
];

const calibrationCaptureTimeoutMs = 6_000;
const calibrationColorFrameTimeoutMs = 8_000;
const calibrationMinimumSuccessfulSamples = 3;
const calibrationEdgeMarginRatio = 0.05;
const calibrationResidualFloorPixels = 12;

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
      calibrationAppId: null,
      calibration: { ...defaultCalibration },
      calibrationUpdatedAt: defaultCalibrationUpdatedAt,
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

function getCalibrationSummary(room) {
  if (!room?.calibration) {
    return null;
  }

  return {
    scaleX: room.calibration.scaleX,
    scaleY: room.calibration.scaleY,
    offsetX: room.calibration.offsetX,
    offsetY: room.calibration.offsetY,
    kPixelsPerHidUnit: room.calibration.kPixelsPerHidUnit ?? null,
    sourceFrameSize: room.calibration.sourceFrameSize ?? null,
    executorScreenSize: room.calibration.executorScreenSize ?? null,
    sampleCount: room.calibration.sampleCount ?? null,
    updatedAt: room.calibrationUpdatedAt
  };
}

function getCalibrationApp(roomId) {
  const room = getRoom(roomId);
  if (!room.calibrationAppId) {
    return null;
  }

  return room.probes.get(room.calibrationAppId) ?? null;
}

function getDebugRequesterById(room, clientId) {
  if (!clientId) {
    return null;
  }

  return room.viewers.get(clientId) ?? room.probes.get(clientId) ?? null;
}

function rememberDebugFrameRequest(roomId, requestId, requesterClientId) {
  let roomRequests = debugFrameRequests.get(roomId);
  if (!roomRequests) {
    roomRequests = new Map();
    debugFrameRequests.set(roomId, roomRequests);
  }

  roomRequests.set(requestId, {
    requesterClientId,
    createdAt: new Date().toISOString()
  });
}

function takeDebugFrameRequest(roomId, requestId) {
  const roomRequests = debugFrameRequests.get(roomId);
  if (!roomRequests) {
    return null;
  }

  const request = roomRequests.get(requestId) ?? null;
  if (request) {
    roomRequests.delete(requestId);
    if (roomRequests.size === 0) {
      debugFrameRequests.delete(roomId);
    }
  }

  return request;
}

function clearDebugFrameRequestsForClient(roomId, clientId) {
  const roomRequests = debugFrameRequests.get(roomId);
  if (!roomRequests) {
    return;
  }

  for (const [requestId, request] of roomRequests.entries()) {
    if (request.requesterClientId === clientId) {
      roomRequests.delete(requestId);
    }
  }

  if (roomRequests.size === 0) {
    debugFrameRequests.delete(roomId);
  }
}

function failPendingDebugFrameRequests(roomId, reason) {
  const roomRequests = debugFrameRequests.get(roomId);
  if (!roomRequests || roomRequests.size === 0) {
    return;
  }

  const room = getRoom(roomId);
  for (const [requestId, request] of roomRequests.entries()) {
    const requester = getDebugRequesterById(room, request.requesterClientId);
    safeSend(requester, {
      type: 'debug_frame_result',
      requestId,
      status: 'error',
      error: reason
    });
  }

  debugFrameRequests.delete(roomId);
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
    hasPublisher: isClientOpen(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    hasExecutor: isClientOpen(room.executor),
    executorId: getExecutorId(room),
    hasCalibrationApp: isClientOpen(getCalibrationApp(roomId)),
    calibrationAppId: room.calibrationAppId,
    calibration: getCalibrationSummary(room),
    viewerCount: room.viewers.size,
    probeCount: room.probes.size,
    publisherConnectedAt: room.publisherConnectedAt,
    executorConnectedAt: room.executorConnectedAt,
    transport: 'webrtc-video-track'
  });

  log('room_state_broadcast', {
    roomId,
    hasPublisher: isClientOpen(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    hasExecutor: isClientOpen(room.executor),
    executorId: getExecutorId(room),
    hasCalibrationApp: isClientOpen(getCalibrationApp(roomId)),
    calibrationAppId: room.calibrationAppId,
    calibration: getCalibrationSummary(room),
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
  if (ws && ws.readyState === WebSocket.OPEN) {
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
  const value = normalizeMatchText(text);
  const expected = normalizeMatchText(query);
  if (!value || !expected) {
    return false;
  }

  if (mode === 'equals') {
    return value === expected;
  }

  return value.includes(expected);
}

function normalizeMatchText(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  return text
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hans-CN')
    .replace(/\s+/g, '');
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

function applyCalibrationPoint(roomId, point) {
  const normalized = normalizePoint(point);
  if (!normalized) {
    return null;
  }

  const calibration = getRoom(roomId).calibration;
  if (!calibration) {
    return normalized;
  }

  return normalizePoint({
    x: (normalized.x * calibration.scaleX) + (Number(calibration.offsetX) || 0),
    y: (normalized.y * calibration.scaleY) + (Number(calibration.offsetY) || 0)
  });
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

function getCalibrationSession(roomId, sessionId) {
  const session = calibrationSessions.get(roomId);
  if (!session) {
    return null;
  }

  if (sessionId && session.sessionId !== sessionId) {
    return null;
  }

  return session;
}

function handleDebugFrameResult(roomId, message) {
  const requestId = typeof message.requestId === 'string' ? message.requestId : '';
  if (!requestId) {
    log('debug_frame_result_rejected', {
      roomId,
      reason: 'missing_request_id'
    });
    return;
  }

  const request = takeDebugFrameRequest(roomId, requestId);
  if (!request) {
    log('debug_frame_result_ignored', {
      roomId,
      requestId,
      reason: 'request_not_found'
    });
    return;
  }

  const room = getRoom(roomId);
  const requester = getDebugRequesterById(room, request.requesterClientId);
  if (!isClientOpen(requester)) {
    log('debug_frame_result_dropped', {
      roomId,
      requestId,
      requesterClientId: request.requesterClientId,
      reason: 'requester_not_open'
    });
    return;
  }

  safeSend(requester, {
    type: 'debug_frame_result',
    requestId,
    status: message.status === 'error' ? 'error' : 'ok',
    payload: message.payload ?? null,
    error: message.error ?? null,
    sourceId: room.publisher?.clientId ?? null,
    respondedAt: new Date().toISOString()
  });
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

function clearCalibrationTimer(session) {
  if (session?.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function clearPendingCalibrationExecutor(session) {
  if (session?.pendingExecutorCommand?.timeoutHandle) {
    clearTimeout(session.pendingExecutorCommand.timeoutHandle);
  }
  if (session) {
    session.pendingExecutorCommand = null;
  }
}

function clearPendingCalibrationCapture(session) {
  if (session?.pendingCapture?.timeoutHandle) {
    clearTimeout(session.pendingCapture.timeoutHandle);
  }
  if (session) {
    session.pendingCapture = null;
  }
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

function broadcastCalibrationPayload(roomId, payload) {
  const room = getRoom(roomId);
  for (const viewer of room.viewers.values()) {
    safeSend(viewer, payload);
  }

  for (const probe of room.probes.values()) {
    safeSend(probe, payload);
  }
}

function broadcastCalibrationStatus(session, status, message, detail = null) {
  broadcastCalibrationPayload(session.roomId, {
    type: 'calibration_status',
    roomId: session.roomId,
    sessionId: session.sessionId,
    ownerClientId: session.ownerClientId,
    appClientId: session.appClientId,
    status,
    message,
    detail,
    calibration: getCalibrationSummary(getRoom(session.roomId)),
    updatedAt: new Date().toISOString()
  });
}

function sendCalibrationCommand(roomId, payload) {
  const appClient = getCalibrationApp(roomId);
  if (!isClientOpen(appClient)) {
    return false;
  }

  safeSend(appClient, payload);
  return true;
}

function finalizeCalibrationSession(roomId, status, message, options = {}) {
  const session = calibrationSessions.get(roomId);
  if (!session) {
    return;
  }

  clearCalibrationTimer(session);
  clearPendingCalibrationExecutor(session);
  clearPendingCalibrationCapture(session);
  if (session.pendingColorFrameRequest?.timeoutHandle) {
    clearTimeout(session.pendingColorFrameRequest.timeoutHandle);
  }
  session.pendingColorFrameRequest = null;
  calibrationSessions.delete(roomId);

  sendCalibrationCommand(roomId, {
    type: 'calibration_command',
    method: 'clearTapCapture',
    sessionId: session.sessionId,
    reason: message
  });

  broadcastCalibrationStatus(session, status, message, options.detail ?? null);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }

  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function getFrameDimension(size, key) {
  const value = Number(size?.[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function average(values) {
  const validValues = values.filter((value) => Number.isFinite(value));
  if (validValues.length === 0) {
    return null;
  }

  const total = validValues.reduce((sum, value) => sum + value, 0);
  return total / validValues.length;
}

function weightedAverage(entries) {
  const validEntries = entries.filter((entry) => Number.isFinite(entry?.value) && Number.isFinite(entry?.weight) && entry.weight > 0);
  if (validEntries.length === 0) {
    return null;
  }

  let totalWeight = 0;
  let weightedTotal = 0;
  for (const entry of validEntries) {
    totalWeight += entry.weight;
    weightedTotal += entry.value * entry.weight;
  }

  if (!Number.isFinite(totalWeight) || totalWeight <= 0 || !Number.isFinite(weightedTotal)) {
    return null;
  }

  return weightedTotal / totalWeight;
}

function solveCalibrationHomeModel(candidates) {
  if (!Array.isArray(candidates) || candidates.length < calibrationMinimumSuccessfulSamples) {
    return null;
  }

  const pairEstimates = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];

      const moveDeltaX = right.dx - left.dx;
      const moveDeltaY = right.dy - left.dy;
      const pixelDeltaX = right.centerPx.x - left.centerPx.x;
      const pixelDeltaY = right.centerPx.y - left.centerPx.y;

      if (Number.isFinite(moveDeltaX) && moveDeltaX !== 0 && Number.isFinite(pixelDeltaX)) {
        pairEstimates.push({
          value: pixelDeltaX / moveDeltaX,
          weight: moveDeltaX ** 2
        });
      }

      if (Number.isFinite(moveDeltaY) && moveDeltaY !== 0 && Number.isFinite(pixelDeltaY)) {
        pairEstimates.push({
          value: pixelDeltaY / moveDeltaY,
          weight: moveDeltaY ** 2
        });
      }
    }
  }

  const k = weightedAverage(pairEstimates);
  if (!Number.isFinite(k) || k <= 0) {
    return null;
  }

  const homeX = average(candidates.map((candidate) => candidate.centerPx.x - (k * candidate.dx)));
  const homeY = average(candidates.map((candidate) => candidate.centerPx.y - (k * candidate.dy)));
  if (!Number.isFinite(homeX) || !Number.isFinite(homeY)) {
    return null;
  }

  return {
    k,
    homeX,
    homeY
  };
}

function buildRoomCalibrationFromColorFrame(samples, frameResult) {
  const sourceFrameSize = frameResult.sourceFrameSize || frameResult.imageSize || {};
  const frameWidth = getFrameDimension(sourceFrameSize, 'width');
  const frameHeight = getFrameDimension(sourceFrameSize, 'height');
  if (!frameWidth || !frameHeight) {
    throw makeStatusError('截图尺寸缺失，无法计算 HID move k', 500);
  }

  const detections = Array.isArray(frameResult.detections) ? frameResult.detections : [];
  const detectionByStepId = new Map(detections.map((detection) => [detection.stepId, detection]));
  const marginX = frameWidth * calibrationEdgeMarginRatio;
  const marginY = frameHeight * calibrationEdgeMarginRatio;
  const candidates = [];

  for (const sample of samples) {
    const detection = detectionByStepId.get(sample.stepId);
    const centerX = Number(detection?.centerPx?.x);
    const centerY = Number(detection?.centerPx?.y);
    const dx = Number(sample.dx);
    const dy = Number(sample.dy);
    const denominator = dx ** 2 + dy ** 2;
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(denominator) || denominator <= 0) {
      continue;
    }

    const nearEdge = centerX < marginX ||
      centerX > frameWidth - marginX ||
      centerY < marginY ||
      centerY > frameHeight - marginY;
    if (nearEdge) {
      continue;
    }

    candidates.push({
      ...sample,
      detection,
      centerPx: { x: centerX, y: centerY }
    });
  }

  if (candidates.length < calibrationMinimumSuccessfulSamples) {
    throw makeStatusError('截图中可用彩色点太少，无法计算 HID move k', 500);
  }

  const initialModel = solveCalibrationHomeModel(candidates);
  if (!initialModel) {
    throw makeStatusError('HID move k 计算结果无效', 500);
  }

  const residuals = candidates.map((candidate) => {
    const predictedX = initialModel.homeX + (initialModel.k * candidate.dx);
    const predictedY = initialModel.homeY + (initialModel.k * candidate.dy);
    return Math.sqrt((candidate.centerPx.x - predictedX) ** 2 + (candidate.centerPx.y - predictedY) ** 2);
  });
  const residualMedian = median(residuals) ?? 0;
  const residualThreshold = Math.max(calibrationResidualFloorPixels, residualMedian * 2.5);
  const inliers = candidates.filter((_candidate, index) => residuals[index] <= residualThreshold);
  const finalCandidates = inliers.length >= calibrationMinimumSuccessfulSamples ? inliers : candidates;
  const finalModel = solveCalibrationHomeModel(finalCandidates);
  const kPixelsPerHidUnit = finalModel?.k;
  if (!Number.isFinite(kPixelsPerHidUnit) || kPixelsPerHidUnit <= 0 || !finalModel) {
    throw makeStatusError('HID move k 计算结果无效', 500);
  }

  const executorPayload = samples.find((sample) => sample.executorPayload)?.executorPayload || {};
  const executorScreenWidth = Number(executorPayload.screenWidth);
  const executorScreenHeight = Number(executorPayload.screenHeight);
  if (!Number.isFinite(executorScreenWidth) || executorScreenWidth <= 0 ||
      !Number.isFinite(executorScreenHeight) || executorScreenHeight <= 0) {
    throw makeStatusError('Executor 未返回 screenWidth/screenHeight，无法派生自动化 scale', 500);
  }

  const scaleX = frameWidth / (kPixelsPerHidUnit * executorScreenWidth);
  const scaleY = frameHeight / (kPixelsPerHidUnit * executorScreenHeight);
  const offsetX = -finalModel.homeX / (kPixelsPerHidUnit * executorScreenWidth);
  const offsetY = -finalModel.homeY / (kPixelsPerHidUnit * executorScreenHeight);

  return {
    scaleX,
    offsetX,
    scaleY,
    offsetY,
    kPixelsPerHidUnit,
    sourceFrameSize: { width: frameWidth, height: frameHeight },
    imageSize: frameResult.imageSize || null,
    executorScreenSize: { width: executorScreenWidth, height: executorScreenHeight },
    sampleCount: finalCandidates.length
  };
}

function scheduleCalibrationStep(session, delayMs = 600) {
  clearCalibrationTimer(session);
  session.timer = setTimeout(() => {
    const activeSession = getCalibrationSession(session.roomId, session.sessionId);
    if (activeSession) {
      executeCalibrationStep(activeSession);
    }
  }, delayMs);
}

function trySolveCalibrationSamples(session) {
  if (session.currentStepIndex < calibrationSampleSteps.length) {
    return false;
  }

  if (session.samples.length < calibrationMinimumSuccessfulSamples) {
    finalizeCalibrationSession(session.roomId, 'error', '成功采集的标定点太少，无法得出稳定结果', {
      detail: {
        sampleCount: session.samples.length,
        skippedSamples: session.skippedSamples
      }
    });
    return true;
  }

  session.phase = 'analyze';
  requestCalibrationColorFrame(session);
  return true;
}

function requestCalibrationColorFrame(session) {
  clearCalibrationTimer(session);
  const requestId = makeAutomationId('calibration-color-frame');
  const expectedColors = session.samples.map((sample) => ({
    stepId: sample.stepId,
    label: sample.label,
    color: sample.color,
    dx: sample.dx,
    dy: sample.dy
  }));

  const timeoutHandle = setTimeout(() => {
    const activeSession = getCalibrationSession(session.roomId, session.sessionId);
    if (!activeSession || activeSession.pendingColorFrameRequest?.requestId !== requestId) {
      return;
    }

    finalizeCalibrationSession(session.roomId, 'error', '等待 Broadcast 彩色点截图分析超时', {
      detail: {
        samples: activeSession.samples,
        skippedSamples: activeSession.skippedSamples
      }
    });
  }, calibrationColorFrameTimeoutMs);

  session.pendingColorFrameRequest = {
    requestId,
    timeoutHandle
  };

  const forwarded = sendToPublisher(session.roomId, {
    type: 'calibration_color_frame_request',
    roomId: session.roomId,
    sessionId: session.sessionId,
    requestId,
    expectedColors,
    edgeMarginRatio: calibrationEdgeMarginRatio
  });

  if (!forwarded) {
    finalizeCalibrationSession(session.roomId, 'error', 'Publisher 未连接，无法分析标定截图', {
      detail: {
        samples: session.samples,
        skippedSamples: session.skippedSamples
      }
    });
    return;
  }

  broadcastCalibrationStatus(session, 'analyzing', '已完成彩色点击，正在请求 Broadcast 截图识别落点', {
    requestId,
    expectedColors,
    sampleCount: session.samples.length
  });
}

function handleCalibrationColorFrameResult(roomId, message) {
  const session = getCalibrationSession(roomId, message.sessionId);
  if (!session) {
    log('calibration_color_frame_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      reason: 'session_not_found'
    });
    return false;
  }

  const pendingRequest = session.pendingColorFrameRequest;
  if (!pendingRequest || pendingRequest.requestId !== message.requestId) {
    log('calibration_color_frame_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      reason: 'request_mismatch'
    });
    return false;
  }

  if (pendingRequest.timeoutHandle) {
    clearTimeout(pendingRequest.timeoutHandle);
  }
  session.pendingColorFrameRequest = null;

  if (message.status === 'error') {
    finalizeCalibrationSession(session.roomId, 'error', message.error || 'Broadcast 彩色点截图分析失败', {
      detail: {
        samples: session.samples,
        skippedSamples: session.skippedSamples
      }
    });
    return true;
  }

  try {
    const frameResult = message.payload || {};
    const calibration = buildRoomCalibrationFromColorFrame(session.samples, frameResult);
    session.calibration = calibration;
    const room = getRoom(session.roomId);
    room.calibration = calibration;
    room.calibrationUpdatedAt = new Date().toISOString();
    broadcastRoomState(session.roomId);
    finalizeCalibrationSession(session.roomId, 'completed', '标定完成，已按截图彩色点计算 HID move k', {
      detail: {
        calibration,
        frame: {
          imageSize: frameResult.imageSize || null,
          sourceFrameSize: frameResult.sourceFrameSize || null,
          detections: frameResult.detections || []
        },
        samples: session.samples,
        skippedSamples: session.skippedSamples
      }
    });
  } catch (error) {
    finalizeCalibrationSession(session.roomId, 'error', error.message || '计算 HID move k 失败', {
      detail: {
        samples: session.samples,
        skippedSamples: session.skippedSamples,
        frame: message.payload || null
      }
    });
  }

  return true;
}

function handleCalibrationCaptureTimeout(session) {
  const pendingCapture = session.pendingCapture;
  if (!pendingCapture) {
    return;
  }

  clearPendingCalibrationCapture(session);
  sendCalibrationCommand(session.roomId, {
    type: 'calibration_command',
    method: 'clearTapCapture',
    sessionId: session.sessionId,
    reason: `等待 ${pendingCapture.label} 点击超时`
  });

  const step = getCurrentCalibrationStep(session);
  if (!step || step.id !== pendingCapture.stepId) {
    finalizeCalibrationSession(session.roomId, 'error', '标定步骤在超时重试时已失配');
    return;
  }

  session.skippedSamples.push({
    stepId: step.id,
    label: step.label,
    phase: session.phase,
    dx: pendingCapture.dx,
    dy: pendingCapture.dy,
    color: pendingCapture.color,
    reason: 'tap_timeout'
  });
  broadcastCalibrationStatus(session, 'skipped', `App 未回传彩色落点，跳过 ${step.label}`, {
    stepId: step.id,
    label: step.label,
    phase: session.phase,
    dx: pendingCapture.dx,
    dy: pendingCapture.dy,
    color: pendingCapture.color,
    skippedCount: session.skippedSamples.length,
    sampleCount: session.samples.length
  });

  session.currentAttemptIndex = 0;
  session.currentStepIndex += 1;
  if (trySolveCalibrationSamples(session)) {
    return;
  }

  scheduleCalibrationStep(session, 420);
}

function getCurrentCalibrationStep(session) {
  return calibrationSampleSteps[session.currentStepIndex] ?? null;
}

function dispatchCalibrationTap(session, step) {
  const requestId = makeAutomationId('calibration-request');
  const command = {
    type: 'executor_command',
    roomId: session.roomId,
    sessionId: session.sessionId,
    requestId,
    action: 'calibrationRawTap',
    stepId: step.id,
    payload: {
      dx: step.dx,
      dy: step.dy,
      color: step.color,
      stepId: step.id
    }
  };

  if (!sendToExecutor(session.roomId, command)) {
    finalizeCalibrationSession(session.roomId, 'error', 'Executor 当前不可用');
    return;
  }

  const timeoutHandle = setTimeout(() => {
    const activeSession = getCalibrationSession(session.roomId, session.sessionId);
    if (!activeSession || activeSession.pendingExecutorCommand?.requestId !== requestId) {
      return;
    }

    finalizeCalibrationSession(session.roomId, 'error', `标定点击 ${step.label} 超时`);
  }, 15_000);

  session.pendingExecutorCommand = {
    requestId,
    action: 'calibrationRawTap',
    stepId: step.id,
    timeoutHandle,
    phase: session.phase,
    label: step.label,
    dx: step.dx,
    dy: step.dy,
    color: step.color
  };

  broadcastCalibrationStatus(session, 'dispatching', `已发送 raw HID 彩色点击: ${step.label}`, {
    stepId: step.id,
    label: step.label,
    phase: session.phase,
    dx: step.dx,
    dy: step.dy,
    color: step.color,
    sampleIndex: session.currentStepIndex + 1,
    sampleCount: calibrationSampleSteps.length
  });
}

function executeCalibrationStep(session) {
  if (session.pendingExecutorCommand || session.pendingCapture) {
    return;
  }

  const room = getRoom(session.roomId);
  if (!isClientOpen(room.executor)) {
    finalizeCalibrationSession(session.roomId, 'error', 'Executor 已断开');
    return;
  }

  if (!isClientOpen(getCalibrationApp(session.roomId)) || room.calibrationAppId !== session.appClientId) {
    finalizeCalibrationSession(session.roomId, 'error', '标定 App 已断开');
    return;
  }

  const step = getCurrentCalibrationStep(session);
  if (!step) {
    finalizeCalibrationSession(session.roomId, 'error', '没有可执行的标定步骤');
    return;
  }

  if (!sendCalibrationCommand(session.roomId, {
    type: 'calibration_command',
    method: 'armTapCapture',
    sessionId: session.sessionId,
    stepId: step.id,
    label: step.label,
    phase: session.phase,
    target: { x: 0, y: 0 },
    dx: step.dx,
    dy: step.dy,
    color: step.color,
    sampleIndex: session.currentStepIndex + 1,
    sampleCount: calibrationSampleSteps.length
  })) {
    finalizeCalibrationSession(session.roomId, 'error', '标定 App 当前不可用');
    return;
  }

  broadcastCalibrationStatus(session, 'arming', `准备绘制彩色落点 ${step.label}`, {
    stepId: step.id,
    label: step.label,
    phase: session.phase,
    dx: step.dx,
    dy: step.dy,
    color: step.color,
    sampleIndex: session.currentStepIndex + 1,
    sampleCount: calibrationSampleSteps.length,
    note: '从 home 出发执行 raw HID move，App 只负责按实际落点绘制彩色圆点'
  });

  clearCalibrationTimer(session);
  session.timer = setTimeout(() => {
    const activeSession = getCalibrationSession(session.roomId, session.sessionId);
    if (activeSession) {
      dispatchCalibrationTap(activeSession, step);
    }
  }, 220);
}

function startCalibrationSession(roomId, owner) {
  const room = getRoom(roomId);
  if (automationSessions.has(roomId)) {
    throw makeStatusError('当前房间正在执行自动化，请先停止后再标定', 409);
  }
  if (!isClientOpen(room.executor)) {
    throw makeStatusError('当前房间没有可用的 executor', 409);
  }
  if (!isClientOpen(getCalibrationApp(roomId))) {
    throw makeStatusError('当前房间没有连接中的标定 App', 409);
  }

  if (calibrationSessions.has(roomId)) {
    finalizeCalibrationSession(roomId, 'stopped', '被新的标定请求替换');
  }

  const session = {
    sessionId: makeAutomationId('calibration-session'),
    roomId,
    ownerClientId: owner.clientId,
    appClientId: room.calibrationAppId,
    phase: 'sample',
    currentStepIndex: 0,
    currentAttemptIndex: 0,
    samples: [],
    skippedSamples: [],
    calibration: room.calibration ? { ...room.calibration } : null,
    pendingExecutorCommand: null,
    pendingCapture: null,
    pendingColorFrameRequest: null,
    timer: null,
    createdAt: new Date().toISOString()
  };

  calibrationSessions.set(roomId, session);
  broadcastCalibrationStatus(session, 'starting', '开始截图彩色点 HID move k 标定', {
    sampleCount: calibrationSampleSteps.length,
    sampleSteps: calibrationSampleSteps,
    existingCalibration: getCalibrationSummary(room),
    note: '本轮从 home 出发按 raw HID move 点击不同颜色点，再由 Broadcast 截图识别落点计算单一 k'
  });
  broadcastCalibrationStatus(session, 'prepared', '已准备彩色落点板，开始采样', {
    sampleCount: calibrationSampleSteps.length
  });
  scheduleCalibrationStep(session, 250);
  return session;
}

function handleCalibrationExecutorResult(roomId, message) {
  const session = getCalibrationSession(roomId, message.sessionId);
  if (!session) {
    log('calibration_executor_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      action: message.action,
      reason: 'session_not_found'
    });
    return false;
  }

  const pendingCommand = session.pendingExecutorCommand;
  if (!pendingCommand || pendingCommand.requestId !== message.requestId || pendingCommand.action !== message.action) {
    log('calibration_executor_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      requestId: message.requestId,
      action: message.action,
      reason: 'request_mismatch'
    });
    return false;
  }

  clearPendingCalibrationExecutor(session);
  if (message.status !== 'ok') {
    finalizeCalibrationSession(session.roomId, 'error', message.error || `标定动作 ${message.action} 执行失败`);
    return true;
  }

  const captureTimeout = setTimeout(() => {
    const activeSession = getCalibrationSession(session.roomId, session.sessionId);
    if (!activeSession || activeSession.pendingCapture?.stepId !== pendingCommand.stepId) {
      return;
    }

    handleCalibrationCaptureTimeout(activeSession);
  }, calibrationCaptureTimeoutMs);

  session.pendingCapture = {
    stepId: pendingCommand.stepId,
    label: pendingCommand.label,
    phase: pendingCommand.phase,
    dx: pendingCommand.dx,
    dy: pendingCommand.dy,
    color: pendingCommand.color,
    executorPayload: message.payload || null,
    timeoutHandle: captureTimeout
  };

  broadcastCalibrationStatus(session, 'awaiting_tap', `等待 App 绘制彩色实际落点: ${pendingCommand.label}`, {
    stepId: pendingCommand.stepId,
    label: pendingCommand.label,
    phase: pendingCommand.phase,
    dx: pendingCommand.dx,
    dy: pendingCommand.dy,
    color: pendingCommand.color,
    executorPayload: message.payload || null
  });
  return true;
}

function handleCalibrationResult(roomId, source, message) {
  const session = getCalibrationSession(roomId, message.sessionId);
  if (!session) {
    log('calibration_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      stepId: message.stepId,
      reason: 'session_not_found'
    });
    return;
  }

  if (source.clientId !== session.appClientId) {
    safeSend(source, { type: 'error', message: 'Only the registered calibration app can report calibration taps' });
    return;
  }

  const pendingCapture = session.pendingCapture;
  if (!pendingCapture || pendingCapture.stepId !== message.stepId) {
    log('calibration_result_ignored', {
      roomId,
      sessionId: message.sessionId,
      stepId: message.stepId,
      reason: 'capture_not_armed'
    });
    return;
  }

  const actualPoint = normalizePoint(message.point);
  if (!actualPoint) {
    safeSend(source, { type: 'error', message: 'Calibration point is missing or invalid' });
    return;
  }

  clearPendingCalibrationCapture(session);
  const step = getCurrentCalibrationStep(session);
  if (!step || step.id !== message.stepId) {
    finalizeCalibrationSession(session.roomId, 'error', '标定步骤与回传点击不一致');
    return;
  }

  if (session.phase === 'sample') {
    session.samples.push({
      stepId: step.id,
      label: step.label,
      dx: pendingCapture.dx,
      dy: pendingCapture.dy,
      color: pendingCapture.color,
      executorPayload: pendingCapture.executorPayload
    });

    broadcastCalibrationStatus(session, 'captured', `已绘制 ${step.label}`, {
      stepId: step.id,
      label: step.label,
      dx: pendingCapture.dx,
      dy: pendingCapture.dy,
      color: pendingCapture.color,
      executorPayload: pendingCapture.executorPayload,
      sampleIndex: session.currentStepIndex + 1,
      sampleCount: calibrationSampleSteps.length
    });

    session.currentAttemptIndex = 0;
    session.currentStepIndex += 1;
    if (trySolveCalibrationSamples(session)) {
      return;
    }

    scheduleCalibrationStep(session, 600);
    return;
  }
}

function registerCalibrationApp(roomId, client) {
  const room = getRoom(roomId);
  if (room.calibrationAppId && room.calibrationAppId !== client.clientId) {
    const previousApp = room.probes.get(room.calibrationAppId);
    safeSend(previousApp, {
      type: 'warning',
      message: 'Calibration app replaced by a new connection'
    });
  }

  room.calibrationAppId = client.clientId;
  safeSend(client, {
    type: 'calibration_registered',
    role: 'app',
    clientId: client.clientId,
    roomId,
    calibration: getCalibrationSummary(room)
  });
  broadcastRoomState(roomId);
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
  const bestImageMatch = extra?.detail?.payload?.bestImageMatch || extra?.detail?.bestImageMatch || null;
  const bestImageScore = Number(bestImageMatch?.score);
  const bestImageScaleMultiplier = Number(bestImageMatch?.scaleMultiplier);
  broadcastAutomationPayload(session.roomId, payload);
  log('automation_status', {
    roomId: session.roomId,
    sessionId: session.sessionId,
    status,
    message,
    stepId: extra.stepId ?? null,
    currentStepIndex: session.currentStepIndex,
    stepCount: session.document.steps.length,
    bestImageScore: Number.isFinite(bestImageScore) ? bestImageScore : undefined,
    bestImageScaleMultiplier: Number.isFinite(bestImageScaleMultiplier) ? bestImageScaleMultiplier : undefined
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
  const scaleMultiplier = Number(match.scaleMultiplier);
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

  return {
    point,
    score,
    scaleMultiplier: Number.isFinite(scaleMultiplier) ? scaleMultiplier : null
  };
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
  const threshold = step.type === 'waitForImage'
    ? Number(step.threshold ?? 0.84)
    : undefined;
  if (elapsedMs >= timeoutMs) {
    finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 等待超时`, {
      stepId: step.id,
      detail: {
        attempts: waitState.attempts,
        elapsedMs,
        timeoutMs,
        threshold,
        payload
      }
    });
    return;
  }

  broadcastAutomationStatus(session, 'polling', `步骤 ${step.id} 未命中，继续检查`, {
    stepId: step.id,
    detail: {
      attempts: waitState.attempts,
      elapsedMs,
      threshold,
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
    const rawPoint = resolveAutomationTarget(session, step.target);
    if (!rawPoint) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的点击目标不存在`, {
        stepId: step.id
      });
      return;
    }

    const point = applyCalibrationPoint(session.roomId, rawPoint);
    if (!point) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的点击目标校正失败`, {
        stepId: step.id
      });
      return;
    }

    const requestId = dispatchExecutorCommand(session, 'tap', { point }, {
      stepId: step.id,
      timeoutMs: 15_000,
      nextDelayMs: Number(step.postActionDelayMs) || 350
    });
    broadcastAutomationAction(session, step, 'tap', { point, rawPoint, requestId });
    return;
  }

  if (step.type === 'drag') {
    const rawFrom = resolveAutomationTarget(session, step.from);
    const rawTo = resolveAutomationTarget(session, step.to);
    if (!rawFrom || !rawTo) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的拖拽目标不存在`, {
        stepId: step.id
      });
      return;
    }

    const from = applyCalibrationPoint(session.roomId, rawFrom);
    const to = applyCalibrationPoint(session.roomId, rawTo);
    if (!from || !to) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的拖拽目标校正失败`, {
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
      rawFrom,
      rawTo,
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
    timeoutMs: Math.max(15_000, timeoutMs + 2_000)
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
  if (handleCalibrationExecutorResult(roomId, message)) {
    return;
  }

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

module.exports = {
  rooms,
  automationSessions,
  calibrationSessions,
  debugFrameRequests,
  log,
  makeStatusError,
  summarizeSignal,
  getRoom,
  makeClientId,
  getViewerIds,
  getProbeIds,
  getExecutorId,
  getCalibrationSummary,
  getCalibrationApp,
  getDebugRequesterById,
  rememberDebugFrameRequest,
  takeDebugFrameRequest,
  clearDebugFrameRequestsForClient,
  failPendingDebugFrameRequests,
  getClientById,
  broadcastRoomState,
  safeSend,
  isClientOpen,
  sendToPublisher,
  sendToExecutor,
  makeAutomationId,
  normalizePoint,
  regionContainsPoint,
  matchesText,
  normalizeMatchText,
  resolveAutomationTarget,
  applyCalibrationPoint,
  collectImageAssetIds,
  getAutomationSession,
  getCalibrationSession,
  handleDebugFrameResult,
  broadcastAutomationPayload,
  broadcastCalibrationPayload,
  broadcastCalibrationStatus,
  sendCalibrationCommand,
  finalizeCalibrationSession,
  handleCalibrationColorFrameResult,
  startCalibrationSession,
  handleCalibrationExecutorResult,
  handleCalibrationResult,
  registerCalibrationApp,
  broadcastAutomationStatusSnapshot,
  sanitizePackageId,
  sanitizeAssetId,
  packageDirectory,
  revisionDirectory,
  metadataPath,
  readJSON,
  writeJSON,
  listPackageIds,
  readPackageMetadata,
  saveAutomationPackage,
  startAutomationSession,
  stopAutomationSession,
  finalizeAutomationSession,
  handleAutomationResult,
  handleExecutorResult,
  broadcastAutomationEvent
};
