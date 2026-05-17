import { useEffect, useMemo, useRef, useState } from 'react';
import { useAutomationPackages } from '../hooks/useAutomationPackages';
import { useHealth } from '../hooks/useHealth';
import { useViewerConnection } from '../hooks/useViewerConnection';
import { buildHttpUrl } from '../lib/network';

const STEP_TYPE_OPTIONS = [
  { value: 'waitForText', label: '按文字识别' },
  { value: 'waitForImage', label: '按图片识别' },
  { value: 'loopUntilText', label: '循环查文字直到命中' },
  { value: 'loopUntilImage', label: '循环查图片直到命中' },
  { value: 'tap', label: '点击' },
  { value: 'drag', label: '按下移动抬起' }
];

const STEP_TYPE_LABELS = {
  waitForText: '查文字',
  waitForImage: '查图片',
  loopUntilText: '循环查文字',
  loopUntilImage: '循环查图片',
  tap: '点击',
  drag: '拖拽'
};

const INITIAL_EDITOR_DRAFT = {
  packageId: 'demo',
  name: 'Demo Flow',
  steps: [],
  images: []
};

const INITIAL_CROP = {
  x: 0.35,
  y: 0.35,
  width: 0.3,
  height: 0.18
};

const INITIAL_STEP_FORM = {
  type: 'waitForText',
  id: '',
  queryText: '',
  assetId: '',
  saveAs: '',
  threshold: '0.84',
  timeoutMs: '10000',
  pollIntervalMs: '500',
  loopActionType: 'tap',
  targetRef: '',
  targetX: '',
  targetY: '',
  targetOffsetX: '0',
  targetOffsetY: '0',
  fromRef: '',
  fromX: '',
  fromY: '',
  fromOffsetX: '0',
  fromOffsetY: '0',
  toRef: '',
  toX: '',
  toY: '',
  toOffsetX: '0',
  toOffsetY: '0',
  holdMs: '120',
  durationMs: '450'
};

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isTextWaitType(type) {
  return type === 'waitForText' || type === 'loopUntilText';
}

function isImageWaitType(type) {
  return type === 'waitForImage' || type === 'loopUntilImage';
}

function isLoopType(type) {
  return type === 'loopUntilText' || type === 'loopUntilImage';
}

function formatTimestamp(value) {
  if (!value) {
    return '未记录';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN');
}

function parseQueryList(rawValue) {
  return String(rawValue || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readNumber(value, fallback) {
  const parsed = parseOptionalNumber(value);
  return parsed == null ? fallback : parsed;
}

function normalizeIdentifier(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function isValidPackageId(value) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(value || '').trim());
}

function formatTargetSummary(target) {
  if (!target) {
    return '未配置';
  }

  const segments = [];
  if (target.ref) {
    segments.push(`ref ${target.ref}`);
  } else if (Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y))) {
    segments.push(`(${Number(target.x).toFixed(0)}, ${Number(target.y).toFixed(0)}) px`);
  }

  const offsetX = Number(target.offsetX);
  const offsetY = Number(target.offsetY);
  if (Number.isFinite(offsetX) || Number.isFinite(offsetY)) {
    segments.push(`偏移 (${Number.isFinite(offsetX) ? offsetX.toFixed(0) : '0'}, ${Number.isFinite(offsetY) ? offsetY.toFixed(0) : '0'}) px`);
  }

  return segments.join(' / ') || '未配置';
}

function formatStepSummary(step) {
  if (!step) {
    return '无';
  }

  if (step.type === 'waitForText' || step.type === 'loopUntilText') {
    return [step.query, ...(step.queryOptions || [])].filter(Boolean).join(' / ');
  }

  if (step.type === 'waitForImage' || step.type === 'loopUntilImage') {
    return step.assetId || '未绑定图片';
  }

  if (step.type === 'tap') {
    return formatTargetSummary(step.target);
  }

  if (step.type === 'drag') {
    return `${formatTargetSummary(step.from)} -> ${formatTargetSummary(step.to)}`;
  }

  return step.type;
}

function buildStepDetailLines(step) {
  const lines = [];

  if (isTextWaitType(step.type)) {
    const queries = [step.query, ...(step.queryOptions || [])].filter(Boolean);
    lines.push(`查询: ${queries.length > 0 ? queries.join(' | ') : '未配置'}`);
    lines.push(`匹配: ${step.match || 'contains'} / 超时 ${Number(step.timeoutMs || 10000)} ms / 轮询 ${Number(step.pollIntervalMs || 500)} ms`);
    if (step.saveAs) {
      lines.push(`保存命中点: ${step.saveAs}`);
    }
  }

  if (isImageWaitType(step.type)) {
    lines.push(`模板: ${step.assetId || '未配置'} / 阈值 ${Number(step.threshold ?? 0.84).toFixed(2)}`);
    lines.push(`超时 ${Number(step.timeoutMs || 10000)} ms / 轮询 ${Number(step.pollIntervalMs || 500)} ms`);
    if (step.saveAs) {
      lines.push(`保存命中点: ${step.saveAs}`);
    }
  }

  if (step.type === 'tap') {
    lines.push(`点击目标: ${formatTargetSummary(step.target)}`);
  }

  if (step.type === 'drag') {
    lines.push(`起点: ${formatTargetSummary(step.from)}`);
    lines.push(`终点: ${formatTargetSummary(step.to)}`);
    lines.push(`hold ${Number(step.holdMs || 120)} ms / drag ${Number(step.durationMs || 450)} ms`);
  }

  if (isLoopType(step.type) && step.action) {
    lines.push(`loop 动作: ${STEP_TYPE_LABELS[step.action.type] || step.action.type}`);
    if (step.action.type === 'tap') {
      lines.push(`loop 目标: ${formatTargetSummary(step.action.target)}`);
    }
    if (step.action.type === 'drag') {
      lines.push(`loop 起点: ${formatTargetSummary(step.action.from)}`);
      lines.push(`loop 终点: ${formatTargetSummary(step.action.to)}`);
      lines.push(`loop hold ${Number(step.action.holdMs || 120)} ms / drag ${Number(step.action.durationMs || 450)} ms`);
    }
  }

  return lines;
}

function getPreferredRevision(entry) {
  if (!entry) {
    return '';
  }

  return String(entry.activeRevision || entry.latestRevision || entry.revisions?.[0]?.revision || '');
}

function createTarget(refValue, xValue, yValue, offsetXValue, offsetYValue) {
  const ref = String(refValue || '').trim();
  const offsetX = parseOptionalNumber(offsetXValue) ?? 0;
  const offsetY = parseOptionalNumber(offsetYValue) ?? 0;

  if (ref) {
    return {
      ref,
      ...(offsetX ? { offsetX } : {}),
      ...(offsetY ? { offsetY } : {})
    };
  }

  const x = parseOptionalNumber(xValue);
  const y = parseOptionalNumber(yValue);
  if (x == null || y == null) {
    return null;
  }

  return {
    x,
    y,
    ...(offsetX ? { offsetX } : {}),
    ...(offsetY ? { offsetY } : {})
  };
}

function buildStepFromForm(stepForm, currentStepCount) {
  const type = stepForm.type;
  const id = String(stepForm.id || '').trim() || `${type}-${currentStepCount + 1}`;

  if (isTextWaitType(type)) {
    const queries = parseQueryList(stepForm.queryText);
    if (queries.length === 0) {
      return { error: '至少填写一个查询词' };
    }

    const step = {
      id,
      type,
      query: queries[0],
      ...(queries.length > 1 ? { queryOptions: queries } : {}),
      match: 'contains',
      timeoutMs: readNumber(stepForm.timeoutMs, 10000),
      pollIntervalMs: readNumber(stepForm.pollIntervalMs, 500),
      region: null,
      saveAs: String(stepForm.saveAs || '').trim() || `${id}-target`
    };

    if (isLoopType(type)) {
      if (stepForm.loopActionType === 'drag') {
        const from = createTarget(stepForm.fromRef, stepForm.fromX, stepForm.fromY, stepForm.fromOffsetX, stepForm.fromOffsetY);
        const to = createTarget(stepForm.toRef, stepForm.toX, stepForm.toY, stepForm.toOffsetX, stepForm.toOffsetY);
        if (!from || !to) {
          return { error: 'loop 拖拽需要填写起点和终点的引用或像素坐标' };
        }

        step.action = {
          type: 'drag',
          from,
          to,
          holdMs: readNumber(stepForm.holdMs, 120),
          durationMs: readNumber(stepForm.durationMs, 450)
        };
      } else {
        const target = createTarget(stepForm.targetRef, stepForm.targetX, stepForm.targetY, stepForm.targetOffsetX, stepForm.targetOffsetY);
        if (!target) {
          return { error: 'loop 点击需要填写目标引用或像素坐标' };
        }

        step.action = {
          type: 'tap',
          target
        };
      }
    }

    return { step };
  }

  if (isImageWaitType(type)) {
    const assetId = normalizeIdentifier(stepForm.assetId, 'asset');
    const step = {
      id,
      type,
      assetId,
      threshold: readNumber(stepForm.threshold, 0.84),
      timeoutMs: readNumber(stepForm.timeoutMs, 10000),
      pollIntervalMs: readNumber(stepForm.pollIntervalMs, 500),
      region: null,
      saveAs: String(stepForm.saveAs || '').trim() || `${id}-target`
    };

    if (isLoopType(type)) {
      if (stepForm.loopActionType === 'drag') {
        const from = createTarget(stepForm.fromRef, stepForm.fromX, stepForm.fromY, stepForm.fromOffsetX, stepForm.fromOffsetY);
        const to = createTarget(stepForm.toRef, stepForm.toX, stepForm.toY, stepForm.toOffsetX, stepForm.toOffsetY);
        if (!from || !to) {
          return { error: 'loop 拖拽需要填写起点和终点的引用或像素坐标' };
        }

        step.action = {
          type: 'drag',
          from,
          to,
          holdMs: readNumber(stepForm.holdMs, 120),
          durationMs: readNumber(stepForm.durationMs, 450)
        };
      } else {
        const target = createTarget(stepForm.targetRef, stepForm.targetX, stepForm.targetY, stepForm.targetOffsetX, stepForm.targetOffsetY);
        if (!target) {
          return { error: 'loop 点击需要填写目标引用或像素坐标' };
        }

        step.action = {
          type: 'tap',
          target
        };
      }
    }

    return { step };
  }

  if (type === 'tap') {
    const target = createTarget(stepForm.targetRef, stepForm.targetX, stepForm.targetY, stepForm.targetOffsetX, stepForm.targetOffsetY);
    if (!target) {
      return { error: '点击步骤需要填写目标引用或像素坐标' };
    }

    return {
      step: {
        id,
        type,
        target
      }
    };
  }

  const from = createTarget(stepForm.fromRef, stepForm.fromX, stepForm.fromY, stepForm.fromOffsetX, stepForm.fromOffsetY);
  const to = createTarget(stepForm.toRef, stepForm.toX, stepForm.toY, stepForm.toOffsetX, stepForm.toOffsetY);
  if (!from || !to) {
    return { error: '拖拽步骤需要填写起点和终点的引用或像素坐标' };
  }

  return {
    step: {
      id,
      type,
      from,
      to,
      holdMs: readNumber(stepForm.holdMs, 120),
      durationMs: readNumber(stepForm.durationMs, 450)
    }
  };
}

function buildAutomationDocument(editorDraft) {
  return {
    schemaVersion: 1,
    packageId: String(editorDraft.packageId || '').trim(),
    revision: 0,
    name: String(editorDraft.name || '').trim() || String(editorDraft.packageId || '').trim() || 'Demo Flow',
    steps: cloneValue(editorDraft.steps)
  };
}

function buildDraftFromDetail(detail) {
  const automation = detail?.automation || {};
  return {
    packageId: automation.packageId || detail?.packageId || 'demo',
    name: automation.name || detail?.packageId || 'Demo Flow',
    steps: cloneValue(Array.isArray(automation.steps) ? automation.steps : []),
    images: cloneValue(Array.isArray(detail?.images) ? detail.images : [])
  };
}

function createNextAssetId(images, rawBase) {
  const base = normalizeIdentifier(rawBase, `asset-${images.length + 1}`);
  let candidate = base;
  let suffix = 2;
  while (images.some((asset) => asset.assetId === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function convertImageToPng(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('无法创建图片上下文'));
        return;
      }

      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataUrl;
  });
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(1, number));
}

function formatCropValue(value) {
  return Number(value.toFixed(3)).toString();
}

function clampCrop(nextCrop) {
  const minSize = 0.02;
  const width = Math.max(minSize, Math.min(1, Number(nextCrop.width) || minSize));
  const height = Math.max(minSize, Math.min(1, Number(nextCrop.height) || minSize));
  const x = Math.max(0, Math.min(1 - width, Number(nextCrop.x) || 0));
  const y = Math.max(0, Math.min(1 - height, Number(nextCrop.y) || 0));

  return { x, y, width, height };
}

function cropFromPointerDrag(drag, event) {
  if (!drag) {
    return null;
  }

  const dx = (event.clientX - drag.startClientX) / Math.max(1, drag.shellRect.width);
  const dy = (event.clientY - drag.startClientY) / Math.max(1, drag.shellRect.height);
  const start = drag.startCrop;
  const handle = drag.handle;
  const minSize = 0.02;
  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;

  if (handle === 'move') {
    return clampCrop({
      x: start.x + dx,
      y: start.y + dy,
      width,
      height
    });
  }

  if (handle.includes('e')) {
    width = Math.max(minSize, Math.min(1 - start.x, start.width + dx));
  }
  if (handle.includes('s')) {
    height = Math.max(minSize, Math.min(1 - start.y, start.height + dy));
  }
  if (handle.includes('w')) {
    x = Math.max(0, Math.min(start.x + start.width - minSize, start.x + dx));
    width = Math.max(minSize, start.x + start.width - x);
  }
  if (handle.includes('n')) {
    y = Math.max(0, Math.min(start.y + start.height - minSize, start.y + dy));
    height = Math.max(minSize, start.y + start.height - y);
  }

  return clampCrop({ x, y, width, height });
}

export function WorkbenchPage() {
  const viewer = useViewerConnection();
  const { data: health, loading: healthLoading, error: healthError } = useHealth(viewer.normalizedServerUrl);
  const {
    packages,
    loading: packagesLoading,
    error: packagesError,
    detail,
    detailLoading,
    detailError,
    selectPackage,
    refreshPackages,
    publishPackage
  } = useAutomationPackages(viewer.normalizedServerUrl);

  const [executionSelection, setExecutionSelection] = useState({ packageId: '', revision: '' });
  const [editorDraft, setEditorDraft] = useState(INITIAL_EDITOR_DRAFT);
  const [stepForm, setStepForm] = useState(INITIAL_STEP_FORM);
  const [assetDraftId, setAssetDraftId] = useState('');
  const [executionMessage, setExecutionMessage] = useState('未开始执行');
  const [editorStatus, setEditorStatus] = useState('可从右侧选中 revision 载入，也可以直接新建流程');
  const [publishStatus, setPublishStatus] = useState('编辑完成后可发布为新的 revision');
  const [publishDownloadUrl, setPublishDownloadUrl] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRefreshingPackages, setIsRefreshingPackages] = useState(false);
  const [crop, setCrop] = useState(INITIAL_CROP);
  const [overlaySize, setOverlaySize] = useState({ width: 0, height: 0 });

  const videoShellRef = useRef(null);
  const cropDragRef = useRef(null);

  const selectedPackage = useMemo(
    () => packages.find((entry) => entry.packageId === executionSelection.packageId) || null,
    [executionSelection.packageId, packages]
  );

  const selectedRevisions = useMemo(() => {
    if (!selectedPackage?.revisions) {
      return [];
    }

    return [...selectedPackage.revisions].sort((first, second) => second.revision - first.revision);
  }, [selectedPackage]);

  useEffect(() => {
    if (packages.length === 0) {
      return;
    }

    setExecutionSelection((current) => {
      const existingPackage = packages.find((entry) => entry.packageId === current.packageId);
      if (existingPackage) {
        return current;
      }

      const nextPackage = packages[0];
      return {
        packageId: nextPackage.packageId,
        revision: getPreferredRevision(nextPackage)
      };
    });
  }, [packages]);

  useEffect(() => {
    if (!selectedPackage) {
      return;
    }

    const preferredRevision = executionSelection.revision
      && selectedRevisions.some((entry) => String(entry.revision) === executionSelection.revision)
      ? executionSelection.revision
      : getPreferredRevision(selectedPackage);

    if (preferredRevision !== executionSelection.revision) {
      setExecutionSelection((current) => ({
        ...current,
        revision: preferredRevision
      }));
    }
  }, [executionSelection.revision, selectedPackage, selectedRevisions]);

  useEffect(() => {
    if (!executionSelection.packageId || !executionSelection.revision) {
      return;
    }

    selectPackage(executionSelection.packageId, executionSelection.revision);
  }, [executionSelection.packageId, executionSelection.revision, selectPackage]);

  const canStartExecution = viewer.connected
    && viewer.roomHasPublisher
    && viewer.roomHasExecutor
    && Boolean(executionSelection.packageId)
    && Boolean(executionSelection.revision)
    && !viewer.isExecutionRunning;

  const executionPrerequisite = useMemo(() => {
    if (!viewer.connected) {
      return '先连接查看端';
    }
    if (!viewer.roomHasPublisher) {
      return '等待 publisher 连接';
    }
    if (!viewer.roomHasExecutor) {
      return '等待 executor 连接';
    }
    if (!executionSelection.packageId || !executionSelection.revision) {
      return '选择可执行方案与 revision';
    }
    if (viewer.isExecutionRunning) {
      return '当前会话执行中';
    }
    return '执行条件已满足';
  }, [executionSelection.packageId, executionSelection.revision, viewer.connected, viewer.isExecutionRunning, viewer.roomHasExecutor, viewer.roomHasPublisher]);

  const editorPreview = useMemo(
    () => JSON.stringify(buildAutomationDocument(editorDraft), null, 2),
    [editorDraft]
  );

  const overlayElements = useMemo(() => viewer.overlayItems.flatMap((item, index) => {
    if (item.kind === 'point') {
      const point = item.point;
      return [
        <div
          key={`marker-${index}`}
          className="overlay-marker-react"
          style={{ left: `${clamp01(point.x) * 100}%`, top: `${clamp01(point.y) * 100}%` }}
        />,
        <div
          key={`label-${index}`}
          className="overlay-label-react"
          style={{ left: `${clamp01(point.x) * 100}%`, top: `${clamp01(point.y) * 100}%` }}
        >
          {item.label}
        </div>
      ];
    }

    if (item.kind === 'rect') {
      const bounds = item.bounds;
      const centerX = clamp01(bounds.x + bounds.width / 2);
      const centerY = clamp01(bounds.y + bounds.height / 2);
      return [
        <div
          key={`rect-${index}`}
          className="overlay-rect-react"
          style={{
            left: `${clamp01(bounds.x) * 100}%`,
            top: `${clamp01(bounds.y) * 100}%`,
            width: `${clamp01(bounds.width) * 100}%`,
            height: `${clamp01(bounds.height) * 100}%`
          }}
        />,
        <div
          key={`rect-center-${index}`}
          className="overlay-marker-react"
          style={{ left: `${centerX * 100}%`, top: `${centerY * 100}%` }}
        />,
        <div
          key={`rect-label-${index}`}
          className="overlay-label-react"
          style={{ left: `${centerX * 100}%`, top: `${centerY * 100}%` }}
        >
          {item.label}
        </div>
      ];
    }

    if (item.kind === 'drag' && overlaySize.width > 0 && overlaySize.height > 0) {
      const x1 = clamp01(item.from.x) * overlaySize.width;
      const y1 = clamp01(item.from.y) * overlaySize.height;
      const x2 = clamp01(item.to.x) * overlaySize.width;
      const y2 = clamp01(item.to.y) * overlaySize.height;
      const dx = x2 - x1;
      const dy = y2 - y1;
      return [
        <div
          key={`line-${index}`}
          className="overlay-line-react"
          style={{
            left: `${x1}px`,
            top: `${y1}px`,
            width: `${Math.hypot(dx, dy)}px`,
            transform: `rotate(${Math.atan2(dy, dx)}rad)`
          }}
        />,
        <div
          key={`from-${index}`}
          className="overlay-marker-react"
          style={{ left: `${clamp01(item.from.x) * 100}%`, top: `${clamp01(item.from.y) * 100}%` }}
        />,
        <div
          key={`from-label-${index}`}
          className="overlay-label-react"
          style={{ left: `${clamp01(item.from.x) * 100}%`, top: `${clamp01(item.from.y) * 100}%` }}
        >
          {item.label} 起点
        </div>,
        <div
          key={`to-${index}`}
          className="overlay-marker-react"
          style={{ left: `${clamp01(item.to.x) * 100}%`, top: `${clamp01(item.to.y) * 100}%` }}
        />,
        <div
          key={`to-label-${index}`}
          className="overlay-label-react"
          style={{ left: `${clamp01(item.to.x) * 100}%`, top: `${clamp01(item.to.y) * 100}%` }}
        >
          {item.label} 终点
        </div>
      ];
    }

    return [];
  }), [overlaySize.height, overlaySize.width, viewer.overlayItems]);

  useEffect(() => {
    const element = videoShellRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.contentRect;
      if (!box) {
        return;
      }

      setOverlaySize({
        width: box.width,
        height: box.height
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function handlePointerMove(event) {
      if (!cropDragRef.current) {
        return;
      }

      const nextCrop = cropFromPointerDrag(cropDragRef.current, event);
      if (nextCrop) {
        setCrop(nextCrop);
      }
    }

    function handlePointerUp() {
      cropDragRef.current = null;
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  async function handleRefreshPackages() {
    setIsRefreshingPackages(true);
    try {
      await refreshPackages();
      setExecutionMessage('方案列表已刷新');
    } catch (error) {
      setExecutionMessage(`读取方案失败: ${error.message}`);
    } finally {
      setIsRefreshingPackages(false);
    }
  }

  function handleStartExecution() {
    const result = viewer.startAutomation(executionSelection.packageId, Number(executionSelection.revision));
    setExecutionMessage(result.ok
      ? `已发送开始执行: ${executionSelection.packageId} r${executionSelection.revision}`
      : result.error || '发送开始执行失败');
  }

  function handleStopExecution() {
    const result = viewer.stopAutomation();
    setExecutionMessage(result.ok ? '已发送停止执行' : result.error || '发送停止执行失败');
  }

  function handleLoadDetailIntoEditor() {
    if (!detail) {
      return;
    }

    setEditorDraft(buildDraftFromDetail(detail));
    setEditorStatus(`已载入 ${detail.packageId} r${detail.revision} 到编辑器`);
    setPublishStatus('可以直接修改步骤或图片，再发布为新的 revision');
    setPublishDownloadUrl(detail.revisionEntry?.downloadUrl ? buildHttpUrl(viewer.normalizedServerUrl, detail.revisionEntry.downloadUrl) : '');
  }

  function handleUpdateEditorField(key, value) {
    setEditorDraft((current) => ({ ...current, [key]: value }));
  }

  function handleUpdateStepField(key, value) {
    setStepForm((current) => ({ ...current, [key]: value }));
  }

  function handleSelectPackageCard(entry) {
    setExecutionSelection({ packageId: entry.packageId, revision: getPreferredRevision(entry) });
    setExecutionMessage(`已切换到 ${entry.packageId}`);
  }

  function handleAddStep() {
    const { step, error } = buildStepFromForm(stepForm, editorDraft.steps.length);
    if (error) {
      setEditorStatus(error);
      return;
    }

    setEditorDraft((current) => ({ ...current, steps: [...current.steps, step] }));
    setStepForm((current) => ({ ...current, id: '', queryText: '' }));
    setEditorStatus(`已加入动作: ${step.id}`);
  }

  function handleMoveStep(index, direction) {
    setEditorDraft((current) => {
      const nextSteps = [...current.steps];
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= nextSteps.length) {
        return current;
      }

      [nextSteps[index], nextSteps[targetIndex]] = [nextSteps[targetIndex], nextSteps[index]];
      return { ...current, steps: nextSteps };
    });
  }

  function handleRemoveStep(index) {
    setEditorDraft((current) => ({
      ...current,
      steps: current.steps.filter((_, stepIndex) => stepIndex !== index)
    }));
    setEditorStatus('已删除动作');
  }

  function handleClearSteps() {
    setEditorDraft((current) => ({ ...current, steps: [] }));
    setEditorStatus('动作列表已清空');
  }

  async function handleAssetFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) {
      setEditorStatus('请选择有效的图片文件');
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const pngDataUrl = String(dataUrl).startsWith('data:image/png;base64,')
        ? String(dataUrl)
        : await convertImageToPng(String(dataUrl));
      const assetId = createNextAssetId(editorDraft.images, assetDraftId || stepForm.assetId || file.name.replace(/\.[^.]+$/, ''));

      setEditorDraft((current) => ({
        ...current,
        images: [...current.images.filter((asset) => asset.assetId !== assetId), { assetId, dataUrl: pngDataUrl }]
      }));
      setAssetDraftId(assetId);
      setStepForm((current) => ({ ...current, assetId }));
      setEditorStatus(`已插入图片模板: ${assetId}`);
    } catch (error) {
      setEditorStatus(`图片插入失败: ${error.message}`);
    }
  }

  function handleRemoveAsset(assetId) {
    setEditorDraft((current) => ({
      ...current,
      images: current.images.filter((asset) => asset.assetId !== assetId)
    }));
    setEditorStatus(`已移除图片模板: ${assetId}`);
  }

  function handleCropInputChange(key, value) {
    setCrop((current) => clampCrop({
      ...current,
      [key]: Number(value)
    }));
  }

  function handleStartCropDrag(handle, event) {
    if (!videoShellRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cropDragRef.current = {
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      shellRect: videoShellRef.current.getBoundingClientRect(),
      startCrop: crop
    };
  }

  function handleCaptureAssetFromVideo() {
    const videoElement = viewer.videoRef.current;
    if (!videoElement || !videoElement.videoWidth || !videoElement.videoHeight) {
      setEditorStatus('当前没有可截取的视频帧');
      return;
    }

    const canvas = document.createElement('canvas');
    const sx = Math.round(crop.x * videoElement.videoWidth);
    const sy = Math.round(crop.y * videoElement.videoHeight);
    const sw = Math.max(1, Math.round(crop.width * videoElement.videoWidth));
    const sh = Math.max(1, Math.round(crop.height * videoElement.videoHeight));
    canvas.width = sw;
    canvas.height = sh;
    const context = canvas.getContext('2d');
    if (!context) {
      setEditorStatus('无法创建截图画布');
      return;
    }

    context.drawImage(videoElement, sx, sy, sw, sh, 0, 0, sw, sh);
    const assetId = createNextAssetId(editorDraft.images, assetDraftId || stepForm.assetId || 'capture');
    const dataUrl = canvas.toDataURL('image/png');
    setEditorDraft((current) => ({
      ...current,
      images: [...current.images.filter((asset) => asset.assetId !== assetId), { assetId, dataUrl }]
    }));
    setAssetDraftId(assetId);
    setStepForm((current) => ({ ...current, assetId }));
    setEditorStatus(`已从当前画面截取模板: ${assetId}`);
  }

  async function handlePublishPackage() {
    const automation = buildAutomationDocument(editorDraft);
    if (!isValidPackageId(automation.packageId)) {
      setPublishStatus('Package ID 只能包含字母、数字、下划线或连字符，长度 1-64');
      return;
    }

    setIsPublishing(true);
    setPublishStatus('正在发布新的 revision...');
    setPublishDownloadUrl('');
    try {
      const revision = await publishPackage(automation, editorDraft.images);
      const nextPackageId = revision.packageId || automation.packageId;
      setExecutionSelection({ packageId: nextPackageId, revision: String(revision.revision) });
      setPublishStatus(`已发布 ${nextPackageId} r${revision.revision}`);
      setPublishDownloadUrl(revision.downloadUrl ? buildHttpUrl(viewer.normalizedServerUrl, revision.downloadUrl) : '');
      setEditorStatus('发布成功，当前 revision 已切到新版本');
    } catch (error) {
      setPublishStatus(`发布失败: ${error.message}`);
    } finally {
      setIsPublishing(false);
    }
  }

  const showWaitFields = isTextWaitType(stepForm.type) || isImageWaitType(stepForm.type);
  const showLoopFields = isLoopType(stepForm.type);
  const effectiveActionType = showLoopFields ? stepForm.loopActionType : stepForm.type === 'tap' ? 'tap' : stepForm.type === 'drag' ? 'drag' : '';

  return (
    <div className="page-grid page-grid-workbench">
      <section className="panel hero-panel">
        <div>
          <p className="eyebrow">Phase 3</p>
          <h2>工作台已经具备执行与编辑闭环</h2>
          <p className="panel-copy">
            React 工作台已经接上 viewer 信令、WebRTC 视频、overlay、模板截屏、方案执行、revision 明细和发布流程。当前仍保留 legacy 页面作为对照入口。
          </p>
        </div>
        <div className="status-row">
          <span className="status-chip">信令: {viewer.connectionText}</span>
          <span className="status-chip">RTC: {viewer.rtcText}</span>
          <span className="status-chip">健康接口: {healthLoading ? '加载中' : healthError ? '失败' : '已连接'}</span>
          <span className="status-chip">方案接口: {packagesLoading ? '加载中' : packagesError ? '失败' : `${packages.length} 个`}</span>
          <a className="text-link" href="/legacy/" target="_blank" rel="noreferrer">
            打开旧版工作台对照
          </a>
        </div>
      </section>

      <section className="workbench-top-grid">
        <details className="panel collapsible-panel connection-panel-react" open>
          <summary className="collapsible-summary">
            <div className="collapsible-heading">
              <strong className="collapsible-title">连接查看端</strong>
              <span className="panel-meta">WebSocket + WebRTC</span>
            </div>
            <span className="collapse-indicator">展开 / 折叠</span>
          </summary>
          <div className="collapsible-body stack-panel">
            <label className="field-label">
              <span>服务端地址</span>
              <input value={viewer.serverUrl} onChange={(event) => viewer.updateConfig('serverUrl', event.target.value)} />
            </label>
            <label className="field-label">
              <span>房间 ID</span>
              <input value={viewer.roomId} onChange={(event) => viewer.updateConfig('roomId', event.target.value)} />
            </label>
            <label className="field-label">
              <span>Token</span>
              <input value={viewer.token} onChange={(event) => viewer.updateConfig('token', event.target.value)} placeholder="可选" />
            </label>
            <div className="button-row">
              <button type="button" className="button-primary" onClick={viewer.connect}>连接</button>
              <button type="button" className="button-secondary" onClick={viewer.disconnect}>断开</button>
            </div>
            <dl className="key-value-list compact-list">
              <div>
                <dt>连接状态</dt>
                <dd>{viewer.connectionText}</dd>
              </div>
              <div>
                <dt>Publisher</dt>
                <dd>{viewer.publisherText}</dd>
              </div>
              <div>
                <dt>Executor</dt>
                <dd>{viewer.executorText}</dd>
              </div>
              <div>
                <dt>查看人数</dt>
                <dd>{viewer.viewerCount}</dd>
              </div>
            </dl>
          </div>
        </details>

        <details className="panel collapsible-panel log-panel-react">
          <summary className="collapsible-summary">
            <div className="collapsible-heading">
              <strong className="collapsible-title">连接日志</strong>
              <span className="panel-meta">最近 60 条</span>
            </div>
            <span className="collapse-indicator">展开 / 折叠</span>
          </summary>
          <div className="collapsible-body stack-panel">
            <pre className="console-panel">{viewer.debugLines.length > 0 ? viewer.debugLines.join('\n') : '等待连接...'}</pre>
          </div>
        </details>

        <details className="panel collapsible-panel log-panel-react">
          <summary className="collapsible-summary">
            <div className="collapsible-heading">
              <strong className="collapsible-title">自动化状态</strong>
              <span className="panel-meta">执行事件与 executor 回执</span>
            </div>
            <span className="collapse-indicator">展开 / 折叠</span>
          </summary>
          <div className="collapsible-body stack-panel">
            <div className="button-row">
              <button type="button" className="button-secondary" onClick={viewer.clearOverlay} disabled={viewer.overlayItems.length === 0}>
                清空 overlay
              </button>
            </div>
            <div className="detail-summary-grid summary-grid-compact">
              <div className="summary-tile">
                <span className="summary-label">状态</span>
                <strong>{viewer.automationState}</strong>
              </div>
              <div className="summary-tile">
                <span className="summary-label">最近请求</span>
                <strong>{viewer.lastExecutorRequest}</strong>
              </div>
              <div className="summary-tile">
                <span className="summary-label">最近结果</span>
                <strong>{viewer.lastExecutorResult}</strong>
              </div>
            </div>
            <pre className="console-panel">{viewer.automationLines.length > 0 ? viewer.automationLines.join('\n') : '等待自动化事件...'}</pre>
          </div>
        </details>
      </section>

      <section className="workbench-main-grid">
        <section className="panel viewer-panel-react workspace-frame-panel">
          <div className="panel-header">
            <div>
              <h2>{viewer.roomTitle}</h2>
              <p className="panel-copy small-copy">{viewer.lastFrameMeta}</p>
            </div>
            <div className="status-row compact-status-row-react">
              <span className={viewer.isLive ? 'badge ok' : 'badge'}>{viewer.isLive ? '直播中' : '等待直播'}</span>
              <span className="badge">Overlay {viewer.overlayItems.length}</span>
            </div>
          </div>
          <div className="viewer-stage-react">
            <div ref={videoShellRef} className={viewer.remoteStream ? 'video-shell-react live' : 'video-shell-react empty'}>
              <video ref={viewer.videoRef} autoPlay playsInline muted />
              {viewer.remoteStream ? (
                <>
                  <div className="video-overlay-react">{overlayElements}</div>
                  <div className="crop-layer-react">
                    <div
                      className="crop-box-react"
                      style={{
                        left: `${crop.x * 100}%`,
                        top: `${crop.y * 100}%`,
                        width: `${crop.width * 100}%`,
                        height: `${crop.height * 100}%`
                      }}
                      onPointerDown={(event) => handleStartCropDrag('move', event)}
                    >
                      <span className="crop-box-label-react">模板区域</span>
                      {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => (
                        <span
                          key={handle}
                          className="crop-handle-react"
                          data-handle={handle}
                          onPointerDown={(event) => handleStartCropDrag(handle, event)}
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
              {!viewer.remoteStream ? (
                <div className="video-empty-state">
                  <strong>等待发布端视频</strong>
                  <p>先连接同一个 room，收到 offer 后这里会自动建立视频轨道。</p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="panel stack-panel editor-panel-react workspace-editor-panel">
          <div className="panel-header">
            <h2>方案编辑器</h2>
            <span className="panel-meta">发布新的 revision</span>
          </div>
          <div className="detail-summary-grid summary-grid-compact">
            <div className="summary-tile">
              <span className="summary-label">Package ID</span>
              <strong>{editorDraft.packageId || '未填写'}</strong>
            </div>
            <div className="summary-tile">
              <span className="summary-label">名称</span>
              <strong>{editorDraft.name || '未填写'}</strong>
            </div>
            <div className="summary-tile">
              <span className="summary-label">动作数</span>
              <strong>{editorDraft.steps.length}</strong>
            </div>
            <div className="summary-tile">
              <span className="summary-label">图片数</span>
              <strong>{editorDraft.images.length}</strong>
            </div>
          </div>
          <div className="editor-layout-react">
            <section className="nested-panel-react">
              <div className="panel-header">
                <h2>基本信息</h2>
                <span className="panel-meta">编辑草稿</span>
              </div>
              <div className="form-grid-react compact-grid-react">
                <label className="field-label">
                  <span>Package ID</span>
                  <input value={editorDraft.packageId} onChange={(event) => handleUpdateEditorField('packageId', event.target.value)} placeholder="例如 demo" />
                </label>
                <label className="field-label">
                  <span>名称</span>
                  <input value={editorDraft.name} onChange={(event) => handleUpdateEditorField('name', event.target.value)} placeholder="例如 Demo Flow" />
                </label>
              </div>
              <div className="panel-header">
                <h2>添加动作</h2>
                <span className="panel-meta">先组装 JSON，再发布</span>
              </div>
              <label className="field-label">
                <span>动作类型</span>
                <select value={stepForm.type} onChange={(event) => handleUpdateStepField('type', event.target.value)}>
                  {STEP_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="field-label">
                <span>步骤 ID</span>
                <input value={stepForm.id} onChange={(event) => handleUpdateStepField('id', event.target.value)} placeholder="例如 wait-login" />
              </label>
              {showWaitFields ? (
                <>
                  {isTextWaitType(stepForm.type) ? (
                    <label className="field-label">
                      <span>文字查询</span>
                      <textarea value={stepForm.queryText} onChange={(event) => handleUpdateStepField('queryText', event.target.value)} rows="4" placeholder={"每行一个候选文字，例如\n登录\n立即开始"} />
                    </label>
                  ) : null}
                  {isImageWaitType(stepForm.type) ? (
                    <label className="field-label">
                      <span>图片 Asset ID</span>
                      <input value={stepForm.assetId} onChange={(event) => handleUpdateStepField('assetId', event.target.value)} placeholder="例如 login-icon" />
                    </label>
                  ) : null}
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>保存为</span>
                      <input value={stepForm.saveAs} onChange={(event) => handleUpdateStepField('saveAs', event.target.value)} placeholder="例如 loginButton" />
                    </label>
                    {isImageWaitType(stepForm.type) ? (
                      <label className="field-label">
                        <span>阈值</span>
                        <input value={stepForm.threshold} type="number" min="0" max="1" step="0.01" onChange={(event) => handleUpdateStepField('threshold', event.target.value)} />
                      </label>
                    ) : null}
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>超时 ms</span>
                      <input value={stepForm.timeoutMs} type="number" onChange={(event) => handleUpdateStepField('timeoutMs', event.target.value)} />
                    </label>
                    <label className="field-label">
                      <span>轮询 ms</span>
                      <input value={stepForm.pollIntervalMs} type="number" onChange={(event) => handleUpdateStepField('pollIntervalMs', event.target.value)} />
                    </label>
                  </div>
                </>
              ) : null}
              {showLoopFields ? (
                <label className="field-label">
                  <span>loop 动作类型</span>
                  <select value={stepForm.loopActionType} onChange={(event) => handleUpdateStepField('loopActionType', event.target.value)}>
                    <option value="tap">点击</option>
                    <option value="drag">拖拽</option>
                  </select>
                </label>
              ) : null}
              {effectiveActionType === 'tap' ? (
                <div className="subtle-panel-react">
                  <div className="panel-header">
                    <h2>点击目标</h2>
                    <span className="panel-meta">引用或像素坐标二选一</span>
                  </div>
                  <label className="field-label">
                    <span>目标引用</span>
                    <input value={stepForm.targetRef} onChange={(event) => handleUpdateStepField('targetRef', event.target.value)} placeholder="例如 loginButton" />
                  </label>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>x 像素</span>
                      <input value={stepForm.targetX} type="number" onChange={(event) => handleUpdateStepField('targetX', event.target.value)} placeholder="例如 320" />
                    </label>
                    <label className="field-label">
                      <span>y 像素</span>
                      <input value={stepForm.targetY} type="number" onChange={(event) => handleUpdateStepField('targetY', event.target.value)} placeholder="例如 480" />
                    </label>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>x 偏移 px</span>
                      <input value={stepForm.targetOffsetX} type="number" onChange={(event) => handleUpdateStepField('targetOffsetX', event.target.value)} />
                    </label>
                    <label className="field-label">
                      <span>y 偏移 px</span>
                      <input value={stepForm.targetOffsetY} type="number" onChange={(event) => handleUpdateStepField('targetOffsetY', event.target.value)} />
                    </label>
                  </div>
                </div>
              ) : null}
              {effectiveActionType === 'drag' ? (
                <div className="subtle-panel-react">
                  <div className="panel-header">
                    <h2>拖拽目标</h2>
                    <span className="panel-meta">起点与终点都需要</span>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>起点引用</span>
                      <input value={stepForm.fromRef} onChange={(event) => handleUpdateStepField('fromRef', event.target.value)} placeholder="可选" />
                    </label>
                    <label className="field-label">
                      <span>终点引用</span>
                      <input value={stepForm.toRef} onChange={(event) => handleUpdateStepField('toRef', event.target.value)} placeholder="可选" />
                    </label>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>起点 x</span>
                      <input value={stepForm.fromX} type="number" onChange={(event) => handleUpdateStepField('fromX', event.target.value)} placeholder="例如 320" />
                    </label>
                    <label className="field-label">
                      <span>起点 y</span>
                      <input value={stepForm.fromY} type="number" onChange={(event) => handleUpdateStepField('fromY', event.target.value)} placeholder="例如 420" />
                    </label>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>起点 x 偏移</span>
                      <input value={stepForm.fromOffsetX} type="number" onChange={(event) => handleUpdateStepField('fromOffsetX', event.target.value)} />
                    </label>
                    <label className="field-label">
                      <span>起点 y 偏移</span>
                      <input value={stepForm.fromOffsetY} type="number" onChange={(event) => handleUpdateStepField('fromOffsetY', event.target.value)} />
                    </label>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>终点 x</span>
                      <input value={stepForm.toX} type="number" onChange={(event) => handleUpdateStepField('toX', event.target.value)} placeholder="例如 320" />
                    </label>
                    <label className="field-label">
                      <span>终点 y</span>
                      <input value={stepForm.toY} type="number" onChange={(event) => handleUpdateStepField('toY', event.target.value)} placeholder="例如 620" />
                    </label>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>终点 x 偏移</span>
                      <input value={stepForm.toOffsetX} type="number" onChange={(event) => handleUpdateStepField('toOffsetX', event.target.value)} />
                    </label>
                    <label className="field-label">
                      <span>终点 y 偏移</span>
                      <input value={stepForm.toOffsetY} type="number" onChange={(event) => handleUpdateStepField('toOffsetY', event.target.value)} />
                    </label>
                  </div>
                  <div className="form-grid-react compact-grid-react">
                    <label className="field-label">
                      <span>按住 ms</span>
                      <input value={stepForm.holdMs} type="number" onChange={(event) => handleUpdateStepField('holdMs', event.target.value)} />
                    </label>
                    <label className="field-label">
                      <span>移动 ms</span>
                      <input value={stepForm.durationMs} type="number" onChange={(event) => handleUpdateStepField('durationMs', event.target.value)} />
                    </label>
                  </div>
                </div>
              ) : null}
              <div className="button-row">
                <button type="button" className="button-primary" onClick={handleAddStep}>加入动作</button>
                <button type="button" className="button-secondary" onClick={handleClearSteps} disabled={editorDraft.steps.length === 0}>清空动作</button>
              </div>
              <p className="helper-text">{editorStatus}</p>
            </section>

            <section className="nested-panel-react">
              <div className="panel-header">
                <h2>图片模板</h2>
                <span className="panel-meta">发布时会一起打包</span>
              </div>
              <div className="form-grid-react compact-grid-react">
                <label className="field-label">
                  <span>截图 x</span>
                  <input value={formatCropValue(crop.x)} type="number" min="0" max="1" step="0.01" onChange={(event) => handleCropInputChange('x', event.target.value)} />
                </label>
                <label className="field-label">
                  <span>截图 y</span>
                  <input value={formatCropValue(crop.y)} type="number" min="0" max="1" step="0.01" onChange={(event) => handleCropInputChange('y', event.target.value)} />
                </label>
              </div>
              <div className="form-grid-react compact-grid-react">
                <label className="field-label">
                  <span>宽</span>
                  <input value={formatCropValue(crop.width)} type="number" min="0.02" max="1" step="0.01" onChange={(event) => handleCropInputChange('width', event.target.value)} />
                </label>
                <label className="field-label">
                  <span>高</span>
                  <input value={formatCropValue(crop.height)} type="number" min="0.02" max="1" step="0.01" onChange={(event) => handleCropInputChange('height', event.target.value)} />
                </label>
              </div>
              <div className="form-grid-react compact-grid-react">
                <label className="field-label">
                  <span>Asset ID</span>
                  <input value={assetDraftId} onChange={(event) => setAssetDraftId(event.target.value)} placeholder="例如 login-icon" />
                </label>
                <label className="field-label">
                  <span>上传图片</span>
                  <input type="file" accept="image/*" onChange={handleAssetFileChange} />
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="button-secondary" onClick={handleCaptureAssetFromVideo} disabled={!viewer.remoteStream}>
                  从当前画面截取模板
                </button>
              </div>
              <div className="asset-gallery-react">
                {editorDraft.images.map((asset) => (
                  <article className="asset-card-react" key={asset.assetId}>
                    <img src={asset.dataUrl} alt={asset.assetId} />
                    <footer>
                      <strong>{asset.assetId}</strong>
                      <button type="button" className="button-tertiary danger-text" onClick={() => handleRemoveAsset(asset.assetId)}>移除</button>
                    </footer>
                  </article>
                ))}
                {editorDraft.images.length === 0 ? <p className="muted-text">还没有图片模板，可先上传 PNG/JPG。</p> : null}
              </div>
              <div className="panel-header">
                <h2>动作列表</h2>
                <span className="panel-meta">支持上移、下移、删除</span>
              </div>
              <div className="step-list">
                {editorDraft.steps.map((step, index) => (
                  <article className="step-card" key={step.id || `${step.type}-${index}`}>
                    <div className="step-card-head">
                      <strong>{index + 1}. {step.id || '未命名步骤'}</strong>
                      <span className="badge accent">{STEP_TYPE_LABELS[step.type] || step.type}</span>
                    </div>
                    <p className="panel-copy small-copy">{formatStepSummary(step)}</p>
                    <div className="step-details-react">
                      {buildStepDetailLines(step).map((line) => <div key={line}>{line}</div>)}
                    </div>
                    <div className="inline-button-row-react">
                      <button type="button" className="button-tertiary" onClick={() => handleMoveStep(index, -1)} disabled={index === 0}>上移</button>
                      <button type="button" className="button-tertiary" onClick={() => handleMoveStep(index, 1)} disabled={index === editorDraft.steps.length - 1}>下移</button>
                      <button type="button" className="button-tertiary danger-text" onClick={() => handleRemoveStep(index)}>删除</button>
                    </div>
                  </article>
                ))}
                {editorDraft.steps.length === 0 ? <p className="muted-text">还没有动作，可先在左侧添加步骤。</p> : null}
              </div>
            </section>

            <section className="nested-panel-react">
              <div className="panel-header">
                <h2>JSON 预览</h2>
                <span className="panel-meta">发布前检查结构</span>
              </div>
              <textarea className="code-preview-react" readOnly value={editorPreview} />
              <div className="button-row">
                <button type="button" className="button-primary" onClick={handlePublishPackage} disabled={isPublishing}>
                  {isPublishing ? '发布中...' : '发布新 revision'}
                </button>
                <button type="button" className="button-secondary" onClick={handleLoadDetailIntoEditor} disabled={!detail || detailLoading}>
                  用当前选中 revision 覆盖草稿
                </button>
              </div>
              <p className={publishStatus.includes('失败') ? 'error-text' : 'helper-text'}>{publishStatus}</p>
              {publishDownloadUrl ? (
                <div className="button-row">
                  <a className="button-secondary link-button" href={publishDownloadUrl} target="_blank" rel="noreferrer">
                    下载刚发布的 ZIP
                  </a>
                </div>
              ) : null}
            </section>
          </div>
        </section>
      </section>

      <section className="panel stack-panel execution-panel-react">
        <div className="panel-header">
          <h2>方案执行</h2>
          <span className="panel-meta">viewer socket + package API</span>
        </div>
        <div className="form-grid-react compact-grid-react">
          <label className="field-label">
            <span>可用方案</span>
            <select value={executionSelection.packageId} onChange={(event) => setExecutionSelection({ packageId: event.target.value, revision: '' })}>
              {packages.length > 0 ? packages.map((entry) => (
                <option key={entry.packageId} value={entry.packageId}>{entry.packageId} / {entry.name}</option>
              )) : <option value="">暂无方案</option>}
            </select>
          </label>
          <label className="field-label">
            <span>Revision</span>
            <select value={executionSelection.revision} onChange={(event) => setExecutionSelection((current) => ({ ...current, revision: event.target.value }))}>
              {selectedRevisions.length > 0 ? selectedRevisions.map((entry) => (
                <option key={entry.revision} value={String(entry.revision)}>
                  r{entry.revision} / {entry.stepCount} steps / {entry.imageCount} images
                </option>
              )) : <option value="">无可用 revision</option>}
            </select>
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="button-secondary" onClick={handleRefreshPackages} disabled={isRefreshingPackages}>
            {isRefreshingPackages ? '刷新中...' : '刷新方案'}
          </button>
          <button type="button" className="button-secondary" onClick={handleLoadDetailIntoEditor} disabled={!detail || detailLoading}>
            载入到编辑器
          </button>
          <button type="button" className="button-primary" onClick={handleStartExecution} disabled={!canStartExecution}>
            开始执行
          </button>
          <button type="button" className="button-secondary" onClick={handleStopExecution} disabled={!viewer.connected || !viewer.isExecutionRunning}>
            停止执行
          </button>
        </div>
        <p className="helper-text">{executionPrerequisite}</p>
        <p className={viewer.errorText ? 'error-text' : 'muted-text'}>{viewer.errorText || executionMessage}</p>
        <div className="package-list package-list-compact">
          {packages.map((entry) => (
            <button
              type="button"
              key={entry.packageId}
              className={entry.packageId === executionSelection.packageId ? 'package-card selected' : 'package-card'}
              onClick={() => handleSelectPackageCard(entry)}
            >
              <div className="package-card-head">
                <strong>{entry.packageId}</strong>
                <span className="badge">r{entry.activeRevision || entry.latestRevision || '-'}</span>
              </div>
              <p className="panel-copy small-copy">最新 {entry.latestRevision || 0} / 激活 {entry.activeRevision || '未设置'}</p>
            </button>
          ))}
          {!packagesLoading && packages.length === 0 ? <p className="muted-text">还没有自动化方案。</p> : null}
        </div>
      </section>

      <section className="panel stack-panel">
        <div className="panel-header">
          <h2>房间状态</h2>
          <span className="panel-meta">每 5 秒刷新</span>
        </div>
        {healthError ? <p className="error-text">{healthError}</p> : null}
        <div className="room-list">
          {(health?.rooms || []).map((room) => (
            <article className="room-card" key={room.roomId}>
              <div className="room-card-head">
                <strong>{room.roomId}</strong>
                <span className={room.hasPublisher ? 'badge ok' : 'badge'}>{room.hasPublisher ? 'Publisher 在线' : 'Publisher 离线'}</span>
              </div>
              <dl className="key-value-list">
                <div>
                  <dt>Viewer</dt>
                  <dd>{room.viewerCount}</dd>
                </div>
                <div>
                  <dt>Probe</dt>
                  <dd>{room.probeCount}</dd>
                </div>
                <div>
                  <dt>Executor</dt>
                  <dd>{room.hasExecutor ? '在线' : '离线'}</dd>
                </div>
                <div>
                  <dt>标定 App</dt>
                  <dd>{room.hasCalibrationApp ? '在线' : '离线'}</dd>
                </div>
                <div>
                  <dt>Publisher 连入</dt>
                  <dd>{formatTimestamp(room.publisherConnectedAt)}</dd>
                </div>
              </dl>
            </article>
          ))}
          {!healthLoading && (health?.rooms || []).length === 0 ? <p className="muted-text">当前没有活跃房间。</p> : null}
        </div>
      </section>

      <section className="panel stack-panel package-detail-panel">
        <div className="panel-header">
          <h2>方案明细</h2>
          <span className="panel-meta">当前选中的 revision</span>
        </div>
        {packagesError ? <p className="error-text">{packagesError}</p> : null}
        {detailError ? <p className="error-text">{detailError}</p> : null}
        {detailLoading ? <p className="muted-text">正在读取 revision...</p> : null}
        {detail ? (
          <>
            <div className="detail-summary-grid">
              <div className="summary-tile">
                <span className="summary-label">方案</span>
                <strong>{detail.packageId}</strong>
              </div>
              <div className="summary-tile">
                <span className="summary-label">Revision</span>
                <strong>r{detail.revision}</strong>
              </div>
              <div className="summary-tile">
                <span className="summary-label">步骤数</span>
                <strong>{detail.automation?.steps?.length || 0}</strong>
              </div>
              <div className="summary-tile">
                <span className="summary-label">图片数</span>
                <strong>{detail.images?.length || 0}</strong>
              </div>
            </div>
            {detail.revisionEntry?.downloadUrl ? (
              <div className="button-row">
                <a
                  className="button-secondary link-button"
                  href={buildHttpUrl(viewer.normalizedServerUrl, detail.revisionEntry.downloadUrl)}
                  target="_blank"
                  rel="noreferrer"
                >
                  下载当前 ZIP
                </a>
              </div>
            ) : null}
            <div className="detail-two-column-react">
              <section className="nested-panel-react">
                <div className="panel-header">
                  <h2>步骤详情</h2>
                  <span className="panel-meta">只读</span>
                </div>
                <div className="step-list">
                  {(detail.automation?.steps || []).map((step, index) => (
                    <article className="step-card" key={step.id || `${step.type}-${index}`}>
                      <div className="step-card-head">
                        <strong>{index + 1}. {step.id || '未命名步骤'}</strong>
                        <span className="badge accent">{STEP_TYPE_LABELS[step.type] || step.type}</span>
                      </div>
                      <p className="panel-copy small-copy">{formatStepSummary(step)}</p>
                      <div className="step-details-react">
                        {buildStepDetailLines(step).map((line) => <div key={line}>{line}</div>)}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <section className="nested-panel-react">
                <div className="panel-header">
                  <h2>图片模板</h2>
                  <span className="panel-meta">{detail.images?.length || 0} 张</span>
                </div>
                <div className="asset-gallery-react">
                  {(detail.images || []).map((asset) => (
                    <article className="asset-card-react" key={asset.assetId}>
                      <img src={asset.dataUrl} alt={asset.assetId} />
                      <footer>
                        <strong>{asset.assetId}</strong>
                      </footer>
                    </article>
                  ))}
                  {(detail.images || []).length === 0 ? <p className="muted-text">当前 revision 没有图片模板。</p> : null}
                </div>
                <div className="panel-header">
                  <h2>automation.json</h2>
                  <span className="panel-meta">只读预览</span>
                </div>
                <textarea className="code-preview-react code-preview-compact-react" readOnly value={JSON.stringify(detail.automation || {}, null, 2)} />
              </section>
            </div>
          </>
        ) : null}
        {!detailLoading && !detail && !detailError ? (
          <p className="muted-text">选择一个方案后，这里会显示 revision 详情。</p>
        ) : null}
      </section>

    </div>
  );
}