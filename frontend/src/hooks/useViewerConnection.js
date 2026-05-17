import { useCallback, useEffect, useRef, useState } from 'react';
import { buildClientSocketUrl, normalizeBaseUrl } from '../lib/network';

const MAX_OVERLAY_ITEMS = 40;

function appendLine(list, line, maxSize) {
  return [...list, line].slice(-maxSize);
}

function timeLine(message, payload) {
  const timestamp = new Date().toLocaleTimeString('zh-CN');
  if (payload === undefined) {
    return `[${timestamp}] ${message}`;
  }

  try {
    return `[${timestamp}] ${message} ${JSON.stringify(payload)}`;
  } catch {
    return `[${timestamp}] ${message} ${String(payload)}`;
  }
}

function describePoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return '未知';
  }

  return `(${x.toFixed(0)}, ${y.toFixed(0)})`;
}

function describeAction(message) {
  const command = message.command || {};
  if (message.action === 'tap') {
    return `${message.stepId || 'tap'} -> 帧 ${describePoint(command.framePoint)} / HID ${describePoint(command.point)}`;
  }

  if (message.action === 'drag') {
    return `${message.stepId || 'drag'} -> ${describePoint(command.frameFrom)} => ${describePoint(command.frameTo)}`;
  }

  return `${message.stepId || message.action || 'action'} 已下发`;
}

function describeExecutorResult(message) {
  const payload = message.payload || {};
  if (message.action === 'tap') {
    return `${message.status || 'unknown'} / ${describePoint(payload.target)}`;
  }

  if (message.action === 'drag') {
    return `${message.status || 'unknown'} / ${describePoint(payload.from)} => ${describePoint(payload.to)}`;
  }

  return message.status || message.error || 'unknown';
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(1, number));
}

function parseDisplayPoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function normalizePointForOverlay(point, videoElement) {
  const parsed = parseDisplayPoint(point);
  if (!parsed) {
    return null;
  }

  if (parsed.x >= 0 && parsed.x <= 1 && parsed.y >= 0 && parsed.y <= 1) {
    return {
      x: clamp01(parsed.x),
      y: clamp01(parsed.y)
    };
  }

  const width = Number(videoElement?.videoWidth || 0);
  const height = Number(videoElement?.videoHeight || 0);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: clamp01(parsed.x / width),
    y: clamp01(parsed.y / height)
  };
}

function normalizeBoundsForOverlay(bounds, videoElement) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && width >= 0 && width <= 1 && height >= 0 && height <= 1) {
    return {
      x: clamp01(x),
      y: clamp01(y),
      width: clamp01(width),
      height: clamp01(height)
    };
  }

  const videoWidth = Number(videoElement?.videoWidth || 0);
  const videoHeight = Number(videoElement?.videoHeight || 0);
  if (videoWidth <= 0 || videoHeight <= 0) {
    return null;
  }

  return {
    x: clamp01(x / videoWidth),
    y: clamp01(y / videoHeight),
    width: clamp01(width / videoWidth),
    height: clamp01(height / videoHeight)
  };
}

export function useViewerConnection() {
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const hasRemoteDescriptionRef = useRef(false);
  const publisherIdRef = useRef(null);
  const videoRef = useRef(null);

  const [config, setConfig] = useState({
    serverUrl: typeof window === 'undefined' ? '' : window.location.origin,
    roomId: 'demo-room',
    token: ''
  });
  const [state, setState] = useState({
    connected: false,
    connectionText: '未连接',
    publisherText: '未检测到',
    executorText: '未检测到',
    rtcText: '未建立',
    viewerCount: 0,
    lastFrameMeta: '暂无',
    isLive: false,
    roomHasPublisher: false,
    roomHasExecutor: false,
    debugLines: [],
    automationLines: [],
    overlayItems: [],
    automationState: '自动化未运行',
    isExecutionRunning: false,
    activeExecutionSessionId: null,
    lastExecutorRequest: '暂无',
    lastExecutorResult: '暂无',
    roomTitle: '房间 demo-room',
    errorText: ''
  });
  const [remoteStream, setRemoteStream] = useState(null);

  const appendDebug = useCallback((message, payload) => {
    setState((current) => ({
      ...current,
      debugLines: appendLine(current.debugLines, timeLine(message, payload), 60)
    }));
  }, []);

  const appendAutomation = useCallback((message) => {
    setState((current) => ({
      ...current,
      automationLines: appendLine(current.automationLines, timeLine(message), 50)
    }));
  }, []);

  const appendOverlayItems = useCallback((items) => {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    setState((current) => ({
      ...current,
      overlayItems: [...current.overlayItems, ...items].slice(-MAX_OVERLAY_ITEMS)
    }));
  }, []);

  const clearOverlay = useCallback(() => {
    setState((current) => ({
      ...current,
      overlayItems: []
    }));
  }, []);

  const resetVideo = useCallback(() => {
    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.pause();
      videoElement.removeAttribute('src');
      videoElement.srcObject = null;
    }

    remoteStreamRef.current = null;
    setRemoteStream(null);
    setState((current) => ({
      ...current,
      lastFrameMeta: '暂无',
      isLive: false,
      overlayItems: []
    }));
  }, []);

  const closePeerConnection = useCallback(() => {
    const peerConnection = peerConnectionRef.current;
    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.ontrack = null;
      peerConnection.close();
      peerConnectionRef.current = null;
    }

    hasRemoteDescriptionRef.current = false;
    pendingCandidatesRef.current = [];
    resetVideo();
    setState((current) => ({
      ...current,
      rtcText: '未建立'
    }));
  }, [resetVideo]);

  const disconnect = useCallback(() => {
    closePeerConnection();

    const socket = socketRef.current;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      socketRef.current = null;
    }

    publisherIdRef.current = null;
    setState((current) => ({
      ...current,
      connected: false,
      connectionText: '已断开',
      publisherText: '未检测到',
      executorText: '未检测到',
      viewerCount: 0,
      roomHasPublisher: false,
      roomHasExecutor: false,
      overlayItems: [],
      automationState: '自动化未运行',
      isExecutionRunning: false,
      activeExecutionSessionId: null,
      lastExecutorRequest: '暂无',
      lastExecutorResult: '暂无'
    }));
  }, [closePeerConnection]);

  const sendJsonMessage = useCallback((payload, summary) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const message = 'WebSocket 尚未连接';
      setState((current) => ({
        ...current,
        errorText: message,
        connectionText: current.connected ? current.connectionText : '未连接'
      }));
      appendDebug(summary || '发送消息失败', { reason: message, payload });
      return { ok: false, error: message };
    }

    socket.send(JSON.stringify(payload));
    appendDebug(summary || '发送消息', payload);
    return { ok: true };
  }, [appendDebug]);

  const startAutomation = useCallback((packageId, revision) => {
    const normalizedPackageId = String(packageId || '').trim();
    const normalizedRevision = Number(revision);
    if (!normalizedPackageId || !Number.isInteger(normalizedRevision) || normalizedRevision < 1) {
      return { ok: false, error: '请选择有效的方案和 revision' };
    }

    const result = sendJsonMessage(
      { type: 'automation_start', packageId: normalizedPackageId, revision: normalizedRevision },
      '发送 automation_start'
    );

    if (result.ok) {
      setState((current) => ({
        ...current,
        automationState: `已请求启动 ${normalizedPackageId} r${normalizedRevision}`,
        lastExecutorRequest: `automation_start ${normalizedPackageId} r${normalizedRevision}`,
        errorText: ''
      }));
      appendAutomation(`start ${normalizedPackageId} r${normalizedRevision}`);
    }

    return result;
  }, [appendAutomation, sendJsonMessage]);

  const stopAutomation = useCallback(() => {
    const result = sendJsonMessage(
      { type: 'automation_stop', sessionId: state.activeExecutionSessionId || null },
      '发送 automation_stop'
    );

    if (result.ok) {
      setState((current) => ({
        ...current,
        automationState: '已请求停止执行',
        errorText: ''
      }));
      appendAutomation('stop requested');
    }

    return result;
  }, [appendAutomation, sendJsonMessage, state.activeExecutionSessionId]);

  const sendSignal = useCallback((targetId, signal) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendDebug('signal 发送失败，WebSocket 未连接', { targetId, signalType: signal.type });
      return;
    }

    socket.send(JSON.stringify({ type: 'signal', targetId, signal }));
    appendDebug('发送 signal', { targetId, signalType: signal.type });
  }, [appendDebug]);

  const flushPendingCandidates = useCallback(async () => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection || !hasRemoteDescriptionRef.current) {
      return;
    }

    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift();
      await peerConnection.addIceCandidate(candidate);
    }
  }, []);

  const ensurePeerConnection = useCallback((publisherId) => {
    if (peerConnectionRef.current && publisherIdRef.current === publisherId) {
      return peerConnectionRef.current;
    }

    closePeerConnection();
    publisherIdRef.current = publisherId;
    appendDebug('创建新的 PeerConnection', { publisherId });

    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || !publisherIdRef.current) {
        return;
      }

      sendSignal(publisherIdRef.current, {
        type: 'candidate',
        candidate: event.candidate.toJSON()
      });
    };

    peerConnection.ontrack = (event) => {
      const nextRemoteStream = event.streams[0] || new MediaStream([event.track]);
      remoteStreamRef.current = nextRemoteStream;
      setRemoteStream(nextRemoteStream);
      setState((current) => ({
        ...current,
        publisherText: '已连接',
        rtcText: '视频轨道已连接'
      }));

      appendDebug('收到远端视频轨道', {
        trackId: event.track.id,
        kind: event.track.kind,
        streamId: nextRemoteStream.id
      });

      event.track.onunmute = () => {
        setState((current) => ({ ...current, isLive: true }));
        appendDebug('远端视频轨道解除静音', { trackId: event.track.id });
      };

      event.track.onmute = () => {
        setState((current) => ({ ...current, isLive: false }));
        appendDebug('远端视频轨道静音', { trackId: event.track.id });
      };

      event.track.onended = () => {
        setState((current) => ({ ...current, isLive: false }));
        appendDebug('远端视频轨道结束', { trackId: event.track.id });
      };
    };

    peerConnection.onconnectionstatechange = () => {
      const connectionState = peerConnection.connectionState;
      const labelMap = {
        new: '准备中',
        connecting: '连接中',
        connected: '已连接',
        disconnected: '已断开',
        failed: '失败',
        closed: '已关闭'
      };

      setState((current) => ({
        ...current,
        rtcText: labelMap[connectionState] || connectionState,
        isLive: ['failed', 'disconnected', 'closed'].includes(connectionState) ? false : current.isLive
      }));
      appendDebug('PeerConnection 状态变化', { state: connectionState });
    };

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  }, [appendDebug, closePeerConnection, sendSignal]);

  const connect = useCallback(() => {
    const serverUrl = normalizeBaseUrl(config.serverUrl);
    const roomId = String(config.roomId || '').trim() || 'demo-room';
    const token = String(config.token || '').trim();

    disconnect();
    setState((current) => ({
      ...current,
      debugLines: [],
      automationLines: [],
      overlayItems: [],
      isLive: false,
      connectionText: '信令连接中',
      publisherText: '未检测到',
      executorText: '未检测到',
      rtcText: '等待信令',
      roomTitle: `房间 ${roomId}`,
      errorText: ''
    }));

    const signalUrl = buildClientSocketUrl(serverUrl, { clientType: 'viewer', roomId, token });
    const socket = new WebSocket(signalUrl);
    socketRef.current = socket;
    appendDebug('准备连接信令服务', { url: signalUrl, roomId, hasToken: Boolean(token) });

    socket.onopen = () => {
      setState((current) => ({
        ...current,
        connected: true,
        connectionText: '信令已连接'
      }));
      appendDebug('Signaling WebSocket 已打开');
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      appendDebug('收到服务端消息', {
        type: message.type,
        signalType: message.signal?.type,
        sourceId: message.sourceId,
        publisherId: message.publisherId
      });

      if (message.type === 'automation_event') {
        const eventPayload = message.event || {};
        const eventType = eventPayload.type || 'unknown';
        const overlayElements = [];
        const videoElement = videoRef.current;

        if (eventType === 'tap') {
          const point = normalizePointForOverlay(eventPayload.point, videoElement);
          if (point) {
            overlayElements.push({ kind: 'point', point, label: eventPayload.stepId || 'tap' });
          }
        } else if (eventType === 'drag') {
          const from = normalizePointForOverlay(eventPayload.from, videoElement);
          const to = normalizePointForOverlay(eventPayload.to, videoElement);
          if (from && to) {
            overlayElements.push({ kind: 'drag', from, to, label: eventPayload.stepId || 'drag' });
          }
        } else if (eventType === 'match') {
          const point = normalizePointForOverlay(eventPayload.point, videoElement);
          if (point) {
            overlayElements.push({ kind: 'point', point, label: eventPayload.stepId || 'match' });
          }
        }

        if (overlayElements.length > 0) {
          appendOverlayItems(overlayElements);
        }

        setState((current) => ({
          ...current,
          automationState: eventType === 'error'
            ? `错误: ${eventPayload.message || eventPayload.stepId || 'automation'}`
            : `${eventType}${eventPayload.stepId ? ` / ${eventPayload.stepId}` : ''}`
        }));
        appendAutomation(`event ${eventType} ${eventPayload.stepId || ''} ${eventPayload.message || ''}`.trim());
        return;
      }

      if (message.type === 'automation_status') {
        const isExecutionRunning = ['starting', 'running', 'polling', 'matched'].includes(message.status);
        const hasFinished = ['stopped', 'completed', 'error'].includes(message.status);
        const summary = message.summary || message.status || '自动化运行中';
        const detail = message.detail;
        const overlayElements = [];
        const videoElement = videoRef.current;

        if (message.status === 'matched' && detail && typeof detail === 'object') {
          const point = normalizePointForOverlay(detail.point, videoElement);
          const bounds = normalizeBoundsForOverlay(detail.bounds || detail?.payload?.bestImageMatch?.bounds, videoElement);
          if (point) {
            overlayElements.push({ kind: 'point', point, label: `${message.stepId || 'match'} 命中` });
          }
          if (bounds) {
            overlayElements.push({ kind: 'rect', bounds, label: `${message.stepId || 'match'} 匹配框` });
          }
        }

        if (overlayElements.length > 0) {
          appendOverlayItems(overlayElements);
        }

        setState((current) => ({
          ...current,
          automationState: summary,
          isExecutionRunning: hasFinished ? false : (isExecutionRunning || current.isExecutionRunning),
          activeExecutionSessionId: message.sessionId || (hasFinished ? null : current.activeExecutionSessionId),
          errorText: message.status === 'error' ? message.message || summary : current.errorText
        }));
        appendAutomation(`status ${message.status || 'unknown'} ${summary}`.trim());
        return;
      }

      if (message.type === 'automation_action') {
        const overlayElements = [];
        const videoElement = videoRef.current;
        if (message.action === 'tap') {
          const point = normalizePointForOverlay(message.command?.framePoint, videoElement);
          if (point) {
            overlayElements.push({ kind: 'point', point, label: `${message.stepId || 'tap'} 目标` });
          }
        } else if (message.action === 'drag') {
          const from = normalizePointForOverlay(message.command?.frameFrom, videoElement);
          const to = normalizePointForOverlay(message.command?.frameTo, videoElement);
          if (from && to) {
            overlayElements.push({ kind: 'drag', from, to, label: `${message.stepId || 'drag'} 目标` });
          }
        }

        if (overlayElements.length > 0) {
          appendOverlayItems(overlayElements);
        }

        setState((current) => ({
          ...current,
          lastExecutorRequest: describeAction(message)
        }));
        appendAutomation(`action ${describeAction(message)}`);
        return;
      }

      if (message.type === 'executor_result') {
        setState((current) => ({
          ...current,
          lastExecutorResult: describeExecutorResult(message)
        }));
        appendAutomation(`executor ${describeExecutorResult(message)}`);
        return;
      }

      if (message.type === 'room_state') {
        const hasPublisher = Boolean(message.hasPublisher);
        const hasExecutor = Boolean(message.hasExecutor);
        if (!hasPublisher) {
          closePeerConnection();
        }
        if (message.publisherId) {
          publisherIdRef.current = message.publisherId;
        }
        setState((current) => ({
          ...current,
          roomHasPublisher: hasPublisher,
          roomHasExecutor: hasExecutor,
          publisherText: hasPublisher ? '已连接' : '未检测到',
          executorText: hasExecutor ? '已连接' : '未检测到',
          viewerCount: Number(message.viewerCount || 0)
        }));
        return;
      }

      if (message.type === 'viewer_ready') {
        publisherIdRef.current = message.publisherId || null;
        setState((current) => ({
          ...current,
          roomHasPublisher: Boolean(message.hasPublisher),
          roomHasExecutor: Boolean(message.hasExecutor),
          publisherText: message.hasPublisher ? '已连接' : '未检测到',
          executorText: message.hasExecutor ? '已连接' : '未检测到',
          viewerCount: Number(message.viewerCount || 0),
          rtcText: message.hasPublisher ? '等待视频 offer' : '等待发布端'
        }));
        return;
      }

      if (message.type === 'signal') {
        publisherIdRef.current = message.sourceId;
        if (message.signal.type === 'offer') {
          const peerConnection = ensurePeerConnection(message.sourceId);
          await peerConnection.setRemoteDescription({ type: 'offer', sdp: message.signal.sdp });
          hasRemoteDescriptionRef.current = true;
          await flushPendingCandidates();
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          sendSignal(message.sourceId, { type: 'answer', sdp: answer.sdp });
          setState((current) => ({ ...current, rtcText: '已发送 answer，等待视频流' }));
          return;
        }

        if (message.signal.type === 'candidate') {
          const candidate = new RTCIceCandidate(message.signal.candidate);
          if (peerConnectionRef.current && hasRemoteDescriptionRef.current) {
            await peerConnectionRef.current.addIceCandidate(candidate);
          } else {
            pendingCandidatesRef.current.push(candidate);
          }
        }
        return;
      }

      if (message.type === 'publisher_left') {
        closePeerConnection();
        publisherIdRef.current = null;
        setState((current) => ({
          ...current,
          publisherText: '未检测到',
          isLive: false
        }));
        return;
      }

      if (message.type === 'warning') {
        const warningMessage = message.message || 'Unknown warning';
        setState((current) => ({
          ...current,
          errorText: warningMessage
        }));
        appendDebug('收到 warning', { message: warningMessage });
        return;
      }

      if (message.type === 'error') {
        setState((current) => ({
          ...current,
          connectionText: `错误: ${message.message}`,
          errorText: message.message || 'Unknown error'
        }));
      }
    };

    socket.onerror = (event) => {
      setState((current) => ({ ...current, connectionText: '信令异常' }));
      appendDebug('Signaling WebSocket 异常', { type: event.type });
    };

    socket.onclose = () => {
      closePeerConnection();
      publisherIdRef.current = null;
      setState((current) => ({
        ...current,
        connected: false,
        connectionText: '已断开',
        publisherText: '未检测到',
        executorText: '未检测到',
        roomHasPublisher: false,
        roomHasExecutor: false,
        viewerCount: 0,
        isLive: false,
        automationState: '自动化未运行'
      }));
      appendDebug('Signaling WebSocket 已断开');
    };
  }, [appendAutomation, appendDebug, closePeerConnection, config, disconnect, ensurePeerConnection, flushPendingCandidates, sendSignal]);

  useEffect(() => () => disconnect(), [disconnect]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return undefined;
    }

    async function attemptPlayback(reason) {
      try {
        await videoElement.play();
      } catch (error) {
        appendDebug('video.play 失败', { reason, message: error.message });
      }
    }

    function updateVideoMeta() {
      const width = videoElement.videoWidth || '?';
      const height = videoElement.videoHeight || '?';
      setState((current) => ({
        ...current,
        lastFrameMeta: `${width} x ${height} / ${new Date().toLocaleTimeString('zh-CN')}`
      }));
    }

    function handleLoadedMetadata() {
      updateVideoMeta();
      appendDebug('视频元数据已加载', { width: videoElement.videoWidth, height: videoElement.videoHeight });
      attemptPlayback('loadedmetadata');
    }

    function handleResize() {
      updateVideoMeta();
      appendDebug('远端视频尺寸变化', { width: videoElement.videoWidth, height: videoElement.videoHeight });
    }

    function handlePlaying() {
      setState((current) => ({ ...current, isLive: true }));
      updateVideoMeta();
      appendDebug('远端视频开始播放');
    }

    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('resize', handleResize);
    videoElement.addEventListener('playing', handlePlaying);

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('resize', handleResize);
      videoElement.removeEventListener('playing', handlePlaying);
    };
  }, [appendDebug]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    if (!remoteStream) {
      videoElement.pause();
      videoElement.removeAttribute('src');
      videoElement.srcObject = null;
      return;
    }

    videoElement.srcObject = remoteStream;
    videoElement.play().catch((error) => {
      appendDebug('video.play 失败', { reason: 'track-attached', message: error.message });
    });
  }, [appendDebug, remoteStream]);

  const updateConfig = useCallback((key, value) => {
    setConfig((current) => ({ ...current, [key]: value }));
  }, []);

  return {
    ...state,
    serverUrl: config.serverUrl,
    roomId: config.roomId,
    token: config.token,
    normalizedServerUrl: normalizeBaseUrl(config.serverUrl),
    remoteStream,
    videoRef,
    connect,
    disconnect,
    updateConfig,
    startAutomation,
    stopAutomation,
    clearOverlay
  };
}