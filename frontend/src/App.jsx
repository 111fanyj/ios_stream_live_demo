import { NavLink, Route, Routes } from 'react-router-dom';
import { WorkbenchPage } from './routes/WorkbenchPage';
import { DebugOcrPage } from './routes/DebugOcrPage';

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">React Migration</p>
          <h1>iOS 自动化直播工作台</h1>
          <p className="app-subtitle">
            新前端先完成脚手架、路由和基础数据接入，实时视频、调试通信和编辑器逻辑接下来分阶段迁移。
          </p>
        </div>
        <nav className="app-nav" aria-label="Primary">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            工作台
          </NavLink>
          <NavLink to="/debug-ocr" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            OCR 调试
          </NavLink>
          <a className="nav-link" href="/legacy/" target="_blank" rel="noreferrer">
            旧版页面
          </a>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<WorkbenchPage />} />
          <Route path="/debug-ocr" element={<DebugOcrPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;