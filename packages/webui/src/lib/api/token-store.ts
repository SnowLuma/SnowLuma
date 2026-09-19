import type { TokenStore } from './types';

export function localStorageTokenStore(key: string): TokenStore {
  return {
    load: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save: (token) => {
      try {
        if (token == null) localStorage.removeItem(key);
        else localStorage.setItem(key, token);
      } catch { /* private mode / storage blocked */ }
    },
  };
}
