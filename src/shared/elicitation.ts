// MCP サーバーから人への質問（MCP の elicitation。Claude Code は stream-json の control_request の elicitation で渡す）。
// 形は MCP の仕様（elicitation/create。@modelcontextprotocol/sdk 1.32 の types.js）に合わせる。
// - フォームの形（form）: 入れ子の無い項目（文字・数・はい／いいえ・選択肢）を埋めて送るか、断る
// - URL の形（url）: 人がページを開いて、そこで続ける（ログインなど）。終わると MCP サーバーが知らせる（system/elicitation_complete）
// 項目の読み取り・入力の確かめは、画面（カード）と main（返事を Claude Code に送る前の確かめ）の両方で使う

// 文字の項目の入力の形（format）のうち、確かめるもの。ほかの format は、ふつうの文字として受ける（決めたこと。format は入力の手がかりで、
// MCP サーバーも確かめる）
export const TEXT_FORMATS = ['email', 'uri', 'date', 'date-time'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

// 選択肢。value: 返す値 / label: 画面に出す名前（MCP サーバーが付けていなければ値のまま）
export type ElicitationOption = { value: string; label: string };

// フォームの 1 項目。key: 返す値の名前 / title: 画面に出す名前（無ければ key）/ description: 説明 / required: 必須
type FieldBase = { key: string; title: string; description: string | null; required: boolean };
export type ElicitationField = FieldBase &
  (
    | { type: 'text'; format: TextFormat | null; minLength: number | null; maxLength: number | null; default: string | null }
    | { type: 'number'; integer: boolean; minimum: number | null; maximum: number | null; default: number | null }
    | { type: 'boolean'; default: boolean | null }
    | { type: 'select'; options: ElicitationOption[]; default: string | null }
    | { type: 'multi'; options: ElicitationOption[]; minItems: number | null; maxItems: number | null; default: string[] | null }
  );

// Claude Code が答えを待っている MCP サーバーの質問（main の session-manager が持ち、カードに出す）。
// id: 要求の ID（request_id。開いたあとの完了待ちは opened: + 要求の ID）/ server: 質問した MCP サーバーの名前（人の設定の名前）/
// message: 質問の文 / title・description: MCP サーバーが付けた見出しと説明（_meta の anthropic/permissionDisplay）/
// url: URL の形の、開くページ（form では null）/ openable: http・https のページで、開ける /
// fields: フォームの項目（MCP サーバーが書いた順）/ unsupported: tanacode が出せない形の項目の名前（あれば、断ることしかできない）/
// opened: URL の形で、ページを開いて、MCP サーバーが完了を知らせるのを待っている（Claude Code にはもう答えた）
export type PendingElicitation = {
  id: string;
  server: string;
  message: string;
  title: string | null;
  description: string | null;
  mode: 'form' | 'url';
  url: string | null;
  openable: boolean;
  fields: ElicitationField[];
  unsupported: string[];
  opened: boolean;
};

// 返す値（MCP の ElicitResult の content の値）
export type ElicitationValue = string | number | boolean | string[];
export type ElicitationContent = Record<string, ElicitationValue>;

// カードの答え。accept: フォームを送る / open: URL の形で、ページを開く（同意として accept を返す）/ decline: 断る /
// cancel: 答えずに閉じる / reopen・dismiss: 完了待ちのカードで、もう一度開く・閉じる（Claude Code には何も送らない）
export type ElicitationReply =
  | { kind: 'accept'; content: ElicitationContent }
  | { kind: 'open' }
  | { kind: 'decline' }
  | { kind: 'cancel' }
  | { kind: 'reopen' }
  | { kind: 'dismiss' };

// 入力の誤り。画面の文言は、カードが種類から決める
export type ElicitationProblem =
  | { kind: 'required' }
  | { kind: 'tooShort'; min: number }
  | { kind: 'tooLong'; max: number }
  | { kind: 'format'; format: TextFormat }
  | { kind: 'number' }
  | { kind: 'integer' }
  | { kind: 'tooSmall'; min: number }
  | { kind: 'tooLarge'; max: number }
  | { kind: 'tooFew'; min: number }
  | { kind: 'tooMany'; max: number }
  | { kind: 'option' };

// カードの入力欄の中身（項目の名前 → 中身）。文字・数・日付は打った文字（日時は datetime-local の形）、はい／いいえは真偽、
// 選択肢は選んだ値（1 つは選ばなければ空の文字）
export type ElicitationDraft = Record<string, string | boolean | string[]>;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string';
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// 選択肢の { const, title } の並び（oneOf・anyOf）。形が違えば null
function titledOptions(value: unknown): ElicitationOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options = value.map((o) => (isRecord(o) && str(o.const) ? { value: o.const, label: str(o.title) ? o.title : o.const } : null));
  return options.every((o) => o !== null) ? options : null;
}

// 選択肢の値の並び（enum）。labels: 前の書き方の表示名（enumNames）。形が違えば null
function plainOptions(value: unknown, labels?: unknown): ElicitationOption[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(str)) return null;
  const names = Array.isArray(labels) && labels.length === value.length && labels.every(str) ? labels : null;
  return value.map((v, i) => ({ value: v, label: names ? names[i] : v }));
}

// 1 項目を読む。tanacode が出せない形なら null
function fieldOf(key: string, raw: unknown, required: boolean): ElicitationField | null {
  if (!isRecord(raw)) return null;
  const base: FieldBase = { key, title: str(raw.title) && raw.title.trim() ? raw.title : key, description: str(raw.description) && raw.description.trim() ? raw.description : null, required };
  switch (raw.type) {
    case 'string': {
      const options = plainOptions(raw.enum, raw.enumNames) ?? titledOptions(raw.oneOf);
      if (options) return { ...base, type: 'select', options, default: str(raw.default) && options.some((o) => o.value === raw.default) ? raw.default : null };
      // 選択肢の形に見えるのに読めないもの（値が文字でない enum など）は、ふつうの文字にしない
      if (raw.enum !== undefined || raw.oneOf !== undefined) return null;
      const format = TEXT_FORMATS.find((f) => f === raw.format) ?? null;
      return { ...base, type: 'text', format, minLength: num(raw.minLength), maxLength: num(raw.maxLength), default: str(raw.default) ? raw.default : null };
    }
    case 'number':
    case 'integer':
      return { ...base, type: 'number', integer: raw.type === 'integer', minimum: num(raw.minimum), maximum: num(raw.maximum), default: num(raw.default) };
    case 'boolean':
      return { ...base, type: 'boolean', default: typeof raw.default === 'boolean' ? raw.default : null };
    case 'array': {
      const items = raw.items;
      if (!isRecord(items)) return null;
      const options = plainOptions(items.enum) ?? titledOptions(items.anyOf) ?? titledOptions(items.oneOf);
      if (!options) return null;
      const defaults = Array.isArray(raw.default) ? raw.default.filter((v): v is string => str(v) && options.some((o) => o.value === v)) : null;
      return { ...base, type: 'multi', options, minItems: num(raw.minItems), maxItems: num(raw.maxItems), default: defaults };
    }
    default:
      return null;
  }
}

// 要求の項目の形（requested_schema）を、カードの項目にする。order: 項目の並び（Claude Code が付ける property_order。無ければ書いた順）。
// 項目の無い形（properties が無い）は、確かめるだけの質問（送ると、空の中身で accept）
export function elicitationFieldsOf(schema: unknown, order?: unknown): { fields: ElicitationField[]; unsupported: string[] } {
  if (schema === undefined || schema === null) return { fields: [], unsupported: [] };
  if (!isRecord(schema)) return { fields: [], unsupported: ['(schema)'] };
  const properties = schema.properties;
  if (properties === undefined) return { fields: [], unsupported: [] };
  if (!isRecord(properties)) return { fields: [], unsupported: ['(properties)'] };
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(str) : []);
  const listed = Array.isArray(order) ? order.filter((k): k is string => str(k) && Object.hasOwn(properties, k)) : [];
  const keys = [...new Set([...listed, ...Object.keys(properties)])];
  const fields: ElicitationField[] = [];
  const unsupported: string[] = [];
  for (const key of keys) {
    const field = fieldOf(key, properties[key], required.has(key));
    if (field) fields.push(field);
    else unsupported.push(key);
  }
  return { fields, unsupported };
}

// http・https のページか（開けるのはこれだけ）
export function openableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

// 時刻を、この Mac の時間帯の datetime-local の入力の形（YYYY-MM-DDTHH:mm）にする
function localInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// datetime-local の入力（この Mac の時間帯の時刻）を、時差つきの RFC 3339 の日時（JSON Schema の date-time）にする。読めなければ null
export function dateTimeOf(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((v) => Number(v ?? 0));
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour) return null;
  const offset = -date.getTimezoneOffset();
  const zone = offset === 0 ? 'Z' : `${offset > 0 ? '+' : '-'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${localInput(date)}:${pad(date.getSeconds())}${zone}`;
}

// 日付（YYYY-MM-DD）として正しいか
function isDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
}

// RFC 3339 の日時（時差つき）として正しいか
function isDateTime(value: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  return !!m && isDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 61 && !Number.isNaN(Date.parse(value));
}

function formatOk(format: TextFormat, value: string): boolean {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+$/.test(value);
    case 'uri':
      // スキームの付いた URI（https://… や mailto:… など）
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(value)) return false;
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case 'date':
      return isDate(value);
    case 'date-time':
      return isDateTime(value);
  }
}

// 値が項目に合っているか（合っていなければ誤り）。value: 返す値（無ければ undefined）
export function fieldProblem(field: ElicitationField, value: unknown): ElicitationProblem | null {
  if (value === undefined) return field.required ? { kind: 'required' } : null;
  switch (field.type) {
    case 'text': {
      if (!str(value)) return { kind: 'required' };
      // 長さは文字（コードポイント）で数える（JSON Schema と同じ）
      const length = [...value].length;
      if (field.minLength !== null && length < field.minLength) return { kind: 'tooShort', min: field.minLength };
      if (field.maxLength !== null && length > field.maxLength) return { kind: 'tooLong', max: field.maxLength };
      if (field.format && !formatOk(field.format, value)) return { kind: 'format', format: field.format };
      return null;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { kind: 'number' };
      if (field.integer && !Number.isInteger(value)) return { kind: 'integer' };
      if (field.minimum !== null && value < field.minimum) return { kind: 'tooSmall', min: field.minimum };
      if (field.maximum !== null && value > field.maximum) return { kind: 'tooLarge', max: field.maximum };
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : { kind: 'required' };
    case 'select':
      return str(value) && field.options.some((o) => o.value === value) ? null : { kind: 'option' };
    case 'multi': {
      if (!Array.isArray(value) || !value.every((v) => str(v) && field.options.some((o) => o.value === v)) || new Set(value).size !== value.length) return { kind: 'option' };
      // 必須の複数選択は、少なくとも 1 つ（minItems で 0 を許していれば、選ばなくてよい）
      const min = field.minItems ?? (field.required ? 1 : 0);
      if (value.length < min) return value.length === 0 ? { kind: 'required' } : { kind: 'tooFew', min };
      if (field.maxItems !== null && value.length > field.maxItems) return { kind: 'tooMany', max: field.maxItems };
      return null;
    }
  }
}

// カードの入力欄のはじめの中身（既定値を入れる。はい／いいえは、既定値が無ければ「いいえ」）
export function initialDraft(fields: ElicitationField[]): ElicitationDraft {
  const draft: ElicitationDraft = {};
  for (const field of fields) {
    switch (field.type) {
      case 'text': {
        const value = field.default ?? '';
        // 日時の既定値は、datetime-local の入力の形にする（読めなければ空）
        draft[field.key] = field.format === 'date-time' && value ? (isDateTime(value) ? localInput(new Date(value)) : '') : value;
        break;
      }
      case 'number':
        draft[field.key] = field.default === null ? '' : String(field.default);
        break;
      case 'boolean':
        draft[field.key] = field.default ?? false;
        break;
      case 'select':
        draft[field.key] = field.default ?? '';
        break;
      case 'multi':
        draft[field.key] = field.default ?? [];
        break;
    }
  }
  return draft;
}

// 入力欄の中身を、返す値にする（空の欄は値にしない）。読めない数・日時は、誤りにする
function valueOf(field: ElicitationField, raw: string | boolean | string[] | undefined): { value?: ElicitationValue; problem?: ElicitationProblem } {
  switch (field.type) {
    case 'text': {
      if (!str(raw) || raw === '') return {};
      if (field.format !== 'date-time') return { value: raw };
      const value = dateTimeOf(raw);
      return value ? { value } : { problem: { kind: 'format', format: 'date-time' } };
    }
    case 'number': {
      const text = str(raw) ? raw.trim() : '';
      if (!text) return {};
      const value = Number(text);
      return Number.isFinite(value) ? { value } : { problem: { kind: 'number' } };
    }
    case 'boolean':
      return { value: raw === true };
    case 'select':
      return str(raw) && raw !== '' ? { value: raw } : {};
    case 'multi': {
      const picked = Array.isArray(raw) ? field.options.map((o) => o.value).filter((v) => raw.includes(v)) : [];
      // 選ばなかった任意の項目は返さない（必須なら、空のまま確かめて誤りにする）
      return picked.length > 0 || field.required ? { value: picked } : {};
    }
  }
}

// 入力欄の中身を、返す中身にして確かめる。problems: 項目の名前 → 誤り（無ければ送れる）
export function readDraft(fields: ElicitationField[], draft: ElicitationDraft): { content: ElicitationContent; problems: Record<string, ElicitationProblem> } {
  const content: ElicitationContent = {};
  const problems: Record<string, ElicitationProblem> = {};
  for (const field of fields) {
    const { value, problem } = valueOf(field, draft[field.key]);
    const found = problem ?? fieldProblem(field, value);
    if (found) problems[field.key] = found;
    else if (value !== undefined) content[field.key] = value;
  }
  return { content, problems };
}

// 画面から受け取った中身を、項目で確かめる（main が Claude Code に返す前に）。知らない項目・合わない値があれば null
export function checkedContent(fields: ElicitationField[], content: ElicitationContent): ElicitationContent | null {
  if (!Object.keys(content).every((key) => fields.some((f) => f.key === key))) return null;
  return fields.every((field) => fieldProblem(field, Object.hasOwn(content, field.key) ? content[field.key] : undefined) === null) ? content : null;
}

// 形を確かめた答え（画面から受け取ったもの）。形が違えば null
export function elicitationReplyOf(value: unknown): ElicitationReply | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'open':
    case 'decline':
    case 'cancel':
    case 'reopen':
    case 'dismiss':
      return { kind: value.kind };
    case 'accept': {
      if (!isRecord(value.content)) return null;
      const entries = Object.entries(value.content);
      const ok = entries.every(([, v]) => str(v) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every(str)));
      return ok ? { kind: 'accept', content: Object.fromEntries(entries) as ElicitationContent } : null;
    }
    default:
      return null;
  }
}
