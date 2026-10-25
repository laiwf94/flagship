import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { ToastProvider } from './components/toast';
import { Loading } from './components/ui';
import { FlagList } from './pages/FlagList';
import { Home } from './pages/Home';
import { Layout } from './pages/Layout';
import { NotFound } from './pages/NotFound';
import { SignIn } from './pages/SignIn';
import { SessionProvider, useSession } from './session';

function RequireSession() {
  const { user, checking } = useSession();
  const location = useLocation();
  if (checking) return <Loading rows={3} label="Checking your session" />;
  if (user === null) {
    return (
      <Navigate
        to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }
  return <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route element={<RequireSession />}>
        <Route index element={<Home />} />
        <Route path="/p/:project/:env" element={<Layout />}>
          <Route index element={<Navigate to="flags" replace />} />
          <Route path="flags" element={<FlagList />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </SessionProvider>
  );
}
