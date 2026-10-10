import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewSessionOptions, SessionSummary } from '@shared/ipc';
import type { ScreenInfo } from '@shared/screen';
import { BROWSER_MCP } from '@shared/browser-tools';
import { CHECKLIST_MCP } from '@shared/checklist-tools';
import { allowedToolIds, mcpToolLabel, type McpServerDef, type McpTool } from '@shared/mcp-tools';
import { SESSIONS_MCP, SESSIONS_MCP_FOR_CHILD } from '@shared/session-tools';
import { WALKTHROUGH_MCP } from '@shared/walkthrough-tools';
import { ChecklistControl } from '../src/main/checklist-control';
import { ChecklistStore } from '../src/main/checklist-store';
import type { ToolResult } from '../src/main/mcp-bridge';
import { SessionsControl, type SessionsHost } from '../src/main/sessions-control';
import { WalkthroughControl } from '../src/main/walkthrough-control';

// Claude Code に足す MCP サーバー（アプリ内ブラウザ・セッション・チェックリスト・ウォークスルー）の、ツールの定義と制御の契約。
// - 定義の形（名前・説明・引数のスキーマ）が、Claude Code に渡せる形になっているか
// - 定義の形（名前・種類・引数・許可済みにするか）が変わったら、控え（__snapshots__）との差分で気づけるか
// - 定義にあるツールを、制御（*-control.ts）が漏れなく振り分けるか。制御が読む引数が、スキーマにあるか
//   （スキーマに無い引数は、Claude が渡せないので、その機能は黙って動かない）

const SERVERS: { def: McpServerDef; control: string; dispatch: string }[] = [
  // ask_user_to_act は振り分けの前（handle）で扱う
  { def: BROWSER_MCP, control: 'src/main/browser-control.ts', dispatch: 'private async dispatch(' },
  { def: SESSIONS_MCP, control: 'src/main/sessions-control.ts', dispatch: 'async handle(' },
  { def: CHECKLIST_MCP, control: 'src/main/checklist-control.ts', dispatch: 'private run(' },
  { def: WALKTHROUGH_MCP, control: 'src/main/walkthrough-control.ts', dispatch: 'private async run(' },
];

type Schema = { type?: string; enum?: unknown[]; description?: string; items?: Schema; properties?: Record<string, Schema>; required?: string[] };

// スキーマのおかしいところ（path: どの引数か）
function schemaProblems(schema: Schema, path: string): string[] {
  const problems: string[] = [];
  if (!schema.type && !schema.enum) problems.push(`${path}: type が無い`);
  if (schema.type === 'array' && !schema.items) problems.push(`${path}: 配列の items が無い`);
  if (schema.items) problems.push(...schemaProblems(schema.items, `${path}[]`));
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!property.description?.trim() && !(property.type === 'object' || property.type === 'array')) problems.push(`${path}.${name}: 説明が無い`);
    problems.push(...schemaProblems(property, `${path}.${name}`));
  }
  for (const name of schema.required ?? []) if (!schema.properties?.[name]) problems.push(`${path}: 必須の ${name} が properties に無い`);
  return problems;
}

// 控えに残す形。説明の文は入れない（直すたびに控えを書き直さなくてよいように）
function shape(schema: Schema): unknown {
  return {
    type: schema.type ?? null,
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.items ? { items: shape(schema.items) } : {}),
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, shape(v)])) } : {}),
    ...(schema.required ? { required: schema.required } : {}),
  };
}

// 制御のソースのうち、method で始まるメソッドの中身（字下げ 2 の閉じ括弧まで）
function methodBody(source: string, method: string): string {
  const start = source.indexOf(method);
  if (start < 0) throw new Error(`${method} が見つかりません`);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end);
}

describe.each(SERVERS)('MCP サーバー $def.name の定義', ({ def }) => {
  it('ツールの名前とラベルが重ならず、名前は英小文字と _ だけ', () => {
    const names = def.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(def.tools.map((t) => mcpToolLabel(def, t))).size).toBe(names.length);
    expect(names.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n))).toEqual([]);
  });

  it('サーバーの説明（instructions）と、ツールごとの説明・ラベルがある', () => {
    expect(def.title.trim()).not.toBe('');
    expect(def.instructions.trim()).not.toBe('');
    expect(def.tools.filter((t) => !t.description.trim() || !mcpToolLabel(def, t).trim()).map((t) => t.name)).toEqual([]);
  });

  it('説明（instructions）で、人に頼まれなくても使うことと、人が読むものは人が使っている言葉で書くことを伝える', () => {
    expect(def.instructions).toContain('do not wait to be asked');
    expect(def.instructions).toContain('in the language the user is using');
  });

  it('引数のスキーマが、Claude Code に渡せる形（型・説明があり、必須の引数が properties にあり、ほかの引数を受け付けない）', () => {
    const problems = def.tools.flatMap((t: McpTool) => [
      ...(t.inputSchema.type !== 'object' ? [`${t.name}: type が object でない`] : []),
      ...(t.inputSchema.additionalProperties !== false ? [`${t.name}: additionalProperties が false でない`] : []),
      ...schemaProblems(t.inputSchema as Schema, t.name),
    ]);
    expect(problems).toEqual([]);
  });

  it('ツールの名前・種類・引数の形・許可済みにするものが、控えと同じ（変えたら npx vitest -u で控えを書き直す）', () => {
    expect({
      tools: def.tools.map((t) => ({ name: t.name, kind: t.kind, label: mcpToolLabel(def, t), inputSchema: shape(t.inputSchema as Schema) })),
      allowedTools: allowedToolIds(def),
    }).toMatchSnapshot();
  });
});

describe.each(SERVERS)('MCP サーバー $def.name と制御（$control）', ({ def, control, dispatch }) => {
  const source = readFileSync(control, 'utf8');

  it('定義にあるツールを、制御が漏れなく振り分ける。定義に無いツールの振り分けも残っていない', () => {
    const body = methodBody(source, dispatch);
    const handled = new Set([...body.matchAll(/case '(\w+)':|name === '(\w+)'/g)].map((m) => m[1] ?? m[2]));
    // ユーザーに操作を頼むツールは、振り分けの前に扱う
    const expected = def.tools.filter((t) => t.kind !== 'ask').map((t) => t.name);
    expect(expected.filter((name) => !handled.has(name))).toEqual([]);
    expect([...handled].filter((name) => !expected.includes(name))).toEqual([]);
  });

  it('制御が読む引数（args.xxx）は、どれかのツールのスキーマにある', () => {
    const known = new Set(def.tools.flatMap((t) => Object.keys(t.inputSchema.properties)));
    const read = new Set([...source.matchAll(/\bargs\.(\w+)|\bargs\[['"](\w+)['"]\]/g)].map((m) => m[1] ?? m[2]));
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('子セッションに渡すセッションの MCP サーバー', () => {
  it('ツールは、親に渡すものの一部で、定義も同じ', () => {
    for (const tool of SESSIONS_MCP_FOR_CHILD.tools) expect(SESSIONS_MCP.tools.find((t) => t.name === tool.name)).toEqual(tool);
    expect(SESSIONS_MCP_FOR_CHILD.name).toBe(SESSIONS_MCP.name);
  });
});

// ---- 動かして確かめる（セッション・チェックリスト・ウォークスルー。アプリ内ブラウザは、Electron の webContents が要るので上の読み取りだけ）

// スキーマから、それらしい引数を作る（enum は最初の値、数は最小値か 1）
function sampleArgs(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sampleArgs(v)]));
    case 'array':
      return schema.items ? [sampleArgs(schema.items)] : [];
    case 'string':
      return 'x';
    case 'number':
    case 'integer':
      return (schema as { minimum?: number }).minimum ?? 1;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

const ME = '11111111-0000-4000-8000-000000000001';
const summary = (id: string, cwd: string): SessionSummary => ({
  id,
  title: 'わたし',
  cwd,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: true,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
  parentId: null,
});
const promptScreen: ScreenInfo = { state: { kind: 'prompt' }, model: null, effort: null, mode: null, draft: '', ready: true };

// SessionManager の代わり。呼び出し元のセッションが 1 つだけある
function fakeHost(cwd: string): SessionsHost {
  const sessions = [summary(ME, cwd)];
  return {
    list: () => sessions,
    parentOf: () => null,
    stateOf: () => 'idle',
    modeOf: () => 'manual',
    conversation: async () => [],
    screen: () => promptScreen,
    create: (dir: string, _options: NewSessionOptions, parentId: string | null) => {
      sessions.push({ ...summary('22222222-0000-4000-8000-000000000002', dir), parentId });
      return '22222222-0000-4000-8000-000000000002';
    },
    createInWorktree: async () => '22222222-0000-4000-8000-000000000002',
    rename: () => {},
    open: async () => {},
    submitWhenReady: async () => {},
    interrupt: () => {},
    withdrawParentDraft: async () => {},
    askedQuestions: () => null,
    chooseIf: async () => false,
    watchState: () => () => {},
  };
}

const textOf = (result: ToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('どのツールも、制御が振り分けて実行する（「Unknown tool」にならない）', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-mcp-contract-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const unknown = (name: string) => `Unknown tool: ${name}`;

  it('セッション', async () => {
    const control = new SessionsControl({ host: fakeHost(dir), enabled: () => true, home: '/nonexistent-home', notifyDelayMs: 10 });
    try {
      for (const tool of SESSIONS_MCP.tools) {
        const result = await control.handle(ME, tool.name, sampleArgs(tool.inputSchema as Schema) as Record<string, unknown>);
        expect(textOf(result), tool.name).not.toBe(unknown(tool.name));
      }
      // 知らない名前は断る（上の確かめが空振りしていないか）
      expect(textOf(await control.handle(ME, 'no_such_tool', {}))).toBe(unknown('no_such_tool'));
    } finally {
      control.dispose();
    }
  });

  it('チェックリスト', async () => {
    const store = new ChecklistStore(join(dir, 'checklists'));
    const control = new ChecklistControl({ store, host: fakeHost(dir), enabled: () => true, notifyDelayMs: 10 });
    try {
      for (const tool of CHECKLIST_MCP.tools) {
        const result = await control.handle(ME, tool.name, sampleArgs(tool.inputSchema as Schema) as Record<string, unknown>);
        expect(textOf(result), tool.name).not.toBe(unknown(tool.name));
      }
      expect(textOf(await control.handle(ME, 'no_such_tool', {}))).toBe(unknown('no_such_tool'));
    } finally {
      control.dispose();
    }
  });

  it('ウォークスルー', async () => {
    const control = new WalkthroughControl({ cwdOf: () => dir, enabled: () => true, onChange: () => {}, clock: () => 0 });
    for (const tool of WALKTHROUGH_MCP.tools) {
      const result = await control.handle(ME, tool.name, sampleArgs(tool.inputSchema as Schema) as Record<string, unknown>);
      expect(textOf(result), tool.name).not.toBe(unknown(tool.name));
    }
    expect(textOf(await control.handle(ME, 'no_such_tool', {}))).toBe(unknown('no_such_tool'));
  });
});
