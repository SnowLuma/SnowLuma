import type { TokenStore } from './types';

export function localStorageTokenStore(key: string): TokenStore {
  return {
    load: () => localStorage.getItem(key),
    save: (token) => {
      if (token == null) localStorage.removeItem(key);
      else localStorage.setItem(key, token);
    },
  };
}
