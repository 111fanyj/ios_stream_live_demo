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
const calibrationSessions = new Map();
const debugFrameRequests = new Map();
let nextClientId = 1;
let nextAutomationSequence = 1;

const defaultCalibration = Object.freeze({
  scaleX: 0.3199989808997008,
  scaleY: 0.22284761183944202,
  offsetX: -0.011906938824174913,
  offsetY: 0.016607512881589015
});
const defaultCalibrationUpdatedAt = '2026-04-22T04:56:54.644Z';

const homeSettleReferenceTarget = Object.freeze({ x: 0.12, y: 0.12 });

const calibrationBaseAnchors = [
  { id: 'sample-top-left', label: '左上锚点', target: { x: 0.18, y: 0.18 } },
  { id: 'sample-top-right', label: '右上锚点', target: { x: 0.62, y: 0.28 } },
];

const calibrationSampleSteps = calibrationBaseAnchors.map((anchor) => ({
  id: anchor.id,
  label: anchor.label,
  anchorLabel: anchor.label,
  target: anchor.target,
  displayTarget: anchor.target
}));

const calibrationHomeStep = {
  id: 'sample-home-reference',
  label: 'Home 右下固定参考点',
  anchorLabel: 'Home 右下固定参考点',
  target: homeSettleReferenceTarget,
  displayTarget: homeSettleReferenceTarget
};

const calibrationVerifyStep = {
  id: 'verify-mid-left',
  label: '验证点',
  target: { x: 0.28, y: 0.62 }
};

const calibrationVerificationThreshold = 0.035;
const calibrationCaptureTimeoutMs = 6_000;
const calibrationRetryBackoffFactor = 0.8;
const calibrationMaxTapAttempts = 5;
const calibrationMinimumSuccessfulSamples = 2;
const calibrationConsensusResidualFloor = 0.012;
const calibrationPairRatioTolerance = 0.12;

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
    hasPublisher: Boolean(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    hasExecutor: Boolean(room.executor),
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
    hasPublisher: Boolean(room.publisher),
    publisherId: room.publisher?.clientId ?? null,
    hasExecutor: Boolean(room.executor),
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

function applyCalibrationToPoint(point, calibration) {
  const normalized = normalizePoint(point);
  if (!normalized) {
    return null;
  }

  if (!calibration) {
    return normalized;
  }

  return normalizePoint({
    x: normalized.x * calibration.scaleX + calibration.offsetX,
    y: normalized.y * calibration.scaleY + calibration.offsetY
  });
}

function applyCalibrationPoint(roomId, point) {
  return applyCalibrationToPoint(point, getRoom(roomId).calibration);
}

function buildExecutorHomeSettlePoint(roomId, calibration = null) {
  return applyCalibrationToPoint(homeSettleReferenceTarget, calibration ?? getRoom(roomId).calibration)
    ?? normalizePoint(homeSettleReferenceTarget);
}

function buildExecutorTapPayload(roomId, point, calibration = null) {
  const normalizedPoint = normalizePoint(point);
  if (!normalizedPoint) {
    return null;
  }

  return {
    point: normalizedPoint,
    homeSettlePoint: buildExecutorHomeSettlePoint(roomId, calibration)
  };
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
  calibrationSessions.delete(roomId);

  sendCalibrationCommand(roomId, {
    type: 'calibration_command',
    method: 'clearTapCapture',
    sessionId: session.sessionId,
    reason: message
  });

  broadcastCalibrationStatus(session, status, message, options.detail ?? null);
}

function computeAxisCorrection(samples, axis, options = {}) {
  const pairs = samples
    .map((sample) => ({ input: Number(sample.target?.[axis]), actual: Number(sample.actual?.[axis]) }))
    .filter((pair) => Number.isFinite(pair.input) && Number.isFinite(pair.actual));

  if (pairs.length < 2) {
    throw makeStatusError(`标定样本不足，无法计算 ${axis} 轴`, 500);
  }

  const median = (values) => {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    if (sorted.length === 0) {
      return null;
    }

    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
  };

  const observedOrigin = Number(options.originActual);
  const hasObservedOrigin = Number.isFinite(observedOrigin);
  const inputOrigin = Number(options.originInput);
  const hasInputOrigin = Number.isFinite(inputOrigin);
  const effectiveInputOrigin = hasInputOrigin ? inputOrigin : 0;

  const fitLeastSquaresThroughOrigin = (inputPairs) => {
    let denominator = 0;
    let numerator = 0;
    for (const pair of inputPairs) {
      const centeredInput = pair.input - effectiveInputOrigin;
      denominator += centeredInput ** 2;
      numerator += centeredInput * (pair.actual - (hasObservedOrigin ? observedOrigin : 0));
    }

    if (!Number.isFinite(denominator) || denominator <= 0) {
      throw makeStatusError(`标定样本退化，无法计算 ${axis} 轴`, 500);
    }

    return {
      observedScale: numerator / denominator,
      observedOffset: hasObservedOrigin ? observedOrigin : 0
    };
  };

  let observedScale = median(pairs
    .filter((pair) => Math.abs(pair.input - effectiveInputOrigin) >= 0.0001)
    .map((pair) => (pair.actual - (hasObservedOrigin ? observedOrigin : 0)) / (pair.input - effectiveInputOrigin)));
  let observedOffset = hasObservedOrigin ? observedOrigin : 0;

  if (!Number.isFinite(observedScale) || Math.abs(observedScale) < 0.001) {
    const leastSquares = fitLeastSquaresThroughOrigin(pairs);
    observedScale = leastSquares.observedScale;
    observedOffset = leastSquares.observedOffset;
  }

  const residuals = pairs.map((pair) => Math.abs(pair.actual - (observedOffset + observedScale * pair.input)));
  const residualMedian = median(residuals) ?? 0;
  const residualThreshold = Math.max(calibrationConsensusResidualFloor, residualMedian * 2.5);
  const inlierPairs = pairs.filter((pair, index) => residuals[index] <= residualThreshold);
  const finalPairs = inlierPairs.length >= 3 ? inlierPairs : pairs;
  const leastSquares = fitLeastSquaresThroughOrigin(finalPairs);
  observedScale = leastSquares.observedScale;
  observedOffset = leastSquares.observedOffset;

  if (!Number.isFinite(observedScale) || Math.abs(observedScale) < 0.001) {
    throw makeStatusError(`标定结果异常，${axis} 轴 scale 无效`, 500);
  }

  return {
    observedScale,
    observedOffset,
    correctionScale: 1 / observedScale,
    correctionOffset: effectiveInputOrigin - (observedOffset / observedScale),
    inlierCount: finalPairs.length,
    totalCount: pairs.length,
    residualMedian,
    residualThreshold
  };
}

function buildRoomCalibration(samples) {
  const homeSample = samples.find((sample) => sample.stepId === calibrationHomeStep.id) ?? null;
  const modeledSamples = samples.filter((sample) => sample.stepId !== calibrationHomeStep.id);
  const xAxis = computeAxisCorrection(modeledSamples, 'x', {
    originActual: homeSample?.actual?.x,
    originInput: homeSample?.target?.x
  });
  const yAxis = computeAxisCorrection(modeledSamples, 'y', {
    originActual: homeSample?.actual?.y,
    originInput: homeSample?.target?.y
  });
  return {
    scaleX: xAxis.correctionScale,
    offsetX: xAxis.correctionOffset,
    scaleY: yAxis.correctionScale,
    offsetY: yAxis.correctionOffset,
    observedScaleX: xAxis.observedScale,
    observedOffsetX: xAxis.observedOffset,
    observedScaleY: yAxis.observedScale,
    observedOffsetY: yAxis.observedOffset,
    sampleCount: samples.length,
    consensus: {
      xInliers: xAxis.inlierCount,
      xTotal: xAxis.totalCount,
      yInliers: yAxis.inlierCount,
      yTotal: yAxis.totalCount,
      xResidualMedian: xAxis.residualMedian,
      yResidualMedian: yAxis.residualMedian,
      xResidualThreshold: xAxis.residualThreshold,
      yResidualThreshold: yAxis.residualThreshold,
      homeInput: homeSample?.target ?? null,
      homeActual: homeSample?.actual ?? null
    }
  };
}

function computePointError(target, actual) {
  const normalizedTarget = normalizePoint(target);
  const normalizedActual = normalizePoint(actual);
  if (!normalizedTarget || !normalizedActual) {
    return null;
  }

  const deltaX = normalizedActual.x - normalizedTarget.x;
  const deltaY = normalizedActual.y - normalizedTarget.y;
  return {
    deltaX,
    deltaY,
    distance: Math.sqrt(deltaX ** 2 + deltaY ** 2)
  };
}

function formatCalibrationMultiplier(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function getCalibrationStage(session, step) {
  if (session.phase === 'home') {
    return {
      captureMode: 'home',
      attemptIndex: Math.max(0, Number(session.currentAttemptIndex ?? 0)),
      retreatFactor: 1,
      label: session.currentAttemptIndex > 0 ? `${step.label} · 重试 ${session.currentAttemptIndex}` : step.label,
      target: normalizePoint(step.target),
      displayTarget: normalizePoint(step.displayTarget ?? step.target)
    };
  }

  if (session.phase === 'verify') {
    return {
      captureMode: 'verify',
      attemptIndex: 0,
      retreatFactor: 1,
      label: step.label,
      target: normalizePoint(step.target),
      displayTarget: normalizePoint(step.displayTarget ?? step.target)
    };
  }

  const baseCommandTarget = applyCalibrationPoint(session.roomId, step.target) ?? normalizePoint(step.target);
  if (!baseCommandTarget) {
    return null;
  }

  const pairState = session.sampleState?.stepId === step.id ? session.sampleState : null;
  const captureMode = pairState ? 'half' : 'primary';
  const attemptIndex = pairState
    ? pairState.baseAttemptIndex + 1
    : Math.max(0, Number(session.currentAttemptIndex ?? 0));
  const retreatFactor = calibrationRetryBackoffFactor ** attemptIndex;

  return {
    captureMode,
    attemptIndex,
    retreatFactor,
    label: captureMode === 'half'
      ? `${step.label} · 4/5 复测`
      : (attemptIndex > 0 ? `${step.label} · 缩小到 ${formatCalibrationMultiplier(retreatFactor)} 倍` : `${step.label} · 初测`),
    target: normalizePoint({
      x: baseCommandTarget.x * retreatFactor,
      y: baseCommandTarget.y * retreatFactor
    }),
    displayTarget: normalizePoint(step.displayTarget ?? step.target)
  };
}

function evaluateCalibrationPair(baseSample, nextSample) {
  const expectedRatioX = baseSample.commandTarget.x > 0.0001 ? nextSample.commandTarget.x / baseSample.commandTarget.x : null;
  const expectedRatioY = baseSample.commandTarget.y > 0.0001 ? nextSample.commandTarget.y / baseSample.commandTarget.y : null;
  const actualRatioX = baseSample.actual.x > 0.0001 ? nextSample.actual.x / baseSample.actual.x : null;
  const actualRatioY = baseSample.actual.y > 0.0001 ? nextSample.actual.y / baseSample.actual.y : null;

  const xDelta = Number.isFinite(actualRatioX) && Number.isFinite(expectedRatioX)
    ? Math.abs(actualRatioX - expectedRatioX)
    : Number.POSITIVE_INFINITY;
  const yDelta = Number.isFinite(actualRatioY) && Number.isFinite(expectedRatioY)
    ? Math.abs(actualRatioY - expectedRatioY)
    : Number.POSITIVE_INFINITY;

  return {
    expectedRatioX,
    expectedRatioY,
    actualRatioX,
    actualRatioY,
    xDelta,
    yDelta,
    isValid: xDelta <= calibrationPairRatioTolerance && yDelta <= calibrationPairRatioTolerance
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

  const modeledSampleCount = session.samples.filter((sample) => sample.stepId !== calibrationHomeStep.id).length;
  if (modeledSampleCount < calibrationMinimumSuccessfulSamples) {
    finalizeCalibrationSession(session.roomId, 'error', '成功采集的标定点太少，无法得出稳定结果', {
      detail: {
        sampleCount: session.samples.length,
        skippedSamples: session.skippedSamples
      }
    });
    return true;
  }

  try {
    const calibration = buildRoomCalibration(session.samples);
    session.calibration = calibration;
    const room = getRoom(session.roomId);
    room.calibration = calibration;
    room.calibrationUpdatedAt = new Date().toISOString();
    session.phase = 'verify';
    session.currentAttemptIndex = 0;
    session.currentStepIndex = calibrationSampleSteps.length;
    broadcastRoomState(session.roomId);
    broadcastCalibrationStatus(session, 'solved', '已按多数一致样本求出坐标校正参数，开始验证', {
      calibration,
      samples: session.samples,
      skippedSamples: session.skippedSamples,
      verifyTarget: calibrationVerifyStep.target
    });
  } catch (error) {
    finalizeCalibrationSession(session.roomId, 'error', error.message || '计算标定参数失败', {
      detail: {
        samples: session.samples,
        skippedSamples: session.skippedSamples
      }
    });
    return true;
  }

  scheduleCalibrationStep(session, 700);
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

  if (session.phase === 'home' && pendingCapture.attemptIndex + 1 >= calibrationMaxTapAttempts) {
    finalizeCalibrationSession(session.roomId, 'error', 'Home 右下固定参考点连续重试后仍未收到点击回传');
    return;
  }

  if (pendingCapture.captureMode !== 'verify' && pendingCapture.attemptIndex + 1 < calibrationMaxTapAttempts) {
    session.sampleState = null;
    session.currentAttemptIndex = pendingCapture.attemptIndex + 1;
    const nextAttempt = getCalibrationStage(session, step);
    log('calibration_timeout_retry', {
      roomId: session.roomId,
      sessionId: session.sessionId,
      stepId: step.id,
      label: step.label,
      captureMode: pendingCapture.captureMode,
      previousCommandTarget: pendingCapture.commandTarget,
      previousHomeSettlePoint: pendingCapture.homeSettlePoint,
      nextTarget: nextAttempt?.target ?? null,
      nextDisplayTarget: nextAttempt?.displayTarget ?? null,
      nextRetreatFactor: nextAttempt?.retreatFactor ?? null,
      nextAttemptIndex: session.currentAttemptIndex
    });
    broadcastCalibrationStatus(session, 'retrying', `点击没有回传，从更小的 ${step.label} 重新开始`, {
      stepId: step.id,
      label: step.label,
      phase: session.phase,
      attemptIndex: session.currentAttemptIndex,
      attemptCount: session.currentAttemptIndex + 1,
      maxTapAttempts: calibrationMaxTapAttempts,
      previousCommandTarget: pendingCapture.commandTarget,
      previousHomeSettlePoint: pendingCapture.homeSettlePoint,
      nextTarget: nextAttempt?.target ?? null,
      retreatFactor: nextAttempt?.retreatFactor ?? null,
      captureMode: pendingCapture.captureMode
    });
    scheduleCalibrationStep(session, 320);
    return;
  }

  if (session.phase === 'verify') {
    finalizeCalibrationSession(session.roomId, 'error', '验证点连续回退后仍未收到点击回传', {
      detail: {
        calibration: session.calibration,
        failedVerification: pendingCapture,
        samples: session.samples,
        skippedSamples: session.skippedSamples
      }
    });
    return;
  }

  session.skippedSamples.push({
    stepId: step.id,
    label: step.label,
    anchorLabel: step.anchorLabel ?? step.label,
    phase: session.phase,
    attemptCount: pendingCapture.attemptIndex + 1,
    lastCommandTarget: pendingCapture.commandTarget,
    reason: 'tap_timeout',
    captureMode: pendingCapture.captureMode
  });
  broadcastCalibrationStatus(session, 'skipped', `连续回退后仍无回传，跳过 ${step.label}`, {
    stepId: step.id,
    label: step.label,
    phase: session.phase,
    attemptCount: pendingCapture.attemptIndex + 1,
    maxTapAttempts: calibrationMaxTapAttempts,
    skippedCount: session.skippedSamples.length,
    sampleCount: session.samples.length
  });

  session.currentAttemptIndex = 0;
  session.sampleState = null;
  session.currentStepIndex += 1;
  if (trySolveCalibrationSamples(session)) {
    return;
  }

  scheduleCalibrationStep(session, 420);
}

function getCurrentCalibrationStep(session) {
  if (session.phase === 'home') {
    return calibrationHomeStep;
  }

  if (session.phase === 'verify') {
    return calibrationVerifyStep;
  }

  return calibrationSampleSteps[session.currentStepIndex] ?? null;
}

function dispatchCalibrationTap(session, step, options = {}) {
  const stage = options.stage ?? getCalibrationStage(session, step);
  const rawTarget = normalizePoint(stage?.target);
  const shouldUseCalibration = options.useCalibration ?? (session.phase === 'verify' || session.phase === 'home');
  const target = shouldUseCalibration ? applyCalibrationPoint(session.roomId, rawTarget) : rawTarget;
  if (!target) {
    finalizeCalibrationSession(session.roomId, 'error', `标定点 ${step.id} 无效`);
    return;
  }

  const executorPayload = buildExecutorTapPayload(session.roomId, target);
  if (!executorPayload) {
    finalizeCalibrationSession(session.roomId, 'error', `标定点 ${step.id} 的 executor 载荷无效`);
    return;
  }

  const requestId = makeAutomationId('calibration-request');
  const command = {
    type: 'executor_command',
    roomId: session.roomId,
    sessionId: session.sessionId,
    requestId,
    action: 'tap',
    stepId: step.id,
    payload: executorPayload
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
    action: 'tap',
    stepId: step.id,
    timeoutHandle,
    rawTarget,
    baseTarget: normalizePoint(step.target),
    commandTarget: target,
    homeSettlePoint: executorPayload.homeSettlePoint,
    phase: session.phase,
    label: stage.label,
    attemptIndex: stage.attemptIndex,
    retreatFactor: stage.retreatFactor,
    captureMode: stage.captureMode,
    usedCalibration: shouldUseCalibration
  };

  log('calibration_dispatch', {
    roomId: session.roomId,
    sessionId: session.sessionId,
    stepId: step.id,
    label: stage.label,
    phase: session.phase,
    captureMode: stage.captureMode,
    baseTarget: normalizePoint(step.target),
    displayTarget: normalizePoint(stage.displayTarget ?? step.displayTarget ?? step.target),
    stageTarget: stage.target,
    rawTarget,
    commandTarget: target,
    homeSettlePoint: executorPayload.homeSettlePoint,
    usedCalibration: shouldUseCalibration,
    appliedCalibration: shouldUseCalibration ? getCalibrationSummary(getRoom(session.roomId)) : null,
    attemptIndex: stage.attemptIndex,
    retreatFactor: stage.retreatFactor,
    requestId
  });

  broadcastCalibrationStatus(session, 'dispatching', `已发送标定点击: ${stage.label}`, {
    stepId: step.id,
    label: stage.label,
    anchorLabel: step.anchorLabel ?? step.label,
    captureMode: stage.captureMode,
    phase: session.phase,
    rawTarget,
    displayTarget: normalizePoint(stage.displayTarget ?? step.displayTarget ?? step.target),
    commandTarget: target,
    homeSettlePoint: executorPayload.homeSettlePoint,
    usedCalibration: shouldUseCalibration,
    appliedCalibration: shouldUseCalibration ? getCalibrationSummary(getRoom(session.roomId)) : null,
    attemptIndex: stage.attemptIndex,
    attemptCount: stage.attemptIndex + 1,
    maxTapAttempts: calibrationMaxTapAttempts,
    retreatFactor: stage.retreatFactor,
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

  const stage = getCalibrationStage(session, step);
  if (!stage?.target) {
    finalizeCalibrationSession(session.roomId, 'error', `标定点 ${step.id} 无法生成有效重试目标`);
    return;
  }

  if (!sendCalibrationCommand(session.roomId, {
    type: 'calibration_command',
    method: 'armTapCapture',
    sessionId: session.sessionId,
    stepId: step.id,
    label: stage.label,
    anchorLabel: step.anchorLabel ?? step.label,
    captureMode: stage.captureMode,
    phase: session.phase,
    target: normalizePoint(stage.displayTarget ?? step.displayTarget ?? step.target),
    commandTarget: stage.target,
    displayTarget: normalizePoint(stage.displayTarget ?? step.displayTarget ?? step.target),
    attemptIndex: stage.attemptIndex,
    attemptCount: stage.attemptIndex + 1,
    maxTapAttempts: calibrationMaxTapAttempts,
    retreatFactor: stage.retreatFactor
  })) {
    finalizeCalibrationSession(session.roomId, 'error', '标定 App 当前不可用');
    return;
  }

  broadcastCalibrationStatus(session, 'arming', `准备采集 ${stage.label}`, {
    stepId: step.id,
    label: stage.label,
    anchorLabel: step.anchorLabel ?? step.label,
    captureMode: stage.captureMode,
    phase: session.phase,
    target: stage.target,
    homeSettlePoint: buildExecutorHomeSettlePoint(session.roomId),
    displayTarget: normalizePoint(stage.displayTarget ?? step.displayTarget ?? step.target),
    attemptIndex: stage.attemptIndex,
    attemptCount: stage.attemptIndex + 1,
    maxTapAttempts: calibrationMaxTapAttempts,
    retreatFactor: stage.retreatFactor,
    sampleIndex: session.currentStepIndex + 1,
    sampleCount: calibrationSampleSteps.length,
    calibration: session.calibration,
    note: '每个锚点先测一次，再测 4/5；如果实际点击也接近 4/5，就认定这组 scale 有效，否则从更小点继续'
  });

  clearCalibrationTimer(session);
  session.timer = setTimeout(() => {
    const activeSession = getCalibrationSession(session.roomId, session.sessionId);
    if (activeSession) {
      dispatchCalibrationTap(activeSession, step, {
        stage,
        useCalibration: activeSession.phase === 'verify' || activeSession.phase === 'home'
      });
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
    phase: 'home',
    currentStepIndex: 0,
    currentAttemptIndex: 0,
    samples: [],
    skippedSamples: [],
    sampleState: null,
    calibration: room.calibration ? { ...room.calibration } : null,
    pendingExecutorCommand: null,
    pendingCapture: null,
    timer: null,
    createdAt: new Date().toISOString()
  };

  calibrationSessions.set(roomId, session);
  broadcastCalibrationStatus(session, 'starting', '开始 HID 点击标定', {
    sampleCount: calibrationSampleSteps.length + 1,
    baseAnchorCount: calibrationBaseAnchors.length,
    verifyTarget: calibrationVerifyStep.target,
    homeSettleTarget: homeSettleReferenceTarget,
    homeSettleCommandTarget: buildExecutorHomeSettlePoint(roomId),
    existingCalibration: getCalibrationSummary(room),
    note: '每次 home 后都会先按当前 calibration 固定移动到右下参考点，再执行剩余位移；标定时先测这个参考点的真实落点，再做锚点的 4/5 比例采样'
  });
  broadcastCalibrationStatus(session, 'prepared', '先采集 home 后的右下固定参考点，再进入锚点采样', {
    sampleCount: calibrationSampleSteps.length + 1,
    homeSettleTarget: homeSettleReferenceTarget,
    verifyTarget: calibrationVerifyStep.target
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
    rawTarget: pendingCommand.rawTarget,
    commandTarget: pendingCommand.commandTarget,
    baseTarget: pendingCommand.baseTarget,
    homeSettlePoint: pendingCommand.homeSettlePoint,
    attemptIndex: pendingCommand.attemptIndex,
    retreatFactor: pendingCommand.retreatFactor,
    captureMode: pendingCommand.captureMode,
    timeoutHandle: captureTimeout
  };

  broadcastCalibrationStatus(session, 'awaiting_tap', `等待 App 回传实际点击: ${pendingCommand.label}`, {
    stepId: pendingCommand.stepId,
    label: pendingCommand.label,
    phase: pendingCommand.phase,
    rawTarget: pendingCommand.rawTarget,
    commandTarget: pendingCommand.commandTarget,
    homeSettlePoint: pendingCommand.homeSettlePoint,
    captureMode: pendingCommand.captureMode,
    attemptIndex: pendingCommand.attemptIndex,
    attemptCount: pendingCommand.attemptIndex + 1,
    maxTapAttempts: calibrationMaxTapAttempts,
    retreatFactor: pendingCommand.retreatFactor,
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

  log('calibration_capture', {
    roomId: session.roomId,
    sessionId: session.sessionId,
    stepId: message.stepId,
    label: pendingCapture.label,
    phase: session.phase,
    captureMode: pendingCapture.captureMode,
    baseTarget: pendingCapture.baseTarget,
    commandTarget: pendingCapture.commandTarget,
    iosActualPoint: actualPoint,
    attemptIndex: pendingCapture.attemptIndex,
    retreatFactor: pendingCapture.retreatFactor
  });

  clearPendingCalibrationCapture(session);
  const step = getCurrentCalibrationStep(session);
  if (!step || step.id !== message.stepId) {
    finalizeCalibrationSession(session.roomId, 'error', '标定步骤与回传点击不一致');
    return;
  }

  const effectiveTarget = pendingCapture.commandTarget;
  const errorDetail = computePointError(effectiveTarget, actualPoint);
  if (session.phase === 'home') {
    const homeSample = {
      stepId: calibrationHomeStep.id,
      label: calibrationHomeStep.label,
      anchorLabel: calibrationHomeStep.anchorLabel,
      target: normalizePoint(calibrationHomeStep.target),
      baseTarget: normalizePoint(calibrationHomeStep.target),
      displayTarget: normalizePoint(calibrationHomeStep.displayTarget),
      actual: actualPoint,
      error: errorDetail,
      attemptCount: pendingCapture.attemptIndex + 1,
      retreatFactor: 1
    };
    session.samples.push(homeSample);
    session.phase = 'sample';
    session.currentAttemptIndex = 0;
    session.sampleState = null;

    log('calibration_home_sample', {
      roomId: session.roomId,
      sessionId: session.sessionId,
      referenceTarget: homeSample.target,
      referenceActual: homeSample.actual,
      referenceError: homeSample.error
    });

    broadcastCalibrationStatus(session, 'captured', '已采集 Home 右下固定参考点，开始锚点采样', {
      stepId: calibrationHomeStep.id,
      label: calibrationHomeStep.label,
      captureMode: pendingCapture.captureMode,
      target: homeSample.target,
      homeSettlePoint: pendingCapture.homeSettlePoint,
      actual: homeSample.actual,
      error: homeSample.error,
      sampleIndex: 1,
      sampleCount: calibrationSampleSteps.length + 1
    });

    scheduleCalibrationStep(session, 320);
    return;
  }

  if (session.phase === 'sample') {
    if (pendingCapture.captureMode === 'primary') {
      session.sampleState = {
        stepId: step.id,
        label: step.label,
        baseAttemptIndex: pendingCapture.attemptIndex,
        baseCommandTarget: effectiveTarget,
        baseActual: actualPoint,
        displayTarget: normalizePoint(step.displayTarget ?? step.target)
      };

      broadcastCalibrationStatus(session, 'captured', `已采集 ${pendingCapture.label}，开始 4/5 复测`, {
        stepId: step.id,
        label: pendingCapture.label,
        anchorLabel: step.anchorLabel ?? step.label,
        captureMode: pendingCapture.captureMode,
        target: effectiveTarget,
        displayTarget: normalizePoint(step.displayTarget ?? step.target),
        actual: actualPoint,
        error: errorDetail,
        attemptIndex: pendingCapture.attemptIndex,
        attemptCount: pendingCapture.attemptIndex + 1,
        maxTapAttempts: calibrationMaxTapAttempts,
        sampleIndex: session.currentStepIndex + 1,
        sampleCount: calibrationSampleSteps.length
      });

      scheduleCalibrationStep(session, 320);
      return;
    }

    const baseSample = session.sampleState;
    if (!baseSample || baseSample.stepId !== step.id) {
      finalizeCalibrationSession(session.roomId, 'error', '4/5 复测缺少上一组基础样本');
      return;
    }

    const pairResult = evaluateCalibrationPair({
      commandTarget: baseSample.baseCommandTarget,
      actual: baseSample.baseActual
    }, {
      commandTarget: effectiveTarget,
      actual: actualPoint
    });

    log('calibration_pair_check', {
      roomId: session.roomId,
      sessionId: session.sessionId,
      stepId: step.id,
      label: step.label,
      baseTarget: baseSample.baseCommandTarget,
      baseActual: baseSample.baseActual,
      reducedTarget: effectiveTarget,
      reducedActual: actualPoint,
      pairResult
    });

    if (pairResult.isValid) {
      session.samples.push({
        stepId: `${step.id}-base-${baseSample.baseAttemptIndex}`,
        label: `${step.label} · 基础点`,
        anchorLabel: step.anchorLabel ?? step.label,
        target: baseSample.baseCommandTarget,
        baseTarget: normalizePoint(step.target),
        displayTarget: baseSample.displayTarget,
        actual: baseSample.baseActual,
        error: computePointError(baseSample.baseCommandTarget, baseSample.baseActual),
        attemptCount: baseSample.baseAttemptIndex + 1,
        retreatFactor: calibrationRetryBackoffFactor ** baseSample.baseAttemptIndex
      });
      session.samples.push({
        stepId: `${step.id}-reduced-${pendingCapture.attemptIndex}`,
        label: `${step.label} · 4/5 复测`,
        anchorLabel: step.anchorLabel ?? step.label,
        target: effectiveTarget,
        baseTarget: normalizePoint(step.target),
        displayTarget: normalizePoint(step.displayTarget ?? step.target),
        actual: actualPoint,
        error: errorDetail,
        attemptCount: pendingCapture.attemptIndex + 1,
        retreatFactor: pendingCapture.retreatFactor
      });

      broadcastCalibrationStatus(session, 'captured', `已确认 ${step.label} 的 4/5 比例关系，样本有效`, {
        stepId: step.id,
        label: pendingCapture.label,
        anchorLabel: step.anchorLabel ?? step.label,
        captureMode: pendingCapture.captureMode,
        baseTarget: baseSample.baseCommandTarget,
        baseActual: baseSample.baseActual,
        target: effectiveTarget,
        displayTarget: normalizePoint(step.displayTarget ?? step.target),
        actual: actualPoint,
        error: errorDetail,
        pairResult,
        attemptIndex: pendingCapture.attemptIndex,
        attemptCount: pendingCapture.attemptIndex + 1,
        maxTapAttempts: calibrationMaxTapAttempts,
        sampleIndex: session.currentStepIndex + 1,
        sampleCount: calibrationSampleSteps.length
      });

      session.sampleState = null;
      session.currentAttemptIndex = 0;
      session.currentStepIndex += 1;
      if (trySolveCalibrationSamples(session)) {
        return;
      }

      scheduleCalibrationStep(session, 420);
      return;
    }

    if (pendingCapture.attemptIndex + 1 >= calibrationMaxTapAttempts) {
      session.skippedSamples.push({
        stepId: step.id,
        label: step.label,
        anchorLabel: step.anchorLabel ?? step.label,
        phase: session.phase,
        attemptCount: pendingCapture.attemptIndex + 1,
        lastCommandTarget: effectiveTarget,
        reason: 'pair_ratio_invalid',
        pairResult
      });
      broadcastCalibrationStatus(session, 'skipped', `连续缩小后 ${step.label} 仍不满足 4/5 比例，跳过`, {
        stepId: step.id,
        label: step.label,
        pairResult,
        attemptCount: pendingCapture.attemptIndex + 1,
        skippedCount: session.skippedSamples.length,
        sampleCount: session.samples.length
      });
      session.sampleState = null;
      session.currentAttemptIndex = 0;
      session.currentStepIndex += 1;
      if (trySolveCalibrationSamples(session)) {
        return;
      }

      scheduleCalibrationStep(session, 420);
      return;
    }

    session.sampleState = {
      stepId: step.id,
      label: step.label,
      baseAttemptIndex: pendingCapture.attemptIndex,
      baseCommandTarget: effectiveTarget,
      baseActual: actualPoint,
      displayTarget: normalizePoint(step.displayTarget ?? step.target)
    };
    session.currentAttemptIndex = pendingCapture.attemptIndex;

    broadcastCalibrationStatus(session, 'retrying', `${step.label} 未满足 4/5 比例，从更小点继续`, {
      stepId: step.id,
      label: pendingCapture.label,
      anchorLabel: step.anchorLabel ?? step.label,
      captureMode: pendingCapture.captureMode,
      baseTarget: baseSample.baseCommandTarget,
      baseActual: baseSample.baseActual,
      target: effectiveTarget,
      displayTarget: normalizePoint(step.displayTarget ?? step.target),
      actual: actualPoint,
      error: errorDetail,
      pairResult,
      attemptIndex: pendingCapture.attemptIndex,
      attemptCount: pendingCapture.attemptIndex + 1,
      maxTapAttempts: calibrationMaxTapAttempts,
      sampleIndex: session.currentStepIndex + 1,
      sampleCount: calibrationSampleSteps.length
    });

    scheduleCalibrationStep(session, 320);
    return;
  }

  const verification = {
    target: effectiveTarget,
    actual: actualPoint,
    error: computePointError(effectiveTarget, actualPoint),
    threshold: calibrationVerificationThreshold
  };

  if (!verification.error || verification.error.distance > calibrationVerificationThreshold) {
    finalizeCalibrationSession(session.roomId, 'error', '标定验证失败，误差超出阈值', {
      calibration: session.calibration,
      verification,
      samples: session.samples
    });
    return;
  }

  finalizeCalibrationSession(session.roomId, 'completed', '标定完成，校正参数已生效', {
    calibration: session.calibration,
    verification,
    samples: session.samples
  });
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

    const command = buildExecutorTapPayload(session.roomId, point);
    if (!command) {
      finalizeAutomationSession(session.roomId, 'error', `步骤 ${step.id} 的点击执行载荷无效`, {
        stepId: step.id
      });
      return;
    }

    const requestId = dispatchExecutorCommand(session, 'tap', command, {
      stepId: step.id,
      timeoutMs: 15_000,
      nextDelayMs: Number(step.postActionDelayMs) || 350
    });
    broadcastAutomationAction(session, step, 'tap', { ...command, rawPoint, requestId });
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
      homeSettlePoint: buildExecutorHomeSettlePoint(session.roomId),
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

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  const roomSummary = Array.from(rooms.entries()).map(([roomId, room]) => ({
    roomId,
    hasPublisher: Boolean(room.publisher),
    hasExecutor: Boolean(room.executor),
    hasCalibrationApp: isClientOpen(getCalibrationApp(roomId)),
    calibrationAppId: room.calibrationAppId,
    calibration: getCalibrationSummary(room),
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

    if (message.type === 'debug_frame_result') {
      if (ws.clientType !== 'publisher') {
        log('debug_frame_result_rejected', {
          roomId: ws.roomId,
          clientId: ws.clientId,
          clientType: ws.clientType,
          reason: 'publisher_only'
        });
        safeSend(ws, { type: 'error', message: 'Only publisher clients can send debug frame results' });
        return;
      }

      handleDebugFrameResult(ws.roomId, message);
      return;
    }

    if (message.type === 'debug_frame_request') {
      if (!['viewer', 'probe'].includes(ws.clientType)) {
        log('debug_frame_request_rejected', {
          roomId: ws.roomId,
          clientId: ws.clientId,
          clientType: ws.clientType,
          reason: 'viewer_or_probe_only'
        });
        safeSend(ws, { type: 'error', message: 'Only viewer or probe clients can request debug frames' });
        return;
      }

      const requestId = typeof message.requestId === 'string' && message.requestId
        ? message.requestId
        : makeAutomationId('debug-frame');
      const query = typeof message.query === 'string' ? message.query.trim() : '';

      rememberDebugFrameRequest(ws.roomId, requestId, ws.clientId);
      const forwarded = sendToPublisher(ws.roomId, {
        type: 'debug_frame_request',
        requestId,
        query,
        requesterClientId: ws.clientId
      });

      if (!forwarded) {
        takeDebugFrameRequest(ws.roomId, requestId);
        safeSend(ws, {
          type: 'debug_frame_result',
          requestId,
          status: 'error',
          error: 'Publisher 未连接，无法获取内存帧'
        });
        return;
      }

      safeSend(ws, {
        type: 'debug_frame_queued',
        requestId,
        query,
        status: 'pending'
      });
      return;
    }

    if (message.type === 'calibration_register') {
      if (ws.clientType !== 'probe') {
        safeSend(ws, { type: 'error', message: 'Only probe clients can register calibration app role' });
        return;
      }

      if ((message.role || '') !== 'app') {
        safeSend(ws, { type: 'error', message: 'Unsupported calibration role' });
        return;
      }

      registerCalibrationApp(ws.roomId, ws);
      return;
    }

    if (message.type === 'calibration_start') {
      if (!['viewer', 'probe'].includes(ws.clientType)) {
        safeSend(ws, { type: 'warning', message: 'Only viewer or probe clients can start calibration' });
        return;
      }

      try {
        startCalibrationSession(ws.roomId, ws);
      } catch (error) {
        const room = getRoom(ws.roomId);
        broadcastCalibrationPayload(ws.roomId, {
          type: 'calibration_status',
          roomId: ws.roomId,
          sessionId: null,
          ownerClientId: ws.clientId,
          appClientId: room.calibrationAppId,
          status: 'error',
          message: error.message || '启动标定失败',
          detail: null,
          calibration: getCalibrationSummary(room),
          updatedAt: new Date().toISOString()
        });
      }
      return;
    }

    if (message.type === 'calibration_result') {
      if (ws.clientType !== 'probe') {
        safeSend(ws, { type: 'error', message: 'Only probe clients can report calibration taps' });
        return;
      }

      handleCalibrationResult(ws.roomId, ws, message);
      return;
    }

    if (message.type === 'automation_start') {
      if (ws.clientType !== 'viewer') {
        safeSend(ws, { type: 'warning', message: 'Only viewer clients can start automation' });
        return;
      }

      if (calibrationSessions.has(ws.roomId)) {
        safeSend(ws, { type: 'warning', message: 'Calibration is running, stop it before starting automation' });
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
      failPendingDebugFrameRequests(ws.roomId, 'Publisher 已断开，无法返回内存帧');

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
      clearDebugFrameRequestsForClient(ws.roomId, ws.clientId);

      const calibrationSession = calibrationSessions.get(ws.roomId);
      if (calibrationSession && calibrationSession.ownerClientId === ws.clientId) {
        finalizeCalibrationSession(ws.roomId, 'stopped', '标定发起端已断开');
      }

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
      clearDebugFrameRequestsForClient(ws.roomId, ws.clientId);

      if (currentRoom.calibrationAppId === ws.clientId) {
        currentRoom.calibrationAppId = null;
        const calibrationSession = calibrationSessions.get(ws.roomId);
        if (calibrationSession && calibrationSession.appClientId === ws.clientId) {
          finalizeCalibrationSession(ws.roomId, 'error', '标定 App 已断开');
        }
      }

      const calibrationSession = calibrationSessions.get(ws.roomId);
      if (calibrationSession && calibrationSession.ownerClientId === ws.clientId) {
        finalizeCalibrationSession(ws.roomId, 'stopped', '标定发起端已断开');
      }
    }

    if (ws.clientType === 'executor' && currentRoom.executor === ws) {
      currentRoom.executor = null;
      currentRoom.executorConnectedAt = null;

      if (automationSessions.has(ws.roomId)) {
        finalizeAutomationSession(ws.roomId, 'error', 'Executor 已断开');
      }
    }

    if (!currentRoom.publisher && !currentRoom.executor && currentRoom.viewers.size === 0 && currentRoom.probes.size === 0) {
      debugFrameRequests.delete(ws.roomId);
      calibrationSessions.delete(ws.roomId);
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
