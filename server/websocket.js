const { WebSocket } = require('ws');

function registerWebSocketServer(wss, runtime) {
  const {
    automationSessions,
    calibrationSessions,
    calibrationValidationSessions,
    debugFrameRequests,
    rooms,
    log,
    summarizeSignal,
    getRoom,
    makeClientId,
    getViewerIds,
    getExecutorId,
    getCalibrationSummary,
    getCalibrationApp,
    rememberDebugFrameRequest,
    takeDebugFrameRequest,
    clearDebugFrameRequestsForClient,
    failPendingDebugFrameRequests,
    getClientById,
    broadcastRoomState,
    safeSend,
    isClientOpen,
    sendToPublisher,
    makeAutomationId,
    handleDebugFrameResult,
    broadcastCalibrationPayload,
    handleCalibrationColorFrameResult,
    registerCalibrationApp,
    startCalibrationSession,
    startCalibrationValidationSession,
    handleCalibrationResult,
    sanitizePackageId,
    broadcastAutomationStatusSnapshot,
    startAutomationSession,
    stopAutomationSession,
    handleAutomationResult,
    handleExecutorResult,
    handleCalibrationExecutorResult,
    finalizeCalibrationSession,
    finalizeCalibrationValidationSession,
    finalizeAutomationSession,
    broadcastAutomationEvent
  } = runtime;

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
        hasPublisher: isClientOpen(room.publisher),
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
        hasPublisher: isClientOpen(room.publisher),
        publisherId: room.publisher?.clientId ?? null,
        hasExecutor: isClientOpen(room.executor),
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
        hasPublisher: isClientOpen(room.publisher),
        publisherId: room.publisher?.clientId ?? null,
        hasExecutor: isClientOpen(room.executor),
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
  
      if (message.type === 'calibration_color_frame_result') {
        if (ws.clientType !== 'publisher') {
          log('calibration_color_frame_result_rejected', {
            roomId: ws.roomId,
            clientId: ws.clientId,
            clientType: ws.clientType,
            reason: 'publisher_only'
          });
          safeSend(ws, { type: 'error', message: 'Only publisher clients can send calibration color frame results' });
          return;
        }
  
        handleCalibrationColorFrameResult(ws.roomId, message);
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

      if (message.type === 'calibration_validate_start') {
        if (!['viewer', 'probe'].includes(ws.clientType)) {
          safeSend(ws, { type: 'warning', message: 'Only viewer or probe clients can start calibration validation' });
          return;
        }

        try {
          startCalibrationValidationSession(ws.roomId, ws);
        } catch (error) {
          const room = getRoom(ws.roomId);
          broadcastCalibrationPayload(ws.roomId, {
            type: 'calibration_status',
            roomId: ws.roomId,
            sessionId: null,
            ownerClientId: ws.clientId,
            appClientId: room.calibrationAppId,
            status: 'error',
            message: error.message || '启动标定验证失败',
            detail: {
              mode: 'validation'
            },
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

        if (calibrationValidationSessions.has(ws.roomId)) {
          finalizeCalibrationValidationSession(ws.roomId, 'error', 'Publisher 已断开');
        }
      }
  
      if (ws.clientType === 'viewer') {
        currentRoom.viewers.delete(ws.clientId);
        clearDebugFrameRequestsForClient(ws.roomId, ws.clientId);
  
        const calibrationSession = calibrationSessions.get(ws.roomId);
        if (calibrationSession && calibrationSession.ownerClientId === ws.clientId) {
          finalizeCalibrationSession(ws.roomId, 'stopped', '标定发起端已断开');
        }

        const validationSession = calibrationValidationSessions.get(ws.roomId);
        if (validationSession && validationSession.ownerClientId === ws.clientId) {
          finalizeCalibrationValidationSession(ws.roomId, 'stopped', '验证发起端已断开');
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

          const validationSession = calibrationValidationSessions.get(ws.roomId);
          if (validationSession && validationSession.appClientId === ws.clientId) {
            finalizeCalibrationValidationSession(ws.roomId, 'error', '标定 App 已断开');
          }
        }
  
        const calibrationSession = calibrationSessions.get(ws.roomId);
        if (calibrationSession && calibrationSession.ownerClientId === ws.clientId) {
          finalizeCalibrationSession(ws.roomId, 'stopped', '标定发起端已断开');
        }

        const validationSession = calibrationValidationSessions.get(ws.roomId);
        if (validationSession && validationSession.ownerClientId === ws.clientId) {
          finalizeCalibrationValidationSession(ws.roomId, 'stopped', '验证发起端已断开');
        }
      }
  
      if (ws.clientType === 'executor' && currentRoom.executor === ws) {
        currentRoom.executor = null;
        currentRoom.executorConnectedAt = null;
  
        if (automationSessions.has(ws.roomId)) {
          finalizeAutomationSession(ws.roomId, 'error', 'Executor 已断开');
        }

        if (calibrationValidationSessions.has(ws.roomId)) {
          finalizeCalibrationValidationSession(ws.roomId, 'error', 'Executor 已断开');
        }
      }
  
      if (!currentRoom.publisher && !currentRoom.executor && currentRoom.viewers.size === 0 && currentRoom.probes.size === 0) {
        debugFrameRequests.delete(ws.roomId);
        calibrationSessions.delete(ws.roomId);
        calibrationValidationSessions.delete(ws.roomId);
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
  
}

module.exports = { registerWebSocketServer };
