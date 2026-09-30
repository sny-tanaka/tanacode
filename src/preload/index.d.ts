import type { TanacodeApi } from '../shared/ipc';

declare global {
  interface Window {
    tanacode: TanacodeApi;
  }
}
