import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppSettings } from '../src/main/app-settings';
import { awayPermissionDenied, awayQuestionDeclined } from '../src/shared/away-mode';
import { ScriptedApp, type ScriptedPipe } from './helpers/scripted-claude';

// 離席モード（@shared/away-mode）。人に回った許可の確認・質問を、待つ時間のあとにアプリが断る。
// 待つ時間は、テストでは短くする

const WAIT_MS = 40;
// 時間切れが起きないことを確かめるときに待つ長さ（待つ時間より十分に長く）
const LONGER_MS = WAIT_MS * 5;

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
  app.manager.awayWaitMs = () => WAIT_MS;
});
afterEach(() => app.dispose());

const request = (pipe: ScriptedPipe, requestId: string, body: Record<string, unknown>) =>
  pipe.emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_use_id: `toolu_${requestId}`, ...body } });
const answerTo = (pipe: ScriptedPipe, requestId: string) =>
  pipe.messages.flatMap((m) => {
    const response = (m as { type?: string; response?: { request_id?: string; response?: unknown } }).response;
    return m.type === 'control_response' && response?.request_id === requestId ? [response.response] : [];
  });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const infos = (id: string) => app.events(id).flatMap((e) => (e.type === 'info' ? [e.text] : []));
const QUESTIONS = [{ question: 'どちらの方式?', header: '方式', multiSelect: false, options: [{ label: 'A 案', description: '速い' }, { label: 'B 案', description: '確実' }] }];

describe('離席モード', () => {
  it('離席中の親の許可の確認は、待つ時間のうちに答えが無ければ断る（許さない）。Claude には人のやることに残すよう伝え、チャットにも残す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    expect(app.manager.setAway(id, true, 'human')).toBe(true);
    expect(app.manager.summary(id)?.away).toBe(true);
    await app.prompt(id, '押し出して');
    request(pipe, 'req-1', { tool_name: 'Bash', input: { command: 'git push --force' } });
    await app.waitFor('許可の確認', () => app.manager.pendingPermission(id) !== null);
    // 待つ時間の間は、ふつうどおり人が答えられる
    expect(answerTo(pipe, 'req-1')).toEqual([]);
    await app.waitFor('時間切れで断る', () => answerTo(pipe, 'req-1').length === 1);
    expect(answerTo(pipe, 'req-1')).toEqual([{ behavior: 'deny', message: awayPermissionDenied(WAIT_MS) }]);
    expect(awayPermissionDenied(WAIT_MS)).toContain('「人のやること」');
    expect(app.manager.pendingPermission(id)).toBeNull();
    expect(app.manager.stateOf(id)).toBe('working');
    expect(infos(id).some((text) => text.includes('許可の確認を断りました'))).toBe(true);
    // 断ったあとに人が答えても、2 回は返さない
    expect(app.manager.replyPermission(id, 'req-1', { kind: 'allow' })).toBe(false);
  });

  it('離席中の親の質問は、待つ時間のあとに Claude へ返し、自分で決めて確認事項に残すよう伝える（作業は止めない）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.manager.setAway(id, true, 'claude');
    await app.prompt(id, '方式を決めて');
    request(pipe, 'req-q', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('質問', () => app.manager.pendingQuestion(id) !== null);
    await app.waitFor('時間切れで返す', () => answerTo(pipe, 'req-q').length === 1);
    expect(answerTo(pipe, 'req-q')).toEqual([{ behavior: 'deny', message: awayQuestionDeclined(WAIT_MS) }]);
    expect(awayQuestionDeclined(WAIT_MS)).toContain('「確認事項」');
    await app.waitFor('質問が閉じる', () => app.manager.pendingQuestion(id) === null);
    expect(app.manager.stateOf(id)).toBe('working');
  });

  it('待つ時間のうちに人が答えたら、その答えだけを返す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    app.manager.setAway(id, true, 'human');
    app.manager.awayWaitMs = () => LONGER_MS;
    request(pipe, 'req-1', { tool_name: 'Bash', input: { command: 'npm test' } });
    await app.waitFor('許可の確認', () => app.manager.pendingPermission(id) !== null);
    expect(app.manager.replyPermission(id, 'req-1', { kind: 'allow' })).toBe(true);
    await pause(LONGER_MS * 2);
    expect(answerTo(pipe, 'req-1')).toEqual([{ behavior: 'allow', updatedInput: { command: 'npm test' } }]);
  });

  it('離席モードでない親は、今までどおり人の答えを待ち続ける', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    request(pipe, 'req-1', { tool_name: 'Bash', input: { command: 'npm test' } });
    request(pipe, 'req-q', { tool_name: 'AskUserQuestion', input: { questions: QUESTIONS } });
    await app.waitFor('質問', () => app.manager.pendingQuestion(id) !== null && app.manager.pendingPermission(id) !== null);
    await pause(LONGER_MS);
    expect(answerTo(pipe, 'req-1')).toEqual([]);
    expect(answerTo(pipe, 'req-q')).toEqual([]);
    expect(app.manager.summary(id)?.away).toBeUndefined();
  });

  it('入れたときにもう待っている要求は、入れたときから数える。解いたら、待っている要求はそのまま人の答えを待つ', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    request(pipe, 'req-1', { tool_name: 'Bash', input: { command: 'npm test' } });
    await app.waitFor('許可の確認', () => app.manager.pendingPermission(id) !== null);
    app.manager.setAway(id, true, 'human');
    await app.waitFor('時間切れで断る', () => answerTo(pipe, 'req-1').length === 1);
    request(pipe, 'req-2', { tool_name: 'Bash', input: { command: 'npm run build' } });
    await app.waitFor('次の確認', () => app.manager.pendingPermission(id)?.id === 'req-2');
    expect(app.manager.setAway(id, false, 'human')).toBe(true);
    expect(app.manager.summary(id)?.away).toBeUndefined();
    await pause(LONGER_MS);
    expect(answerTo(pipe, 'req-2')).toEqual([]);
    expect(app.manager.pendingPermission(id)?.id).toBe('req-2');
  });

  it('子には効かせない（入れられず、子の要求は親か人の答えを待ち続ける）', async () => {
    const parent = app.create();
    await app.ready(parent.id);
    app.manager.setAway(parent.id, true, 'human');
    const child = app.create({}, parent.id);
    await app.ready(child.id);
    expect(app.manager.setAway(child.id, true, 'claude')).toBe(false);
    expect(app.manager.isAway(child.id)).toBe(false);
    expect(app.manager.summary(child.id)?.away).toBeUndefined();
    request(child.pipe, 'req-c', { tool_name: 'Bash', input: { command: 'npm test' } });
    await app.waitFor('子の許可の確認', () => app.manager.pendingPermission(child.id) !== null);
    await pause(LONGER_MS);
    expect(answerTo(child.pipe, 'req-c')).toEqual([]);
  });

  it('入れた・解いたことを知らせる（画面で解いたときに Claude へ報告を頼むため）。同じ状態への切り替えは知らせない', async () => {
    const { id } = app.create();
    await app.ready(id);
    const changes: [string, boolean, string][] = [];
    app.manager.onAwayChanged = (sid, away, by) => changes.push([sid, away, by]);
    app.manager.setAway(id, true, 'claude');
    app.manager.setAway(id, true, 'human');
    app.manager.setAway(id, false, 'human');
    expect(changes).toEqual([
      [id, true, 'claude'],
      [id, false, 'human'],
    ]);
    expect(infos(id).filter((text) => text.includes('離席モード'))).toHaveLength(2);
  });
});

describe('離席モードで答えを待つ時間の設定', () => {
  it('アプリの設定（settings.json）に覚える。既定は 5 分。選べる値（1・3・5・10・15・30）のほかは、既定に戻す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-away-'));
    try {
      const file = join(dir, 'settings.json');
      expect(new AppSettings(file).awayWaitMinutes()).toBe(5);
      new AppSettings(file).setAwayWaitMinutes(15);
      expect(new AppSettings(file).awayWaitMinutes()).toBe(15);
      expect(JSON.parse(readFileSync(file, 'utf8')).awayWaitMinutes).toBe(15);
      writeFileSync(file, JSON.stringify({ version: 1, awayWaitMinutes: 7 }));
      expect(new AppSettings(file).awayWaitMinutes()).toBe(5);
      writeFileSync(file, JSON.stringify({ version: 1, awayWaitMinutes: '10' }));
      expect(new AppSettings(file).awayWaitMinutes()).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
