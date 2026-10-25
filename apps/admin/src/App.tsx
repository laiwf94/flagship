import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router';
import { ToastProvider } from './components/toast';
import { Loading } from './components/ui';
import { FlagDetail } from './pages/FlagDetail';
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

function Root() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    </SessionProvider>
  );
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/sign-in', element: <SignIn /> },
      {
        element: <RequireSession />,
        children: [
          { index: true, element: <Home /> },
          {
            path: '/p/:project/:env',
            element: <Layout />,
            children: [
              { index: true, element: <Navigate to="flags" replace /> },
              { path: 'flags', element: <FlagList /> },
              { path: 'flags/:flag', element: <FlagDetail /> },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];

export function App() {
  return <RouterProvider router={createBrowserRouter(routes)} />;
}
