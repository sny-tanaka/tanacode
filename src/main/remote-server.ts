import type { HostMessage } from '@shared/remote-protocol';
import { RemoteServerCore } from './remote-server-core';

// 遠隔サーバー（Issue #464）。main が utilityProcess で起動し、process.parentPort で伝文をやりとりする（remote-host.ts）。
// 中身は remote-server-core.ts（テストは、こちらを直に動かす）
const parent = process.parentPort;
const core = new RemoteServerCore((message) => parent.postMessage(message));
parent.on('message', (event) => core.handle(event.data as HostMessage));
