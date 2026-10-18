import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedApp, type ScriptedPipe } from './helpers/scripted-claude';

// SessionManager の、MCP サーバーから人への質問（Claude Code の control_request の elicitation）。カードに渡し、答えを Claude Code に返す。
// URL の形は、ページを開いたら完了を待つカードにし、system/elicitation_complete で閉じる（本物の claude では test/cli/elicitation.test.ts）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const elicit = (pipe: ScriptedPipe, requestId: string, body: Record<string, unknown>) =>
  pipe.emit({ type: 'control_request', request_id: requestId, request: { subtype: 'elicitation', mcp_server_name: 'deploy', message: 'どこに出しますか？', ...body } });
const answerTo = (pipe: ScriptedPipe, requestId: string) =>
  pipe.messages.flatMap((m) => {
    const response = (m as { type?: string; response?: { request_id?: string; response?: unknown } }).response;
    return m.type === 'control_response' && response?.request_id === requestId ? [response.response] : [];
  });

const SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', title: '出す先', enum: ['staging', 'production'], enumNames: ['ステージング', '本番'] },
    replicas: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
    note: { type: 'string', maxLength: 10 },
  },
  required: ['target'],
};

describe('MCP サーバーの質問（フォームの形）', () => {
  it('カードの形にして渡し、質問への回答待ちにして 1 回知らせる。確かめた中身を accept で返すと、カードを閉じる', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, '出して');
    elicit(pipe, 'e1', { requested_schema: SCHEMA, property_order: ['replicas', 'target', 'note'], title: '出す先の確認' });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    const pending = app.manager.pendingElicitation(id)!;
    expect(pending).toMatchObject({ id: 'e1', server: 'deploy', message: 'どこに出しますか？', title: '出す先の確認', mode: 'form', url: null, unsupported: [], opened: false });
    // 項目は Claude Code が付けた順（property_order）
    expect(pending.fields.map((f) => f.key)).toEqual(['replicas', 'target', 'note']);
    expect(pending.fields[1]).toMatchObject({ type: 'select', title: '出す先', required: true, options: [{ value: 'staging', label: 'ステージング' }, { value: 'production', label: '本番' }] });
    expect(app.elicitationLog.at(-1)).toEqual({ id, elicitation: pending });
    expect(app.manager.stateOf(id)).toBe('question');
    expect(app.manager.summary(id)?.attention).toBe('question');
    // 通知の本文は、どのサーバーからかと質問の文
    expect(app.attentions).toMatchObject([{ id, attention: { kind: 'menu', menu: { kind: 'question', title: 'MCP サーバー「deploy」からの質問: どこに出しますか？' } } }]);
    // 許可の確認でも、AskUserQuestion でもない
    expect(app.manager.pendingPermission(id)).toBeNull();
    expect(app.manager.pendingQuestion(id)).toBeNull();

    // 項目に合わない中身・知らない項目・形の違う答えは送らない
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'accept', content: { replicas: 9, target: 'staging' } })).toBe(false);
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'accept', content: { target: 'staging', extra: 'x' } })).toBe(false);
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'accept', content: { replicas: 2 } })).toBe(false);
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'open' })).toBe(false);
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'dismiss' })).toBe(false);
    expect(answerTo(pipe, 'e1')).toEqual([]);

    expect(app.manager.replyElicitation(id, 'e1', { kind: 'accept', content: { target: 'production', replicas: 3 } })).toBe(true);
    expect(answerTo(pipe, 'e1')).toEqual([{ action: 'accept', content: { target: 'production', replicas: 3 } }]);
    expect(app.manager.pendingElicitation(id)).toBeNull();
    expect(app.elicitationLog.at(-1)).toEqual({ id, elicitation: null });
    expect(app.manager.stateOf(id)).toBe('working');
    // もう待っていない
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'decline' })).toBe(false);
    expect(answerTo(pipe, 'e1')).toHaveLength(1);
  });

  it('断る・答えずに閉じるは、decline・cancel で返す。項目の無い質問は、空の中身で accept できる', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'e1', { requested_schema: SCHEMA });
    elicit(pipe, 'e2', { requested_schema: SCHEMA });
    elicit(pipe, 'e3', { message: '続けますか？' });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id)?.id === 'e1');
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'decline' })).toBe(true);
    // 来た順に、次の質問を出す
    expect(app.manager.pendingElicitation(id)?.id).toBe('e2');
    expect(app.manager.replyElicitation(id, 'e2', { kind: 'cancel' })).toBe(true);
    expect(app.manager.pendingElicitation(id)).toMatchObject({ id: 'e3', fields: [], unsupported: [] });
    expect(app.manager.replyElicitation(id, 'e3', { kind: 'accept', content: {} })).toBe(true);
    expect([answerTo(pipe, 'e1'), answerTo(pipe, 'e2'), answerTo(pipe, 'e3')]).toEqual([[{ action: 'decline' }], [{ action: 'cancel' }], [{ action: 'accept', content: {} }]]);
    // 続けて来た質問では、操作待ちを知らせ直さない（回答待ちのまま）
    expect(app.attentions).toHaveLength(1);
  });

  it('出せない形の項目があれば、その名前を渡し、断ることだけ受け付ける', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'e1', { requested_schema: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'object', properties: {} } } } });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    expect(app.manager.pendingElicitation(id)).toMatchObject({ fields: [{ key: 'name' }], unsupported: ['address'] });
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'accept', content: { name: 'a' } })).toBe(false);
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'decline' })).toBe(true);
    expect(answerTo(pipe, 'e1')).toEqual([{ action: 'decline' }]);
  });

  it('文・項目の名前・選択肢の名前の制御文字は消して渡す（返す値の名前と選択肢の値はそのまま）', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'e1', {
      mcp_server_name: 'de‮ploy',
      message: '\u001b[31m赤\u001b[0m の質問\u0007',
      requested_schema: { type: 'object', properties: { 'k\u0001': { type: 'string', title: 'T\u001b[1mi', oneOf: [{ const: 'v\u0002', title: 'L‮x' }] } } },
    });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    const pending = app.manager.pendingElicitation(id)!;
    expect(pending.server).toBe('deploy');
    expect(pending.message).toBe('赤 の質問');
    expect(pending.fields).toEqual([{ key: 'k\u0001', title: 'Ti', description: null, required: false, type: 'select', options: [{ value: 'v\u0002', label: 'Lx' }], default: null }]);
  });
});

describe('MCP サーバーの質問（URL の形）', () => {
  it('ページを開くと、ふだんのブラウザで開いて accept を返し、完了を待つカードにする。完了の知らせで閉じる', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    await app.prompt(id, 'つないで');
    elicit(pipe, 'u1', { mode: 'url', message: 'ログインしてください', url: 'https://user@例え.jp/auth?state=x', elicitation_id: 'el-1' });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    // ホストは punycode にして出す（見た目の似た文字のホストに惑わされないように）
    expect(app.manager.pendingElicitation(id)).toMatchObject({ id: 'u1', mode: 'url', url: 'https://user@xn--r8jz45g.jp/auth?state=x', openable: true, fields: [], opened: false });
    expect(app.manager.stateOf(id)).toBe('question');
    expect(app.manager.replyElicitation(id, 'u1', { kind: 'accept', content: {} })).toBe(false);
    expect(app.manager.replyElicitation(id, 'u1', { kind: 'open' })).toBe(true);
    expect(answerTo(pipe, 'u1')).toEqual([{ action: 'accept' }]);
    expect(app.openedUrls).toEqual(['https://user@xn--r8jz45g.jp/auth?state=x']);
    // 完了を待っている間、Claude Code は答えを待っていないので、回答待ちにしない
    const waiting = app.manager.pendingElicitation(id)!;
    expect(waiting).toMatchObject({ id: 'opened:u1', opened: true, url: 'https://user@xn--r8jz45g.jp/auth?state=x' });
    expect(app.elicitationLog.at(-1)).toEqual({ id, elicitation: waiting });
    expect(app.manager.stateOf(id)).toBe('working');
    expect(app.manager.summary(id)?.attention).toBeNull();
    // もう一度開ける。完了待ちのカードの答えは、Claude Code には送らない
    expect(app.manager.replyElicitation(id, 'opened:u1', { kind: 'reopen' })).toBe(true);
    expect(app.manager.replyElicitation(id, 'opened:u1', { kind: 'open' })).toBe(false);
    expect(app.openedUrls).toHaveLength(2);
    expect(answerTo(pipe, 'u1')).toHaveLength(1);
    // ほかのサーバー・ほかの質問の完了では閉じない
    pipe.emit({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'other', elicitation_id: 'el-1', uuid: 'c0', session_id: 's' });
    pipe.emit({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'deploy', elicitation_id: 'el-2', uuid: 'c1', session_id: 's' });
    pipe.emit({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'deploy', elicitation_id: 'el-1', uuid: 'c2', session_id: 's' });
    await app.waitFor('完了', () => app.manager.pendingElicitation(id) === null);
    expect(app.elicitationLog.at(-1)).toEqual({ id, elicitation: null });
    expect(app.manager.replyElicitation(id, 'opened:u1', { kind: 'dismiss' })).toBe(false);
  });

  it('完了待ちのカードは「閉じる」で消せる。elicitation_id の無い質問は、開いても完了を待たない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'u1', { mode: 'url', url: 'https://example.com/a', elicitation_id: 'el-1' });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    app.manager.replyElicitation(id, 'u1', { kind: 'open' });
    expect(app.manager.replyElicitation(id, 'opened:u1', { kind: 'dismiss' })).toBe(true);
    expect(app.manager.pendingElicitation(id)).toBeNull();
    elicit(pipe, 'u2', { mode: 'url', url: 'https://example.com/b' });
    await app.waitFor('次の質問', () => app.manager.pendingElicitation(id) !== null);
    expect(app.manager.replyElicitation(id, 'u2', { kind: 'open' })).toBe(true);
    expect(app.manager.pendingElicitation(id)).toBeNull();
    expect(app.openedUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('http・https でないページは開かず、断ることだけ受け付ける', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'u1', { mode: 'url', url: 'javascript:alert(1)', elicitation_id: 'el-1' });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    expect(app.manager.pendingElicitation(id)).toMatchObject({ url: 'javascript:alert(1)', openable: false });
    expect(app.manager.replyElicitation(id, 'u1', { kind: 'open' })).toBe(false);
    expect(app.openedUrls).toEqual([]);
    expect(app.manager.replyElicitation(id, 'u1', { kind: 'decline' })).toBe(true);
    expect(answerTo(pipe, 'u1')).toEqual([{ action: 'decline' }]);
  });
});

describe('MCP サーバーの質問の取り下げと終了', () => {
  it('取り下げられた質問（スマホで答えた・ツールの中断）は、カードから消し、あとから答えても返さない', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'e1', { requested_schema: SCHEMA });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    pipe.emit({ type: 'control_cancel_request', request_id: 'e1' });
    await app.waitFor('取り下げ', () => app.manager.pendingElicitation(id) === null);
    expect(app.manager.summary(id)?.attention).toBeNull();
    expect(app.manager.replyElicitation(id, 'e1', { kind: 'decline' })).toBe(false);
    expect(answerTo(pipe, 'e1')).toEqual([]);
  });

  it('claude が終わったら、待っている質問も、完了待ちのカードも消す', async () => {
    const { id, pipe } = app.create();
    await app.ready(id);
    elicit(pipe, 'u1', { mode: 'url', url: 'https://example.com/a', elicitation_id: 'el-1' });
    await app.waitFor('質問', () => app.manager.pendingElicitation(id) !== null);
    app.manager.replyElicitation(id, 'u1', { kind: 'open' });
    elicit(pipe, 'e2', { requested_schema: SCHEMA });
    await app.waitFor('次の質問', () => app.manager.pendingElicitation(id)?.id === 'e2');
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(app.manager.pendingElicitation(id)).toBeNull();
    expect(app.elicitationLog.at(-1)).toEqual({ id, elicitation: null });
    expect(app.manager.summary(id)?.attention).toBeNull();
  });
});
