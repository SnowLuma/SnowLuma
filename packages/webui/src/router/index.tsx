import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from '@tanstack/react-router';
import { AppLayout } from './app-layout';
// Imported eagerly (not lazy): the error / not-found fallbacks must render
// even when a route's own chunk failed to load.
import { ErrorPage, NotFoundPage } from '@/components/pages/status-screens';

// Page components are loaded on demand so the initial paint only ships
// the auth surface + layout shell. With `defaultPreload: 'intent'` set
// below, the router warms the next chunk on hover/focus, so navigation
// still feels instant after the first idle moment. Previously every
// page (overview / config / logs / settings) lived in the single
// ~600 kB bundle that Vite explicitly warned about — config-page edit
// dialog alone pulls in a large form surface that most users never
// touch on first visit.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const appLayoutRoute = createRoute({
  id: 'app-layout',
  getParentRoute: () => rootRoute,
  component: AppLayout,
});

const overviewRoute = createRoute({
  path: '/',
  getParentRoute: () => appLayoutRoute,
  component: lazyRouteComponent(
    () => import('@/components/pages/overview-page'),
    'OverviewPage',
  ),
});

const processesRoute = createRoute({
  path: '/processes',
  getParentRoute: () => appLayoutRoute,
  component: lazyRouteComponent(
    () => import('@/components/pages/processes-page'),
    'ProcessesPage',
  ),
});

const configRoute = createRoute({
  path: '/config',
  getParentRoute: () => appLayoutRoute,
  component: lazyRouteComponent(
    () => import('@/components/pages/config-page'),
    'ConfigPage',
  ),
});

const logsRoute = createRoute({
  path: '/logs',
  getParentRoute: () => appLayoutRoute,
  component: lazyRouteComponent(
    () => import('@/components/pages/logs-page'),
    'LogsPage',
  ),
});

const settingsRoute = createRoute({
  path: '/settings',
  getParentRoute: () => appLayoutRoute,
  component: lazyRouteComponent(
    () => import('@/components/pages/settings-page'),
    'SettingsPage',
  ),
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([overviewRoute, processesRoute, configRoute, logsRoute, settingsRoute]),
]);

export const appRouter = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultNotFoundComponent: () => <NotFoundPage />,
  defaultErrorComponent: ({ error, reset }) => <ErrorPage error={error} reset={reset} />,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof appRouter;
  }
}

/** Paths registered on the layout — single source of truth for nav metadata. */
export type AppPath = '/' | '/processes' | '/config' | '/logs' | '/settings';
