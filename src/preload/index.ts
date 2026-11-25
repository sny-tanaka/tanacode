import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { createApi } from '@shared/api-bindings';
import { LANGUAGE_ARG, type IpcEvent, type IpcInvoke, type IpcSend } from '@shared/ipc';

// Mac の画面の window.tanacode。対応表は shared/api-bindings.ts（スマホの画面と同じもの）で、ここは Electron の IPC で運ぶだけ。
// チャンネルごとの引数・戻り値・知らせの中身は、shared/ipc.ts の表（IpcInvoke・IpcSend・IpcEvent）で決まる。
// main の受け口・送り口も同じ表で型を付けるので、食い違うと型チェックで止まる
function invoke<C extends keyof IpcInvoke>(channel: C, ...args: Parameters<IpcInvoke[C]>): ReturnType<IpcInvoke[C]> {
  return ipcRenderer.invoke(channel, ...args) as ReturnType<IpcInvoke[C]>;
}

function send<C extends keyof IpcSend>(channel: C, ...args: Parameters<IpcSend[C]>): void {
  ipcRenderer.send(channel, ...args);
}

function subscribe<C extends keyof IpcEvent>(channel: C, listener: (payload: IpcEvent[C]) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: IpcEvent[C]) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

// 画面の言語。main がウインドウを作るときに起動の引数で渡す（無ければ日本語）
const language = process.argv.find((arg) => arg.startsWith(LANGUAGE_ARG))?.slice(LANGUAGE_ARG.length) === 'en' ? 'en' : 'ja';

contextBridge.exposeInMainWorld('tanacode', createApi({ invoke, send, subscribe, pathForFile: (file) => webUtils.getPathForFile(file), language: () => language }));
