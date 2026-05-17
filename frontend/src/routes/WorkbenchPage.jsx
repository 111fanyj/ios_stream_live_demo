import { useEffect } from 'react';
import { useAutomationPackages } from '../hooks/useAutomationPackages';
import { useHealth } from '../hooks/useHealth';
import { useViewerConnection } from '../hooks/useViewerConnection';

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
    return step.target?.ref ? `引用 ${step.target.ref}` : `${step.target?.x ?? '-'}, ${step.target?.y ?? '-'}`;
  }

  if (step.type === 'drag') {
    return `${step.from?.ref || `${step.from?.x ?? '-'}, ${step.from?.y ?? '-'}`} -> ${step.to?.ref || `${step.to?.x ?? '-'}, ${step.to?.y ?? '-'}`}`;
  }

  return step.type;
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
    selectPackage
  } = useAutomationPackages(viewer.normalizedServerUrl);

  useEffect(() => {
    if (packages.length > 0) {
      const current = packages[0];
      const revision = current.activeRevision || current.latestRevision;
      if (revision) {
        selectPackage(current.packageId, revision);
      }
    }
  }, [packages, selectPackage]);

  return (
    <div className="page-grid page-grid-workbench">
      <section className="panel hero-panel">
        <div>
          <p className="eyebrow">Phase 1</p>
          <h2>工作台外壳已接入</h2>
          <p className="panel-copy">
            现在已经把 viewer 信令连接、WebRTC 视频舞台、房间状态和自动化方案明细接进 React。下一步继续迁 overlay、编辑器和执行链路。
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

      <section className="panel stack-panel connection-panel-react">
        <div className="panel-header">
          <h2>连接查看端</h2>
          <span className="panel-meta">WebSocket + WebRTC</span>
        </div>
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
      </section>

      <section className="panel viewer-panel-react">
        <div className="panel-header">
          <div>
            <h2>{viewer.roomTitle}</h2>
            <p className="panel-copy small-copy">{viewer.lastFrameMeta}</p>
          </div>
          <span className={viewer.isLive ? 'badge ok' : 'badge'}>{viewer.isLive ? '直播中' : '等待直播'}</span>
        </div>
        <div className="viewer-stage-react">
          <div className={viewer.remoteStream ? 'video-shell-react live' : 'video-shell-react'}>
            <video ref={viewer.videoRef} autoPlay playsInline muted />
            {!viewer.remoteStream ? (
              <div className="video-empty-state">
                <strong>等待发布端视频</strong>
                <p>先连接同一个 room，收到 offer 后这里会自动建立视频轨道。</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel stack-panel log-panel-react">
        <div className="panel-header">
          <h2>连接日志</h2>
          <span className="panel-meta">最近 60 条</span>
        </div>
        <pre className="console-panel">{viewer.debugLines.length > 0 ? viewer.debugLines.join('\n') : '等待连接...'}</pre>
      </section>

      <section className="panel stack-panel log-panel-react">
        <div className="panel-header">
          <h2>自动化状态</h2>
          <span className="panel-meta">执行链路迁移中</span>
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

      <section className="panel stack-panel package-list-panel-react">
        <div className="panel-header">
          <h2>自动化方案</h2>
          <span className="panel-meta">首批迁移：列表 + revision 详情</span>
        </div>
        {packagesError ? <p className="error-text">{packagesError}</p> : null}
        <div className="package-list">
          {packages.map((entry) => {
            const revision = entry.activeRevision || entry.latestRevision;
            return (
              <button
                type="button"
                key={entry.packageId}
                className="package-card"
                onClick={() => selectPackage(entry.packageId, revision)}
              >
                <div className="package-card-head">
                  <strong>{entry.packageId}</strong>
                  <span className="badge">r{revision || '-'}</span>
                </div>
                <p className="panel-copy small-copy">最新 {entry.latestRevision || 0} / 激活 {entry.activeRevision || '未设置'}</p>
              </button>
            );
          })}
          {!packagesLoading && packages.length === 0 ? <p className="muted-text">还没有自动化方案。</p> : null}
        </div>
      </section>

      <section className="panel stack-panel package-detail-panel">
        <div className="panel-header">
          <h2>方案明细</h2>
          <span className="panel-meta">后续会接入编辑、执行和 overlay</span>
        </div>
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
            <div className="step-list">
              {(detail.automation?.steps || []).map((step) => (
                <article className="step-card" key={step.id || `${step.type}-${step.assetId || step.query || 'step'}`}>
                  <div className="step-card-head">
                    <strong>{step.id || '未命名步骤'}</strong>
                    <span className="badge accent">{step.type}</span>
                  </div>
                  <p className="panel-copy small-copy">{formatStepSummary(step)}</p>
                </article>
              ))}
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