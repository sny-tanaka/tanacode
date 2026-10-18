import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkedContent,
  dateTimeOf,
  elicitationFieldsOf,
  elicitationReplyOf,
  fieldProblem,
  initialDraft,
  openableUrl,
  readDraft,
  type ElicitationField,
} from '../src/shared/elicitation';

// MCP サーバーの質問の項目の読み取りと、入力の確かめ（src/shared/elicitation.ts）。
// 項目の形は MCP の仕様（@modelcontextprotocol/sdk 1.32 の PrimitiveSchemaDefinition）のとおり

const fieldsOf = (properties: Record<string, unknown>, required: string[] = []) => elicitationFieldsOf({ type: 'object', properties, required });
const one = (schema: unknown, required = false): ElicitationField => {
  const { fields, unsupported } = fieldsOf({ f: schema }, required ? ['f'] : []);
  expect(unsupported).toEqual([]);
  return fields[0];
};

afterEach(() => vi.unstubAllEnvs());

describe('項目の読み取り（elicitationFieldsOf）', () => {
  it('文字・数・整数・はい／いいえの項目を、名前・説明・必須・上限下限・既定値と読む', () => {
    const { fields, unsupported } = fieldsOf(
      {
        name: { type: 'string', title: '名前', description: '表示名', minLength: 2, maxLength: 20, default: 'tana' },
        mail: { type: 'string', format: 'email' },
        when: { type: 'string', format: 'date-time' },
        // 知らない format は、ふつうの文字として受ける
        time: { type: 'string', format: 'time' },
        size: { type: 'number', minimum: 0.5, maximum: 9.5, default: 1.5 },
        count: { type: 'integer', minimum: 1 },
        ok: { type: 'boolean', default: true },
      },
      ['name', 'count'],
    );
    expect(unsupported).toEqual([]);
    expect(fields).toEqual([
      { key: 'name', title: '名前', description: '表示名', required: true, type: 'text', format: null, minLength: 2, maxLength: 20, default: 'tana' },
      { key: 'mail', title: 'mail', description: null, required: false, type: 'text', format: 'email', minLength: null, maxLength: null, default: null },
      { key: 'when', title: 'when', description: null, required: false, type: 'text', format: 'date-time', minLength: null, maxLength: null, default: null },
      { key: 'time', title: 'time', description: null, required: false, type: 'text', format: null, minLength: null, maxLength: null, default: null },
      { key: 'size', title: 'size', description: null, required: false, type: 'number', integer: false, minimum: 0.5, maximum: 9.5, default: 1.5 },
      { key: 'count', title: 'count', description: null, required: true, type: 'number', integer: true, minimum: 1, maximum: null, default: null },
      { key: 'ok', title: 'ok', description: null, required: false, type: 'boolean', default: true },
    ]);
  });

  it('選択肢（1 つ）を enum・前の書き方の enumNames・oneOf の表示名つきで読み、選択肢に無い既定値は捨てる', () => {
    expect(one({ type: 'string', enum: ['a', 'b'], default: 'b' })).toMatchObject({ type: 'select', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], default: 'b' });
    expect(one({ type: 'string', enum: ['a', 'b'], enumNames: ['エー', 'ビー'], default: 'z' })).toMatchObject({ options: [{ value: 'a', label: 'エー' }, { value: 'b', label: 'ビー' }], default: null });
    // 数の合わない enumNames は使わない
    expect(one({ type: 'string', enum: ['a', 'b'], enumNames: ['エー'] })).toMatchObject({ options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] });
    expect(one({ type: 'string', oneOf: [{ const: 'jp', title: '日本' }, { const: 'us', title: 'アメリカ' }] })).toMatchObject({ type: 'select', options: [{ value: 'jp', label: '日本' }, { value: 'us', label: 'アメリカ' }] });
  });

  it('選択肢（複数）を items.enum・items.anyOf で読み、個数の上限下限と、選択肢にある既定値を読む', () => {
    expect(one({ type: 'array', items: { type: 'string', enum: ['r', 'g', 'b'] }, minItems: 1, maxItems: 2, default: ['g', 'x'] })).toMatchObject({
      type: 'multi',
      options: [{ value: 'r', label: 'r' }, { value: 'g', label: 'g' }, { value: 'b', label: 'b' }],
      minItems: 1,
      maxItems: 2,
      default: ['g'],
    });
    expect(one({ type: 'array', items: { anyOf: [{ const: 'r', title: '赤' }] } })).toMatchObject({ type: 'multi', options: [{ value: 'r', label: '赤' }], default: null });
  });

  it('出せない形（入れ子・items の無い array・文字でない enum・type の無いもの）は、名前を unsupported にする', () => {
    const { fields, unsupported } = fieldsOf({
      ok: { type: 'string' },
      nested: { type: 'object', properties: {} },
      list: { type: 'array' },
      numbers: { type: 'array', items: { type: 'number' } },
      badEnum: { type: 'string', enum: [1, 2] },
      none: { title: '型なし' },
      weird: 'x',
    });
    expect(fields.map((f) => f.key)).toEqual(['ok']);
    expect(unsupported).toEqual(['nested', 'list', 'numbers', 'badEnum', 'none', 'weird']);
  });

  it('並びは property_order（無い名前は飛ばし、漏れた名前は後ろに足す）。項目の無い形は、確かめるだけの質問', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } } };
    expect(elicitationFieldsOf(schema, ['c', 'x', 'a']).fields.map((f) => f.key)).toEqual(['c', 'a', 'b']);
    expect(elicitationFieldsOf(undefined)).toEqual({ fields: [], unsupported: [] });
    expect(elicitationFieldsOf({ type: 'object' })).toEqual({ fields: [], unsupported: [] });
    expect(elicitationFieldsOf({ type: 'object', properties: [] }).unsupported).toEqual(['(properties)']);
    expect(elicitationFieldsOf('x').unsupported).toEqual(['(schema)']);
  });
});

describe('入力の確かめ', () => {
  it('文字: 必須・長さ（文字の数で数える）・メール・URI・日付・日時', () => {
    const text = (schema: Record<string, unknown>, required = false) => one({ type: 'string', ...schema }, required);
    expect(fieldProblem(text({}, true), undefined)).toEqual({ kind: 'required' });
    expect(fieldProblem(text({}), undefined)).toBeNull();
    expect(fieldProblem(text({ minLength: 3 }), '🍣🍣')).toEqual({ kind: 'tooShort', min: 3 });
    expect(fieldProblem(text({ maxLength: 2 }), '🍣🍣')).toBeNull();
    expect(fieldProblem(text({ maxLength: 2 }), 'abc')).toEqual({ kind: 'tooLong', max: 2 });
    expect(fieldProblem(text({ format: 'email' }), 'a@b.jp')).toBeNull();
    expect(fieldProblem(text({ format: 'email' }), 'a b@c')).toEqual({ kind: 'format', format: 'email' });
    expect(fieldProblem(text({ format: 'uri' }), 'https://example.com/x')).toBeNull();
    expect(fieldProblem(text({ format: 'uri' }), 'mailto:a@b.jp')).toBeNull();
    expect(fieldProblem(text({ format: 'uri' }), 'example.com')).toEqual({ kind: 'format', format: 'uri' });
    expect(fieldProblem(text({ format: 'date' }), '2026-02-28')).toBeNull();
    expect(fieldProblem(text({ format: 'date' }), '2026-02-30')).toEqual({ kind: 'format', format: 'date' });
    expect(fieldProblem(text({ format: 'date-time' }), '2026-10-19T10:00:00+09:00')).toBeNull();
    expect(fieldProblem(text({ format: 'date-time' }), '2026-10-19T10:00:00Z')).toBeNull();
    expect(fieldProblem(text({ format: 'date-time' }), '2026-10-19T10:00')).toEqual({ kind: 'format', format: 'date-time' });
  });

  it('数: 数でない・整数でない・上限下限', () => {
    const integer = one({ type: 'integer', minimum: 1, maximum: 3 });
    expect(fieldProblem(integer, 2)).toBeNull();
    expect(fieldProblem(integer, 2.5)).toEqual({ kind: 'integer' });
    expect(fieldProblem(integer, 0)).toEqual({ kind: 'tooSmall', min: 1 });
    expect(fieldProblem(integer, 4)).toEqual({ kind: 'tooLarge', max: 3 });
    expect(fieldProblem(integer, '2')).toEqual({ kind: 'number' });
    expect(fieldProblem(one({ type: 'number' }), Number.NaN)).toEqual({ kind: 'number' });
  });

  it('選択肢: 選択肢に無い値・重ね・個数。必須の複数選択は、minItems で 0 を許していなければ 1 つ以上', () => {
    const select = one({ type: 'string', enum: ['a', 'b'] });
    expect(fieldProblem(select, 'a')).toBeNull();
    expect(fieldProblem(select, 'z')).toEqual({ kind: 'option' });
    const multi = one({ type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, maxItems: 2 }, true);
    expect(fieldProblem(multi, ['a'])).toBeNull();
    expect(fieldProblem(multi, [])).toEqual({ kind: 'required' });
    expect(fieldProblem(multi, ['a', 'a'])).toEqual({ kind: 'option' });
    expect(fieldProblem(multi, ['a', 'z'])).toEqual({ kind: 'option' });
    expect(fieldProblem(multi, ['a', 'b', 'c'])).toEqual({ kind: 'tooMany', max: 2 });
    expect(fieldProblem(one({ type: 'array', items: { enum: ['a', 'b'] }, minItems: 2 }), ['a'])).toEqual({ kind: 'tooFew', min: 2 });
    expect(fieldProblem(one({ type: 'array', items: { enum: ['a'] }, minItems: 0 }, true), [])).toBeNull();
  });

  it('入力欄の中身（initialDraft・readDraft）: 既定値を入れ、空の欄は返さず、数と日時を読む。読めなければ誤り', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    const { fields } = fieldsOf(
      {
        name: { type: 'string' },
        size: { type: 'integer', default: 3 },
        when: { type: 'string', format: 'date-time', default: '2026-10-19T01:30:00Z' },
        ok: { type: 'boolean' },
        pick: { type: 'string', enum: ['a', 'b'] },
        many: { type: 'array', items: { enum: ['x', 'y'] } },
      },
      ['name'],
    );
    const draft = initialDraft(fields);
    // 日時の既定値は、この Mac の時間帯の datetime-local の形にする
    expect(draft).toEqual({ name: '', size: '3', when: '2026-10-19T10:30', ok: false, pick: '', many: [] });
    expect(readDraft(fields, draft)).toEqual({ content: { size: 3, when: '2026-10-19T10:30:00+09:00', ok: false }, problems: { name: { kind: 'required' } } });
    expect(readDraft(fields, { ...draft, name: 'tana', size: '3.5', when: '2026-13-01T00:00', pick: 'b', many: ['y', 'x'] })).toEqual({
      content: { name: 'tana', ok: false, pick: 'b', many: ['x', 'y'] },
      problems: { size: { kind: 'integer' }, when: { kind: 'format', format: 'date-time' } },
    });
    expect(readDraft(fields, { ...draft, name: 'tana', size: 'x' }).problems).toEqual({ size: { kind: 'number' } });
  });

  it('dateTimeOf: datetime-local の入力を、時差つきの日時にする', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(dateTimeOf('2026-10-19T10:30')).toBe('2026-10-19T10:30:00+09:00');
    expect(dateTimeOf('2026-10-19T10:30:15')).toBe('2026-10-19T10:30:15+09:00');
    expect(dateTimeOf('2026-02-30T10:30')).toBeNull();
    expect(dateTimeOf('10:30')).toBeNull();
    vi.stubEnv('TZ', 'UTC');
    expect(dateTimeOf('2026-10-19T10:30')).toBe('2026-10-19T10:30:00Z');
  });

  it('checkedContent: 画面から受け取った中身を項目で確かめる。知らない項目・合わない値・足りない必須があれば null', () => {
    const { fields } = fieldsOf({ name: { type: 'string', maxLength: 3 }, size: { type: 'integer' } }, ['name']);
    expect(checkedContent(fields, { name: 'abc', size: 2 })).toEqual({ name: 'abc', size: 2 });
    expect(checkedContent(fields, { name: 'abc' })).toEqual({ name: 'abc' });
    expect(checkedContent(fields, { name: 'abcd' })).toBeNull();
    expect(checkedContent(fields, { size: 2 })).toBeNull();
    expect(checkedContent(fields, { name: 'a', size: 2.5 })).toBeNull();
    expect(checkedContent(fields, { name: 'a', other: 1 })).toBeNull();
  });
});

describe('答えの形と開けるページ', () => {
  it('elicitationReplyOf: 形の合う答えだけを受け取る', () => {
    expect(elicitationReplyOf({ kind: 'accept', content: { a: 'x', b: 1, c: true, d: ['y'] } })).toEqual({ kind: 'accept', content: { a: 'x', b: 1, c: true, d: ['y'] } });
    for (const kind of ['open', 'decline', 'cancel', 'reopen', 'dismiss']) expect(elicitationReplyOf({ kind, extra: 1 })).toEqual({ kind });
    expect(elicitationReplyOf({ kind: 'accept' })).toBeNull();
    expect(elicitationReplyOf({ kind: 'accept', content: { a: { b: 1 } } })).toBeNull();
    expect(elicitationReplyOf({ kind: 'accept', content: { a: [1] } })).toBeNull();
    expect(elicitationReplyOf({ kind: 'accept', content: { a: Number.POSITIVE_INFINITY } })).toBeNull();
    expect(elicitationReplyOf({ kind: 'allow' })).toBeNull();
    expect(elicitationReplyOf(null)).toBeNull();
  });

  it('openableUrl: http・https のページだけ', () => {
    expect(openableUrl('https://example.com/a')).toBe(true);
    expect(openableUrl('http://localhost:3000')).toBe(true);
    expect(openableUrl('javascript:alert(1)')).toBe(false);
    expect(openableUrl('file:///etc/passwd')).toBe(false);
    expect(openableUrl('example.com')).toBe(false);
  });
});
