import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { OverviewPage } from '@/components/pages/overview-page';
import { ConfigPage } from '@/components/pages/config-page';
import { LogsPage } from '@/components/pages/logs-page';
import { SettingsPage } from '@/components/pages/settings-page';
import { AppLayout } from './app-layout';

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
  component: OverviewPage,
});

const configRoute = createRoute({
  path: '/config',
  getParentRoute: () => appLayoutRoute,
  component: ConfigPage,
});

const logsRoute = createRoute({
  path: '/logs',
  getParentRoute: () => appLayoutRoute,
  component: LogsPage,
});

const settingsRoute = createRoute({
  path: '/settings',
  getParentRoute: () => appLayoutRoute,
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([overviewRoute, configRoute, logsRoute, settingsRoute]),
]);

export const appRouter = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof appRouter;
  }
}

/** Paths registered on the layout — single source of truth for nav metadata. */
export type AppPath = '/' | '/config' | '/logs' | '/settings';
