import type { HostMessage } from '@shared/remote-protocol';
import { join } from 'node:path';
import { RemoteServerCore } from './remote-server-core';

// 遠隔サーバー（Issue #464）。main が utilityProcess で起動し、process.parentPort で伝文をやりとりする（remote-host.ts）。
// 中身は remote-server-core.ts（テストは、こちらを直に動かす）
const parent = process.parentPort;
// 画面のファイル（スマホ用の入口 remote.html を含む）は、この out/main/remote-server.js から見て ../renderer にある
const core = new RemoteServerCore((message) => parent.postMessage(message), Date.now, join(__dirname, '../renderer'));
parent.on('message', (event) => core.handle(event.data as HostMessage));
