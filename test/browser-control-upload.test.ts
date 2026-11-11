import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserToolId } from '../src/shared/browser-tools';
import { BROWSER_GATE_REQUEST } from '../src/main/browser-bridge';
import { answerCdp, setup, textOf } from './helpers/browser-control';

vi.mock('electron', () => import('./helpers/fake-electron').then((m) => m.electronModule));

// アプリ内ブラウザのファイルの添付（upload_file。src/main/browser-control.ts）。
// CDP とページの中のスクリプトは作り物が答え、送った CDP の命令（DOM.setFileInputFiles・ダイアログの横取り）と、Claude に返す文を確かめる

const root = mkdtempSync(join(tmpdir(), 'tanacode-upload-'));
const receipt = join(root, 'receipt.pdf');
const other = join(root, 'other.pdf');
writeFileSync(receipt, '%PDF-1.4');
writeFileSync(other, '%PDF-1.4');
mkdirSync(join(root, 'folder'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

type Page = ReturnType<ReturnType<typeof setup>['open']>;

// ファイル欄の作り物。input: selector がファイル欄に当たるか / multiple: 複数を受け付けるか / at: ファイル欄の文書の URL
const fileInput = (page: Page, options: { input: boolean; multiple?: boolean; at?: string; chooser?: { mode: string; child?: string } }) => {
  answerCdp(page, {
    'Runtime.evaluate': () => (options.input ? { result: { type: 'object', objectId: 'IN1' } } : { result: { type: 'object', subtype: 'null', value: null } }),
    'Runtime.callFunctionOn': (params) =>
      String(params?.functionDeclaration).includes('location.href')
        ? { result: { value: options.at ?? page.url } }
        : { result: { value: { multiple: options.multiple === true, description: 'input[type=file]#receipt' } } },
    'DOM.resolveNode': (params) => ({ object: { objectId: `NODE-${String(params?.backendNodeId)}` } }),
    // 押すと、ページがファイル選択を開く（横取りしているので、ダイアログの代わりに知らせが届く）
    'Input.dispatchMouseEvent': (params) => {
      if (params?.type === 'mouseReleased' && options.chooser) {
        page.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'F0', mode: options.chooser.mode, backendNodeId: 7 }, options.chooser.child);
      }
      return {};
    },
  });
};

const found = { rect: { x: 10, y: 10, width: 80, height: 30 }, viewport: { width: 800, height: 600 }, description: 'button "アップロード"', covered: null };

describe('ファイルの添付（upload_file）', () => {
  it('selector がファイル欄そのもの（隠れていてもよい）なら、押さずに DOM.setFileInputFiles で入れる', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1', { title: '下書き' });
    fileInput(page, { input: true });
    const result = await call('upload_file', { paths: [receipt], selector: 'input[type=file]' });
    expect(textOf(result)).toBe('Attached the file (receipt.pdf) to the file input input[type=file]#receipt.');
    expect(page.debugger.sent('DOM.setFileInputFiles').map((c) => c.params)).toEqual([{ files: [receipt], objectId: 'IN1' }]);
    expect(page.debugger.sent('Page.setInterceptFileChooserDialog')).toEqual([]);
  });

  it('ファイル選択を開く要素なら、ダイアログを横取りしてから押し、開いたファイル欄に入れる。横取りは呼び出しの間だけ', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    page.page.locate = () => found;
    fileInput(page, { input: false, chooser: { mode: 'selectMultiple' } });
    const result = await call('upload_file', { paths: [receipt, other], selector: 'button.upload' });
    expect(textOf(result)).toBe('Clicked button "アップロード", and attached 2 files (receipt.pdf, other.pdf) to the file dialog it opened.');
    expect(page.debugger.sent('Page.setInterceptFileChooserDialog').map((c) => c.params)).toEqual([{ enabled: true }, { enabled: false }]);
    expect(page.debugger.sent('DOM.setFileInputFiles').map((c) => c.params)).toEqual([{ files: [receipt, other], objectId: 'NODE-7' }]);
    // 押したあとで、横取りを切ってから入れる、ではなく、入れてから切る
    const order = page.debugger.commands.map((c) => c.method).filter((m) => m === 'DOM.setFileInputFiles' || m === 'Page.setInterceptFileChooserDialog');
    expect(order).toEqual(['Page.setInterceptFileChooserDialog', 'DOM.setFileInputFiles', 'Page.setInterceptFileChooserDialog']);
  });

  it('押してもファイル選択が開かなければ、入れずにそう伝える（横取りは切る）', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    page.page.locate = () => found;
    fileInput(page, { input: false });
    const result = await call('upload_file', { paths: [receipt], selector: 'button.upload' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no file dialog opened within 5 seconds, so the files were not attached');
    expect(page.debugger.sent('DOM.setFileInputFiles')).toEqual([]);
    expect(page.debugger.sent('Page.setInterceptFileChooserDialog').at(-1)?.params).toEqual({ enabled: false });
  });

  it('1 つしか受け付けないファイル欄に、2 つは入れない', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    fileInput(page, { input: true, multiple: false });
    const direct = await call('upload_file', { paths: [receipt, other], selector: '#receipt' });
    expect(textOf(direct)).toContain('accepts only one file, but 2 files were given');
    page.page.locate = () => found;
    fileInput(page, { input: false, chooser: { mode: 'selectSingle' } });
    const chooser = await call('upload_file', { paths: [receipt, other], selector: 'button.upload' });
    expect(textOf(chooser)).toContain('accepts only one file, but 2 files were given');
    expect(page.debugger.sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('ファイル欄が、確認したページと別のオリジン（別オリジンの iframe）なら入れない', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    page.page.locate = () => found;
    fileInput(page, { input: false, at: 'https://evil.example.test/frame', chooser: { mode: 'selectSingle', child: 'C1' } });
    const result = await call('upload_file', { paths: [receipt], selector: 'button.upload' });
    expect(textOf(result)).toBe(
      'The file input is on another site (https://evil.example.test) than the page tanacode checked (http://workflow.local), so the files were not attached.',
    );
    expect(page.debugger.sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('確認のフックの控えが無い・確かめたあとにページが別のオリジンへ移った・確認したファイルと違うときは入れない', async () => {
    const { call, control, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    fileInput(page, { input: true });
    const noRecord = await call('upload_file', { paths: [receipt], selector: '#receipt' }, 'S1', { gate: false });
    expect(textOf(noRecord)).toContain('tanacode has no record of checking this call, so the files were not attached. Call upload_file again.');
    // フックが見たあとに、別のオリジンへ移った
    await control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('upload_file'), input: { paths: [receipt] }, toolUseId: 'toolu_a' });
    page.url = 'http://other.local/';
    const moved = await call('upload_file', { paths: [receipt], selector: '#receipt' }, 'S1', { gate: false, toolUseId: 'toolu_a' });
    expect(textOf(moved)).toContain('The page changed after tanacode checked it for this call (from http://workflow.local to http://other.local), so the files were not attached.');
    // 同じ呼び出しの控えのファイルと、届いたファイルが違う（ほかのフックが書き換えた）
    page.url = 'http://workflow.local/drafts/1';
    await control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('upload_file'), input: { paths: [receipt] }, toolUseId: 'toolu_b' });
    const changed = await call('upload_file', { paths: [other], selector: '#receipt' }, 'S1', { gate: false, toolUseId: 'toolu_b' });
    expect(textOf(changed)).toContain('The paths of this call differs from the one tanacode checked for it');
    // evaluate の控えは、upload_file には使わない
    await control.handle('S1', BROWSER_GATE_REQUEST, { tool: browserToolId('evaluate'), input: { expression: 'x' }, toolUseId: 'toolu_c' });
    const evaluateMark = await call('upload_file', { paths: [receipt], selector: '#receipt' }, 'S1', { gate: false, toolUseId: 'toolu_c' });
    expect(textOf(evaluateMark)).toContain('tanacode has no record of checking this call');
    expect(page.debugger.sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('絶対パスでない・無い・フォルダのものは入れない', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    fileInput(page, { input: true });
    expect(textOf(await call('upload_file', { paths: ['receipt.pdf'], selector: '#receipt' }))).toBe('Not an absolute path: receipt.pdf. Give the absolute paths of the files to attach.');
    expect(textOf(await call('upload_file', { paths: [join(root, 'missing.pdf')], selector: '#receipt' }))).toBe(`No such file: ${join(root, 'missing.pdf')}`);
    expect(textOf(await call('upload_file', { paths: [join(root, 'folder')], selector: '#receipt' }))).toBe(`Not a file: ${join(root, 'folder')} (folders cannot be attached).`);
    expect(textOf(await call('upload_file', { paths: [], selector: '#receipt' }))).toBe('Provide paths: the absolute paths of the files to attach.');
    expect(page.debugger.sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('位置（x・y）で押した要素がファイル選択を開いても入れる。ほかの CDP の知らせは選択とみなさない', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    page.page.point = () => ({ cross: false, src: null, frame: null, description: 'canvas#drop' });
    fileInput(page, { input: false, chooser: { mode: 'selectSingle' } });
    // 押す前に別の知らせが届いても、選択とはみなさない
    const handler = page.debugger.handler;
    page.debugger.handler = (method, params, child) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') page.debugger.emit('message', {}, 'Page.frameNavigated', { frame: {} });
      return handler(method, params, child);
    };
    const result = await call('upload_file', { paths: [receipt], x: 40, y: 30 });
    expect(textOf(result)).toBe('Clicked canvas#drop at x=40 y=30, and attached the file (receipt.pdf) to the file dialog it opened.');
    expect(page.debugger.sent('DOM.setFileInputFiles').map((c) => c.params)).toEqual([{ files: [receipt], objectId: 'NODE-7' }]);
  });

  it('selector も x・y も無い・許していないページ・ファイル欄が見つからないときは入れない', async () => {
    const { call, open } = setup();
    const page = open('http://workflow.local/drafts/1');
    fileInput(page, { input: true });
    expect(textOf(await call('upload_file', { paths: [receipt] }))).toBe('Provide selector (the file input, or the element that opens the file dialog), or x and y.');
    page.page.locate = () => found;
    fileInput(page, { input: false, chooser: { mode: 'selectSingle' } });
    const resolve = page.debugger.handler;
    page.debugger.handler = (method, params, child) => (method === 'DOM.resolveNode' ? {} : resolve(method, params, child));
    expect(textOf(await call('upload_file', { paths: [receipt], selector: 'button.upload' }))).toBe('Could not find the file input, so the files were not attached.');
    page.url = 'https://outside.example.test/';
    expect(textOf(await call('upload_file', { paths: [receipt], selector: '#receipt' }))).toContain('is not allowed for Claude');
    expect(page.debugger.sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('子の添付の確認は、どのページでも人だけが答える（親の Claude に許させない）', () => {
    const { control, open } = setup();
    open('http://localhost:3000/');
    expect(control.humanOnly('S1', { tool: browserToolId('upload_file') })).toContain('only the user can answer');
  });
});
