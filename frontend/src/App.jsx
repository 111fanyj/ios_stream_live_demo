import { NavLink, Route, Routes } from 'react-router-dom';
import { WorkbenchPage } from './routes/WorkbenchPage';
import { DebugOcrPage } from './routes/DebugOcrPage';

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">React Workspace</p>
          <h1>iOS 自动化直播工作台</h1>
          <p className="app-subtitle">
            React 前端已经承担工作台与 OCR 调试主界面，当前保留 legacy 页面作为功能对照与回归检查入口。
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