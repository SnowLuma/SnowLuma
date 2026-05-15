import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './types';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error('useApi must be used inside <ApiProvider>');
  return client;
}
