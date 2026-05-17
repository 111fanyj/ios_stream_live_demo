import { useProbeConnection } from '../hooks/useProbeConnection';

export function DebugOcrPage() {
  const probe = useProbeConnection();

  return (
    <div className="page-grid page-grid-debug">
      <section className="panel hero-panel debug-hero">
        <div>
          <p className="eyebrow">Phase 1</p>
          <h2>OCR 调试页已接入 probe</h2>
          <p className="panel-copy">
            现在已经可以直接向 Broadcast Extension 请求最近一帧内存图，展示 JPEG 预览、OCR 候选和标定状态。参考图叠层后续再细化。
          </p>
        </div>
        <div className="status-row">
          <span className="status-chip">调试通道: {probe.socketStatus}</span>
          <span className="status-chip">请求状态: {probe.requestStatus}</span>
          <a className="text-link" href="/legacy/debug-ocr.html" target="_blank" rel="noreferrer">
            打开旧版调试页对照
          </a>
        </div>
      </section>

      <section className="panel stack-panel">
        <div className="panel-header">
          <h2>调试控制区</h2>
          <span className="panel-meta">probe socket</span>
        </div>
        <label className="field-label">
          <span>服务端地址</span>
          <input value={probe.serverUrl} onChange={(event) => probe.updateConfig('serverUrl', event.target.value)} />
        </label>
        <label className="field-label">
          <span>房间 ID</span>
          <input value={probe.roomId} onChange={(event) => probe.updateConfig('roomId', event.target.value)} />
        </label>
        <label className="field-label">
          <span>OCR 查询词</span>
          <input value={probe.query} onChange={(event) => probe.updateConfig('query', event.target.value)} placeholder="可选" />
        </label>
        <div className="button-row">
          <button type="button" className="button-primary" onClick={probe.connect}>{probe.connected ? '断开调试通道' : '连接调试通道'}</button>
          <button type="button" className="button-secondary" onClick={probe.requestDebugFrame} disabled={!probe.connected}>请求最近一帧</button>
        </div>
        <div className="button-row">
          <button type="button" className="button-secondary" onClick={probe.startCalibration} disabled={!probe.connected}>开始 3 点标定</button>
          <button type="button" className="button-secondary" onClick={probe.startCalibrationValidation} disabled={!probe.connected}>验证当前标定</button>
        </div>
        <div className="status-row">
          <span className={probe.connected ? 'badge ok' : 'badge'}>{probe.socketStatus}</span>
          <span className={probe.publisherStatus.includes('在线') ? 'badge ok' : 'badge'}>{probe.publisherStatus}</span>
          <span className={probe.roomHasCalibrationApp ? 'badge ok' : 'badge'}>{probe.calibrationAppStatus}</span>
          <span className={probe.roomCalibration ? 'badge ok' : 'badge'}>{probe.calibrationStatus}</span>
        </div>
        <pre className="console-panel compact-console">{probe.logs.length > 0 ? probe.logs.join('\n') : '等待连接...'}</pre>
      </section>

      <section className="panel stack-panel">
        <div className="panel-header">
          <h2>结果画布区</h2>
          <span className="panel-meta">JPEG 预览 + OCR 命中</span>
        </div>
        <div className="debug-frame-stage">
          {probe.frameImageDataUrl ? (
            <div className="frame-shell-react">
              <img src={probe.frameImageDataUrl} alt="iOS 内存帧" className="frame-image-react" />
              <div className="frame-overlay-react">
                {probe.allCandidates.map((candidate, index) => (
                  candidate.bounds ? (
                    <div
                      key={`${candidate.text || 'candidate'}-${index}`}
                      className={candidate.matched ? 'ocr-box-react matched' : 'ocr-box-react'}
                      style={{
                        left: `${Math.max(0, candidate.bounds.x * 100)}%`,
                        top: `${Math.max(0, candidate.bounds.y * 100)}%`,
                        width: `${Math.max(0, candidate.bounds.width * 100)}%`,
                        height: `${Math.max(0, candidate.bounds.height * 100)}%`
                      }}
                    >
                      <span className="ocr-box-label-react">{candidate.text || ''}</span>
                    </div>
                  ) : null
                ))}
              </div>
            </div>
          ) : (
            <div className="frame-empty-react">
              <strong>还没有调试帧</strong>
              <p>连接 probe 通道后点击“请求最近一帧”，这里会显示 iOS 返回的 JPEG 预览。</p>
            </div>
          )}
        </div>
        <div className="detail-summary-grid summary-grid-compact debug-summary-grid">
          <div className="summary-tile">
            <span className="summary-label">Request ID</span>
            <strong>{probe.requestId}</strong>
          </div>
          <div className="summary-tile">
            <span className="summary-label">响应时间</span>
            <strong>{probe.respondedAt}</strong>
          </div>
          <div className="summary-tile">
            <span className="summary-label">全部候选</span>
            <strong>{probe.candidateCount}</strong>
          </div>
          <div className="summary-tile">
            <span className="summary-label">命中数量</span>
            <strong>{probe.matchedCount}</strong>
          </div>
        </div>
        <div className="result-grid-react">
          <section className="table-card-react">
            <div className="panel-header">
              <h2>命中候选</h2>
              <span className="panel-meta">匹配当前查询词</span>
            </div>
            <table className="result-table-react">
              <thead>
                <tr>
                  <th>文本</th>
                  <th>置信度</th>
                  <th>Bounds</th>
                </tr>
              </thead>
              <tbody>
                {probe.matchedCandidates.length > 0 ? probe.matchedCandidates.map((candidate, index) => (
                  <tr key={`matched-${index}`}>
                    <td>{candidate.text || ''}</td>
                    <td>{Number(candidate.confidence || 0).toFixed(3)}</td>
                    <td>{probe.formatBounds(candidate.bounds)}</td>
                  </tr>
                )) : <tr><td colSpan="3" className="muted-cell">没有命中当前查询词</td></tr>}
              </tbody>
            </table>
          </section>
          <section className="table-card-react">
            <div className="panel-header">
              <h2>全部 OCR 候选</h2>
              <span className="panel-meta">原始返回</span>
            </div>
            <table className="result-table-react">
              <thead>
                <tr>
                  <th>文本</th>
                  <th>置信度</th>
                  <th>Bounds</th>
                </tr>
              </thead>
              <tbody>
                {probe.allCandidates.length > 0 ? probe.allCandidates.map((candidate, index) => (
                  <tr key={`all-${index}`}>
                    <td>{candidate.text || ''}</td>
                    <td>{Number(candidate.confidence || 0).toFixed(3)}</td>
                    <td>{probe.formatBounds(candidate.bounds)}</td>
                  </tr>
                )) : <tr><td colSpan="3" className="muted-cell">没有 OCR 候选</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
        <section className="panel nested-panel-react">
          <div className="panel-header">
            <h2>标定摘要</h2>
            <span className="panel-meta">文本版</span>
          </div>
          <pre className="console-panel calibration-console">{probe.calibrationSummary}</pre>
        </section>
      </section>
    </div>
  );
}