import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildClientSocketUrl, getDefaultServerBaseUrl, normalizeBaseUrl } from '../lib/network';

function pushLine(lines, nextLine, maxSize = 80) {
  return [nextLine, ...lines].slice(0, maxSize);
}

function logLine(message) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return `[${timestamp}] ${message}`;
}

function formatBounds(bounds) {
  if (!bounds) {
    return '-';
  }

  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => Number(value || 0).toFixed(3))
    .join(', ');
}

function normalizePointColor(value) {
  return value || '#34c759';
}

function calibrationFrameSize(message) {
  const detail = message?.detail || {};
  return detail.frame?.sourceFrameSize
    || detail.frame?.imageSize
    || detail.calibration?.sourceFrameSize
    || message?.calibration?.sourceFrameSize
    || null;
}

function calibrationReferencePoints(message) {
  const detail = message?.detail || {};
  const validationSteps = Array.isArray(detail.validation?.steps) ? detail.validation.steps : [];
  if (validationSteps.length > 0) {
    const points = [];
    for (const step of validationSteps) {
      if (step.expectedFramePx) {
        points.push({
          label: `E ${step.label}`,
          color: normalizePointColor(step.color),
          centerPx: step.expectedFramePx,
          kind: 'expected'
        });
      }
      if (step.appReportedFramePx) {
        points.push({
          label: `A ${step.label}${Number.isFinite(step.appErrorPx) ? ` · ${Math.round(step.appErrorPx)}px` : ''}`,
          color: normalizePointColor(step.color),
          centerPx: step.appReportedFramePx,
          kind: 'app'
        });
      }
      if (step.detectedFramePx) {
        points.push({
          label: `D ${step.label}${Number.isFinite(step.errorPx) ? ` · ${Math.round(step.errorPx)}px` : ''}`,
          color: normalizePointColor(step.color),
          centerPx: step.detectedFramePx,
          kind: 'detected'
        });
      }
    }
    if (points.length > 0) {
      return points;
    }
  }

  const detections = Array.isArray(detail.frame?.detections) ? detail.frame.detections : [];
  if (detections.length > 0) {
    return detections
      .filter((detection) => detection?.centerPx)
      .map((detection) => ({
        label: detection.label || detection.stepId || 'point',
        color: normalizePointColor(detection.color),
        centerPx: detection.centerPx,
        kind: 'detected'
      }));
  }

  const samples = Array.isArray(detail.calibration?.samples) ? detail.calibration.samples : [];
  return samples
    .filter((sample) => sample?.centerPx)
    .map((sample) => ({
      label: sample.label || sample.stepId || 'point',
      color: normalizePointColor(sample.color),
      centerPx: sample.centerPx,
      kind: 'detected'
    }));
}

function buildCalibrationReference(message) {
  const size = calibrationFrameSize(message);
  const width = Number(size?.width);
  const height = Number(size?.height);
  const points = calibrationReferencePoints(message);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || points.length === 0) {
    return null;
  }

  const mode = message?.detail?.mode === 'validation' ? '验证' : '标定';
  return {
    width,
    height,
    meta: `${mode}参考 · ${Math.round(width)} x ${Math.round(height)} px · ${points.length} 点`,
    points: points
      .map((point) => {
        const x = Number(point.centerPx?.x);
        const y = Number(point.centerPx?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }

        return {
          label: `${point.label} (${Math.round(x)}, ${Math.round(y)})`,
          kind: point.kind || 'detected',
          color: normalizePointColor(point.color),
          left: Math.max(0, Math.min(100, (x / width) * 100)),
          top: Math.max(0, Math.min(100, (y / height) * 100))
        };
      })
      .filter(Boolean)
  };
}

export function useProbeConnection() {
  const [config, setConfig] = useState({
    serverUrl: getDefaultServerBaseUrl(),
    roomId: 'demo-room',
    query: ''
  });
  const [socket, setSocket] = useState(null);
  const [state, setState] = useState({
    connected: false,
    socketStatus: '未连接',
    publisherStatus: 'Publisher 不在线',
    calibrationAppStatus: '标定 App 未连接',
    requestStatus: '等待请求',
    calibrationStatus: '未标定',
    calibrationSummary: '等待开始标定... ',
    logs: [],
    frameImageDataUrl: '',
    requestId: '-',
    respondedAt: '-',
    candidateCount: 0,
    matchedCount: 0,
    matchedCandidates: [],
    allCandidates: [],
    roomHasCalibrationApp: false,
    roomCalibration: null,
    calibrationReference: null
  });

  const appendLog = useCallback((message) => {
    setState((current) => ({
      ...current,
      logs: pushLine(current.logs, logLine(message))
    }));
  }, []);

  const updateConfig = useCallback((key, value) => {
    setConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const disconnect = useCallback(() => {
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      setSocket(null);
    }

    setState((current) => ({
      ...current,
      connected: false,
      socketStatus: '未连接',
      publisherStatus: 'Publisher 不在线',
      calibrationAppStatus: '标定 App 未连接',
      roomHasCalibrationApp: false,
      roomCalibration: null
    }));
  }, [socket]);

  const connect = useCallback(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      disconnect();
      return;
    }

    const url = buildClientSocketUrl(config.serverUrl, {
      clientType: 'probe',
      roomId: config.roomId || 'demo-room'
    });
    appendLog(`连接 ${url}`);
    const nextSocket = new WebSocket(url);
    setSocket(nextSocket);
    setState((current) => ({ ...current, socketStatus: '连接中' }));

    nextSocket.onopen = () => {
      setState((current) => ({ ...current, connected: true, socketStatus: '调试通道已连接' }));
      appendLog('WebSocket 已连接');
    };

    nextSocket.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'room_state') {
        setState((current) => ({
          ...current,
          publisherStatus: message.hasPublisher ? `Publisher 在线 · ${message.publisherId || 'unknown'}` : 'Publisher 不在线',
          calibrationAppStatus: message.hasCalibrationApp ? `标定 App 在线 · ${message.calibrationAppId || 'unknown'}` : '标定 App 未连接',
          calibrationStatus: message.calibration ? '已有标定参数' : '未标定',
          roomHasCalibrationApp: Boolean(message.hasCalibrationApp),
          roomCalibration: message.calibration || null,
          calibrationReference: current.calibrationReference,
          calibrationSummary: message.calibration
            ? JSON.stringify(message.calibration, null, 2)
            : current.calibrationSummary
        }));
        appendLog(`room_state hasPublisher=${Boolean(message.hasPublisher)} hasCalibrationApp=${Boolean(message.hasCalibrationApp)}`);
        return;
      }

      if (message.type === 'probe_ready') {
        setState((current) => ({
          ...current,
          publisherStatus: message.hasPublisher ? `Publisher 在线 · ${message.publisherId || 'unknown'}` : 'Publisher 不在线',
          calibrationAppStatus: '等待标定 App 注册'
        }));
        appendLog(`probe_ready clientId=${message.clientId}`);
        return;
      }

      if (message.type === 'debug_frame_queued') {
        setState((current) => ({
          ...current,
          requestStatus: '请求已发送，等待 iOS 返回',
          requestId: message.requestId || current.requestId
        }));
        appendLog(`debug_frame_queued requestId=${message.requestId}`);
        return;
      }

      if (message.type === 'debug_frame_result') {
        if (message.status === 'error') {
          setState((current) => ({ ...current, requestStatus: '请求失败' }));
          appendLog(`debug_frame_result error=${message.error || 'unknown'}`);
          return;
        }

        const payload = message.payload || {};
        const allCandidates = Array.isArray(payload.ocrCandidates) ? payload.ocrCandidates : [];
        const matchedCandidates = Array.isArray(payload.matchedCandidates) ? payload.matchedCandidates : [];
        setState((current) => ({
          ...current,
          requestStatus: '请求完成',
          frameImageDataUrl: payload.imageDataURL || current.frameImageDataUrl,
          requestId: message.requestId || '-',
          respondedAt: message.respondedAt || payload.capturedAt || '-',
          candidateCount: allCandidates.length,
          matchedCount: matchedCandidates.length,
          allCandidates,
          matchedCandidates
        }));
        appendLog(`debug_frame_result ok requestId=${message.requestId}`);
        return;
      }

      if (message.type === 'calibration_status') {
        setState((current) => ({
          ...current,
          calibrationStatus: message.message || message.status || '标定中',
          calibrationReference: buildCalibrationReference(message),
          calibrationSummary: `status: ${message.status || 'unknown'}\nmessage: ${message.message || ''}\n\n${JSON.stringify(message.detail || {}, null, 2)}\n\ncalibration:\n${JSON.stringify(message.calibration || null, null, 2)}`,
          roomCalibration: message.calibration || current.roomCalibration
        }));
        appendLog(`calibration_status ${message.status || 'unknown'} ${message.message || ''}`);
        return;
      }

      if (message.type === 'warning' || message.type === 'error') {
        appendLog(`${message.type}: ${message.message || 'unknown'}`);
        return;
      }

      appendLog(`收到消息 ${message.type}`);
    };

    nextSocket.onerror = () => {
      setState((current) => ({ ...current, socketStatus: '连接错误' }));
      appendLog('WebSocket 发生错误');
    };

    nextSocket.onclose = () => {
      setState((current) => ({
        ...current,
        connected: false,
        socketStatus: '未连接',
        roomHasCalibrationApp: false,
        roomCalibration: null,
        calibrationAppStatus: '标定 App 未连接'
      }));
      appendLog('WebSocket 已断开');
      setSocket(null);
    };
  }, [appendLog, config.roomId, config.serverUrl, disconnect, socket]);

  useEffect(() => () => disconnect(), [disconnect]);

  const requestDebugFrame = useCallback(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog('调试通道未连接');
      return;
    }

    const requestId = `debug-${Date.now().toString(36)}`;
    setState((current) => ({
      ...current,
      requestStatus: '请求发送中',
      requestId,
      allCandidates: [],
      matchedCandidates: []
    }));
    socket.send(JSON.stringify({
      type: 'debug_frame_request',
      requestId,
      query: String(config.query || '').trim()
    }));
  }, [appendLog, config.query, socket]);

  const startCalibration = useCallback(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog('调试通道未连接');
      return;
    }

    if (!state.roomHasCalibrationApp) {
      setState((current) => ({
        ...current,
        calibrationStatus: '缺少标定 App',
        calibrationSummary: '当前房间还没有连接中的标定 App。\n请先在 iPhone 主 App 中点击“连接标定通道”，并确认使用的是同一个 room。'
      }));
      appendLog('calibration_start blocked: calibration app is not connected');
      return;
    }

    setState((current) => ({ ...current, calibrationStatus: '标定启动中', calibrationSummary: '正在请求服务端启动标定...' }));
    socket.send(JSON.stringify({ type: 'calibration_start' }));
  }, [appendLog, socket, state.roomHasCalibrationApp]);

  const startCalibrationValidation = useCallback(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog('调试通道未连接');
      return;
    }

    if (!state.roomHasCalibrationApp) {
      setState((current) => ({
        ...current,
        calibrationStatus: '缺少标定 App',
        calibrationSummary: '当前房间还没有连接中的标定 App，无法执行标定验证。'
      }));
      appendLog('calibration_validate_start blocked: calibration app is not connected');
      return;
    }

    if (!state.roomCalibration) {
      setState((current) => ({
        ...current,
        calibrationStatus: '缺少标定参数',
        calibrationSummary: '当前房间还没有可用的 calibration。请先完成一次标定，再执行验证。'
      }));
      appendLog('calibration_validate_start blocked: calibration is missing');
      return;
    }

    setState((current) => ({ ...current, calibrationStatus: '验证启动中', calibrationSummary: '正在请求服务端启动标定验证...' }));
    socket.send(JSON.stringify({ type: 'calibration_validate_start' }));
  }, [appendLog, socket, state.roomCalibration, state.roomHasCalibrationApp]);

  const calibrationReference = useMemo(() => {
    const reference = state.calibrationReference;
    if (!reference) {
      return null;
    }

    const canReuseFrameImage = Boolean(state.frameImageDataUrl);
    return {
      ...reference,
      imageDataUrl: canReuseFrameImage ? state.frameImageDataUrl : ''
    };
  }, [state.calibrationReference, state.frameImageDataUrl]);

  return {
    ...state,
    calibrationReference,
    serverUrl: config.serverUrl,
    roomId: config.roomId,
    query: config.query,
    normalizedServerUrl: normalizeBaseUrl(config.serverUrl),
    updateConfig,
    connect,
    disconnect,
    requestDebugFrame,
    startCalibration,
    startCalibrationValidation,
    formatBounds
  };
}