import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import LoginPage from "./pages/Login";
import HomePage from "./pages/Home";

// 工作台和分享页包含画布（Excalidraw），按需加载，登录页不需要它
const WorkspacePage = lazy(() => import("./pages/Workspace"));
const SharePage = lazy(() => import("./pages/Share"));
const IntegrationsPage = lazy(() => import("./pages/Integrations"));

// 按会话 id 重新挂载工作台：切换访谈时画布、工作流等状态全部重置，不会残留上一个访谈的内容
function WorkspaceRoute() {
  const { id } = useParams();
  return <WorkspacePage key={id} />;
}

export default function App() {
  const loc = useLocation();
  return (
    <Suspense fallback={<div className="empty" style={{ padding: 40 }}>加载中…</div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<HomePage />} />
        <Route path="/c/:id" element={<WorkspaceRoute />} />
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="*" element={<Navigate to="/" replace state={{ from: loc.pathname }} />} />
      </Routes>
    </Suspense>
  );
}
