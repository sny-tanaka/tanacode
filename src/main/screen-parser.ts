import type { AskQuestion, Menu, MenuOption, PermissionMode, ScreenLine } from '@shared/screen';

const RULE = /^\s*─{20,}\s*$/;
// 許可の確認で、実行するコマンドを上下から囲む点線（例: 「╌╌╌…」）。飾りなので補足に入れない
const DASHED_RULE = /^[╌┄┈]{20,}$/;
// 下の段に重ねて出るメニュー（/rewind の「何を戻すか」など）の上端の線。右に「◐ medium · /effort」などが重なることがある
const TOP_EDGE = /^\s*▔{20,}/;
// 入力欄の枠の横線。名前を付けたセッション（claude -n・/rename）では、上の線の右端に名前が入る（例: 「────── 名前 ─」）
const PROMPT_RULE = /^\s*─{20,}(?: .+ ─+)?\s*$/;
// 画面が低いと、選択肢は一部だけが出て、外にまだあることを ↑ / ↓ で示す（例: 「↓ 2. …」）
const OPTION = /^\s*([❯↑↓]\s+)?(\d+)\.\s+(.*)$/;
// 複数選択の確定の行。途中の質問では Next、最後の質問では Submit
const SUBMIT = /^\s*(❯\s+)?(Submit|Next)\s*$/;
const CHECKBOX = /^\[([ ✔xX])\]\s*(.*)$/;
const FOOTER = /Esc to cancel|Enter to (select|confirm)/;
const TABS = /[☐☒]/;
const BOXED = /^│\s?/;
const CHAT_ABOUT_THIS = 'Chat about this';
// 番号の無い選択肢のメニューで、カーソルのある行（例: 「 ❯ No, exit」）
const PLAIN_POINTER = /^(\s*❯\s+)\S/;
// 起動時のバナーの、ロゴの右の 1 行目
const BANNER_TITLE = /Claude Code v\d+\.\d+\.\d+/;
// AskUserQuestion の回答の確認画面の見出し
const REVIEW_TITLE = 'Review your answers';
// メニューとみなす範囲（フッターから上に何行まで見るか）
const MAX_MENU_LINES = 40;

// 番号付きの選択肢に ❯ が付いていれば選択メニュー。通常は下に操作説明（Esc to cancel など）があるが、
// AskUserQuestion の回答確認画面のように無いこともある。入力欄が出ているときは呼ばない（過去の発言と区別できない）
export function parseMenu(lines: ScreenLine[]): Menu | null {
  const footer = findLastIndex(lines, (l) => FOOTER.test(l.text));
  const pointer = findLastIndex(lines, (l) => /❯\s+(\d+\.|Submit\s*$|Next\s*$)/.test(l.text));
  // AskUserQuestion のメニューが画面より高いと、上（タブ・質問文・はじめの選択肢）が切れる。
  // カーソルが切れた選択肢にあると ❯ が見えないが、操作説明の上に番号付きの「Chat about this」があれば質問として読む
  const clipped =
    pointer === -1 && footer !== -1 && lines.slice(0, footer).some((l) => l.text.match(OPTION)?.[3].trim() === CHAT_ABOUT_THIS);
  if (pointer === -1 && !clipped) return parsePlainMenu(lines, footer);
  const end = footer > pointer ? footer : lines.length;
  const top = menuTop(lines, end === footer ? footer : pointer + 1);

  const first = optionsStart(lines, top, clipped ? end - 1 : pointer, end);
  if (first === -1) return null;
  // 「1.」が見えているのにカーソルが無いのは、上が切れたメニューではない
  if (clipped && lines[first].text.match(OPTION)?.[2] === '1') return null;

  // 選択肢のどれかにプレビューがあると、選択肢の右にプレビューの枠（┌─┐）と「Notes: press n to add notes」が並ぶ。
  // 枠が始まる位置（文字の位置）より右は読み飛ばし、左の列だけを選択肢として読む
  const previewAt = previewColumn(lines, first, end);
  const options: MenuOption[] = [];
  let prevFull = false;
  for (let i = first; i < end; i++) {
    const { full } = lines[i];
    const text = previewAt === null ? lines[i].text : leftColumn(lines[i].text, previewAt);
    if (previewAt !== null) {
      // 右の列だけの行・番号の無い「Chat about this」（この形では選択肢にならない）は飛ばす
      if (!text.trim() || text.trim() === CHAT_ABOUT_THIS || RULE.test(text)) {
        prevFull = false;
        continue;
      }
      // 左の列の幅で折り返された選択肢の名前の続き（説明はこの形では出ない）
      if (!OPTION.test(text) && options.length > 0) {
        const last = options[options.length - 1];
        last.label = joinWrapped(last.label, text.trim());
        continue;
      }
    }
    const option = text.match(OPTION);
    if (option) {
      const checkbox = option[3].match(CHECKBOX);
      options.push({
        id: option[2],
        label: (checkbox ? checkbox[2] : option[3]).trim(),
        description: '',
        pointed: option[1]?.startsWith('❯') ?? false,
        checked: checkbox ? checkbox[1] !== ' ' : null,
        textInput: false,
      });
    } else if (SUBMIT.test(text) && options.some((o) => o.checked !== null)) {
      const label = text.match(SUBMIT)![2];
      options.push({ id: 'submit', label, description: '', pointed: /❯/.test(text), checked: null, textInput: false });
    } else if (text.trim() && !RULE.test(text) && options.length > 0) {
      const last = options[options.length - 1];
      // 端末の幅で折り返された選択肢の続き
      if (prevFull && !last.description) last.label += text.trim();
      else last.description = last.description ? `${last.description} ${text.trim()}` : text.trim();
    }
    prevFull = full;
  }
  if (!clipped && !options.some((o) => o.pointed)) return null;

  // 「Chat about this」の直前の選択肢が自由記述（「Type something.」、入力後は入力した文字列になる）
  const chat = options.findIndex((o) => o.label === CHAT_ABOUT_THIS);
  const textOption = options.slice(0, Math.max(chat, 0)).filter((o) => o.id !== 'submit').pop();
  if (chat !== -1 && textOption) textOption.textInput = true;

  const raw = lines
    .slice(top, first)
    .map((l) => l.text.trim())
    .filter((t) => !DASHED_RULE.test(t));
  // AskUserQuestion の質問文は、行頭に縦線（│）の付いた枠で、端末の幅で折り返して出る。
  // 縦線を外し、行をつなぎ直して 1 つの文にする
  const boxed = raw.filter((t) => BOXED.test(t)).map((t) => t.replace(BOXED, ''));
  const header = raw.filter((t) => t && !BOXED.test(t));
  const tabLine = header.find((t) => TABS.test(t));
  const tabs = tabLine ? parseTabs(tabLine) : [];
  // 回答の確認画面では、長い質問だけが縦線付きで出る。縦線の行を質問文として取り出すと、質問と回答の並びが崩れるので、
  // その場でつなぎ直して上から順に並べる（最後の「Ready to submit your answers?」が問い）
  const review = header.includes(REVIEW_TITLE);
  const question = tabs.length > 0 || chat !== -1 || previewAt !== null;
  // 縦線の枠は、質問では質問文。そのほかのメニューでは引用（/rewind の「何を戻すか」の、戻す先の発言）なので、その場でつなぎ直す
  const inPlace = review || (boxed.length > 0 && !question);
  const texts = inPlace ? unwrapInPlace(raw.filter((t) => t !== tabLine)) : header.filter((t) => t !== tabLine);
  let title = boxed.length > 0 && !inPlace ? unwrap(boxed) : (texts.pop() ?? '');
  const kind = question ? 'question' : /Do you want to/.test(title) ? 'permission' : 'other';
  // そのほかの確認（ワークフローを始める前の確認・/rewind の「何を戻すか」など）は、問いかけが説明の上にあることがある
  // （「Run a dynamic workflow?」「Confirm you want to restore …:」）。最後の行が問いかけでなければ、
  // ? で終わる行（無ければ : で終わる行）を見出しにして、最後の行は補足に回す
  const asks = (mark: string) => findLastIndex(texts, (t) => t.endsWith(mark));
  const asking = kind === 'other' && !review && !title.endsWith('?') ? (asks('?') !== -1 ? asks('?') : asks(':')) : -1;
  if (asking !== -1) {
    const asked = texts.splice(asking, 1)[0];
    texts.push(title);
    title = asked;
  }

  return {
    kind,
    tabs,
    title,
    context: review ? texts : texts.slice(-8),
    options,
    multiSelect: options.some((o) => o.checked !== null),
    hint: end === footer ? lines[footer].text.trim() : '',
    previewLayout: previewAt !== null,
  };
}

// 選択肢の最初の行。カーソル（❯）の行から上へたどって、最初に見つかる「1.」の行。
// 説明の中にも番号付きの一覧があることがある（ワークフローを始める前の確認のフェーズの一覧）ので、範囲の先頭からは探さない。
// 画面が低くて「1.」が見えていないときは、範囲の中で最初の選択肢の行
function optionsStart(lines: ScreenLine[], top: number, pointer: number, end: number): number {
  for (let i = Math.min(pointer, end - 1); i >= top; i--) {
    if (lines[i].text.match(OPTION)?.[2] === '1') return i;
  }
  return lines.findIndex((l, i) => i >= top && i < end && OPTION.test(l.text));
}

// 番号の無い選択肢のメニュー（フォルダの信頼の確認など）。例:
//   Quick safety check: Is this a project you created or one you trust? …
//   ❯ No, exit
//     Yes, I trust this folder
//   Enter to confirm · Esc to cancel
// ほかの画面と取り違えないよう、下に操作説明があり、❯ の行と同じ字下げの行が続く（2 つ以上の選択肢）ものだけを読む。
// 選択肢の番号は上から 1, 2, …（選ぶときは ↑/↓ で動かすので、画面の番号は要らない）
function parsePlainMenu(lines: ScreenLine[], footer: number): Menu | null {
  if (footer === -1) return null;
  const pointer = findLastIndex(lines.slice(0, footer), (l) => PLAIN_POINTER.test(l.text));
  if (pointer === -1 || footer - pointer > MAX_MENU_LINES) return null;
  // 選択肢の名前が始まる文字の位置。ほかの選択肢の行は、この位置まで空白で、そこから文字が始まる
  const column = lines[pointer].text.match(PLAIN_POINTER)![1].length;
  const isOption = (i: number) => {
    const text = lines[i].text;
    return i === pointer || (text.slice(0, column).trim() === '' && /\S/.test(text.charAt(column)));
  };
  let first = pointer;
  while (first > 0 && isOption(first - 1)) first--;
  let last = pointer;
  while (last + 1 < footer && isOption(last + 1)) last++;
  if (last === first) return null;
  // 選択肢と操作説明の間には、空行しか無い
  if (lines.slice(last + 1, footer).some((l) => l.text.trim())) return null;

  const options: MenuOption[] = lines.slice(first, last + 1).map((l, i) => ({
    id: String(i + 1),
    label: l.text.trim().replace(/^❯\s+/, ''),
    description: '',
    pointed: first + i === pointer,
    checked: null,
    textInput: false,
  }));
  // 上の文章は段落ごとにつなぎ直し、問いかけ（? を含む最後の段落）を見出しに、ほかを補足にする
  const paragraphs = unwrap(lines.slice(menuTop(lines, first), first).map((l) => l.text)).split('\n').filter(Boolean);
  const asking = findLastIndex(paragraphs, (p) => p.includes('?'));
  const at = asking === -1 ? paragraphs.length - 1 : asking;
  return {
    kind: 'other',
    tabs: [],
    title: paragraphs[at] ?? '',
    context: paragraphs.filter((_, i) => i !== at),
    options,
    multiSelect: false,
    hint: lines[footer].text.trim(),
  };
}

// プレビューの枠（┌）が始まる文字の位置。枠が無ければ null
function previewColumn(lines: ScreenLine[], from: number, to: number): number | null {
  for (let i = from; i < to; i++) {
    const at = lines[i].text.search(/\s{2,}┌─/);
    if (at >= 0) return lines[i].text.indexOf('┌', at);
  }
  return null;
}

// プレビューの枠より左だけを返す。枠の左端より右から始まる行（枠の中身・Notes の行）は空にする。
// 左の列に全角の文字があると、文字の位置は画面の列より小さくなるので、位置ではなく枠の線で切る
function leftColumn(text: string, previewAt: number): string {
  const indent = text.length - text.trimStart().length;
  if (indent >= previewAt) return '';
  // 右の列は枠の線か、枠の下の「Notes: press n to add notes」（選択肢と同じ行に並ぶこともある）で始まる
  return text.replace(/\s{2,}(?:[┌│└]|Notes: ).*$/, '');
}

// 左の列の幅で折り返された名前をつなぐ。英数字どうしの間（英語の単語の区切り）だけ空白を入れる
function joinWrapped(head: string, tail: string): string {
  return /[\x21-\x7e]$/.test(head) && /^[\x21-\x7e]/.test(tail) ? `${head} ${tail}` : head + tail;
}

// 折り返された行をつなぎ直す。Claude Code は空白の位置で折り返すので、同じ段落の行は空白でつなぐ。空行は段落の区切り
function unwrap(lines: string[]): string {
  const paragraphs: string[][] = [[]];
  for (const line of lines.map((l) => l.trim())) {
    if (line) paragraphs[paragraphs.length - 1].push(line);
    else if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
  }
  return paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join(' '))
    .join('\n');
}

// 縦線付きの行が続くところだけをつなぎ直して 1 行にし、ほかの行と並びを保ったまま返す（空行は捨てる）
function unwrapInPlace(lines: string[]): string[] {
  const result: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) result.push(unwrap(run));
    run = [];
  };
  for (const line of lines) {
    if (BOXED.test(line)) {
      run.push(line.replace(BOXED, ''));
      continue;
    }
    flush();
    if (line) result.push(line);
  }
  flush();
  return result;
}

// 通常の入力欄: 横線の直後に「❯」で始まる行があり、その下にも横線がある
export function hasPrompt(lines: ScreenLine[]): boolean {
  return promptRange(lines) !== null;
}

// 入力欄の行の範囲 [start, end)
// 作業中のタイマーの行（「✳ Shimmying… (5s · ↓ 225 tokens · thought for 2s)」「✶ Churning…」）。
// 入力欄の上（ToDo の一覧が間に入ることがある）にあるので、入力欄の枠から上へ探す
const SPINNER = /^[·✢✳✶✻✽*]\s+\S.*?…\s*(?:\((.*)\))?\s*$/;
const SPINNER_SEARCH_LINES = 20;

export type SpinnerLine = { elapsed: string | null; thinking: boolean; tokens: string | null };

export function parseSpinner(lines: ScreenLine[], promptStart: number): SpinnerLine | null {
  for (let i = promptStart - 2; i >= Math.max(0, promptStart - 2 - SPINNER_SEARCH_LINES); i--) {
    const m = lines[i].text.match(SPINNER);
    if (!m) continue;
    const parts = (m[1] ?? '').split('·').map((p) => p.trim());
    return {
      elapsed: parts.find((p) => /^(\d+[hms]\s*)+$/.test(p)) ?? null,
      thinking: parts.includes('thinking'),
      tokens: parts.map((p) => p.match(/^↓\s*([\d.,]+k?)\s*tokens?$/)?.[1]).find(Boolean) ?? null,
    };
  }
  return null;
}

// 応答の文章が画面に流れている途中か。Claude Code は文章を書き始めるとタイマーの行を消すので、
// 入力欄の枠から上へ見て、発言（❯）やタイマー・完了の行（✻ Churned for 12s など）より先に応答（⏺）が見つかるかで判断する。
// 作業中に送った発言が順番待ちのときも、タイマーの行は消えて発言（❯）が出る
export function isStreaming(lines: ScreenLine[], promptStart: number): boolean {
  for (let i = promptStart - 2; i >= 0; i--) {
    const text = lines[i].text;
    if (text.startsWith('⏺')) return true;
    if (text.startsWith('❯') || /^[·✢✳✶✻✽*]\s/.test(text)) return false;
  }
  return false;
}

export function promptRange(lines: ScreenLine[]): [number, number] | null {
  for (let i = lines.length - 1; i >= 1; i--) {
    const text = lines[i].text;
    if (!/^❯(\s|$)/.test(text) || OPTION.test(text) || !PROMPT_RULE.test(lines[i - 1].text)) continue;
    const end = lines.findIndex((l, j) => j > i && j < i + 30 && PROMPT_RULE.test(l.text));
    if (end !== -1) return [i, end];
  }
  return null;
}

// 起動時のバナー（「Opus 5 (1M context) · Claude Max」「Sonnet 5 with medium effort」など）。--resume ではバナーが出ない。
// 会話の本文にもモデル名は出てくるので、バナーの行だけを見る。バナーは 2 つの形がある
// - 枠の中（前の Claude Code）: 「│  Haiku 4.5 · Claude Max · …」
// - ロゴの右（今の Claude Code）: 「▐▛███▜▌   Claude Code v2.1.286」の次の行の「▝▜█████▛▘  Opus 5.5 · Claude Max」
export function findModel(lines: ScreenLine[]): string | null {
  const logo = lines.findIndex((l) => BANNER_TITLE.test(l.text));
  const banner = [...lines.filter((l) => l.text.startsWith('│')), ...(logo === -1 ? [] : lines.slice(logo + 1, logo + 3))];
  for (const { text } of banner) {
    // 新しい系統名にも対応できるよう、名前は決め打ちしない
    const m = text.match(/\b([A-Z][a-z]+ \d+(?:\.\d+)?(?: \(1M context\))?) ·/);
    if (m) return m[1];
  }
  return null;
}

// 入力欄の下の表示（例: 「⏵⏵ auto mode on (shift+tab to cycle)」「⏸ manual mode on」「⏵⏵ accept edits on」）
export function findMode(lines: ScreenLine[]): PermissionMode | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].text.match(/^\s*\S+\s+(manual mode|accept edits|plan mode|auto mode|bypass permissions) on\b/);
    if (!m) continue;
    const modes: Record<string, PermissionMode> = {
      'manual mode': 'manual',
      'accept edits': 'acceptEdits',
      'plan mode': 'plan',
      'auto mode': 'auto',
      'bypass permissions': 'bypassPermissions',
    };
    return modes[m[1]];
  }
  return null;
}

// /rewind の巻き戻し先の一覧。過去の発言が番号なしで並び、❯ の付いた行が選択中（最後は「(current)」）
export function parseRewind(lines: ScreenLine[]): { pointed: string } | null {
  const footer = lines.findIndex((l) => /Enter to continue · Esc to cancel/.test(l.text));
  if (footer === -1 || !lines.slice(Math.max(0, footer - 40), footer).some((l) => l.text.trim() === 'Rewind')) return null;
  for (let i = footer - 1; i >= 0; i--) {
    const m = lines[i].text.match(/^\s*❯\s+(.*)$/);
    if (m) return { pointed: m[1].trim() };
  }
  return null;
}

// 入力欄の上の表示（例: 「● high · /effort」）
export function findEffort(lines: ScreenLine[]): string | null {
  for (const { text } of lines) {
    const m = text.match(/\b(low|medium|high|xhigh|max)\s·\s\/effort/);
    if (m) return m[1];
  }
  return null;
}

// メニューの上端: 下端から上にたどり、直後が選択肢ではない横線（質問の区切り）の次の行。
// AskUserQuestion は選択肢の途中（「Chat about this」の前）にも横線があるので、それは飛ばす
function menuTop(lines: ScreenLine[], bottom: number): number {
  const limit = Math.max(0, bottom - MAX_MENU_LINES);
  for (let i = bottom - 1; i >= limit; i--) {
    if (TOP_EDGE.test(lines[i].text)) return i + 1;
    if (!RULE.test(lines[i].text)) continue;
    const next = lines.slice(i + 1, bottom).find((l) => l.text.trim());
    // 横線の下が選択肢なら、メニューの途中の区切り。プレビュー付きの質問では、番号の無い「Chat about this」が横線の下に来る
    if (!next || !(OPTION.test(next.text) || next.text.trim().replace(/^❯\s*/, '') === CHAT_ABOUT_THIS)) return i + 1;
  }
  return limit;
}

// 画面で最後に見えた選択肢の状態（チェック・自由記述に打った文字）。キーは「質問の番号:選択肢の ID」。
// 画面が低いと選択肢の一部しか出ないので、見えていない間は前に見えたときの状態を使う
export type SeenOptions = Map<string, Pick<MenuOption, 'label' | 'checked'>>;

// AskUserQuestion の選択メニューを、会話ログの質問（questions）から組み立て直す。
// 質問文・選択肢・説明・複数選択かどうかは questions を正とし、画面からはカーソル位置・チェック・
// 自由記述に打った文字・複数の質問のタブだけを読む。画面の質問文がどの質問にも合わなければ（別のメニュー）そのまま返す。
// 並びは Claude Code の画面と同じ: 選択肢 1〜n、自由記述（n+1）、複数選択なら Next / Submit、Chat about this（n+2）
export function applyQuestions(menu: Menu, questions: AskQuestion[], seen: SeenOptions): Menu {
  const chat = menu.options.find((o) => o.label === CHAT_ABOUT_THIS);
  if (menu.kind !== 'question' || (!chat && !menu.previewLayout)) return menu;
  // 画面の質問文（menu.title。枠が無い形では最後の行）を含む質問。短くて複数に合うときは、上の行まで続けて質問文全体が合うものにする
  const title = squash(menu.title);
  const header = squash([...menu.context, menu.title].join(''));
  const matches = title ? questions.flatMap((q, i) => (squash(q.question).includes(title) ? [i] : [])) : [];
  const byTitle = matches.length > 1 ? (matches.find((i) => header.endsWith(squash(questions[i].question))) ?? -1) : (matches[0] ?? -1);
  // メニューが画面より高くて上が切れると、質問文が見えない（menu.title は上の選択肢の説明の切れ端になる）。
  // そのときは、見えている選択肢の名前がそろう質問にする
  const firstShown = menu.options.find((o) => /^\d+$/.test(o.id));
  const cut = !!firstShown && firstShown.id !== '1';
  const index = byTitle === -1 && cut ? questionByOptions(menu, questions) : byTitle;
  if (index === -1) return menu;
  const q = questions[index];
  const onScreen = new Map(menu.options.map((o) => [o.id, o]));
  // 上が切れてカーソルが見えないとき、カーソルは見えている選択肢より上にある。見えていないのが 1 つめだけなら、そこにある
  const hiddenPointer = cut && !menu.options.some((o) => o.pointed) && firstShown.id === '2' ? '1' : null;
  const option = (id: string, base: Omit<MenuOption, 'id' | 'pointed' | 'checked'>, checkable: boolean): MenuOption => {
    const shown = onScreen.get(id);
    const key = `${index}:${id}`;
    if (shown) seen.set(key, { label: shown.label, checked: shown.checked });
    const last = seen.get(key);
    return {
      id,
      ...base,
      label: base.textInput ? (last?.label ?? 'Type something.') : base.label,
      pointed: shown?.pointed ?? id === hiddenPointer,
      checked: checkable ? (last?.checked ?? false) : null,
    };
  };
  const options: MenuOption[] = q.options.map((o, i) =>
    option(String(i + 1), { label: o.label, description: o.description, textInput: false, preview: o.preview }, q.multiSelect),
  );
  // プレビューが並ぶ形には、自由記述が無い
  if (!menu.previewLayout) options.push(option(String(q.options.length + 1), { label: '', description: '', textInput: true }, q.multiSelect));
  if (q.multiSelect) {
    const submit = onScreen.get('submit');
    const label = submit?.label ?? (index < questions.length - 1 ? 'Next' : 'Submit');
    options.push({ id: 'submit', label, description: '', pointed: submit?.pointed ?? false, checked: null, textInput: false });
  }
  if (chat) options.push({ ...chat, id: String(q.options.length + 2) });
  return { ...menu, title: q.question, context: [], options, multiSelect: q.multiSelect };
}

// 画面に見えている選択肢（番号と名前）と自由記述の番号が、すべて合う質問。1 つに決まらなければ -1
function questionByOptions(menu: Menu, questions: AskQuestion[]): number {
  const shown = menu.options.filter((o) => /^\d+$/.test(o.id) && o.label !== CHAT_ABOUT_THIS);
  const matches = questions.flatMap((q, i) => {
    const fits = shown.every((o) => {
      const n = Number(o.id);
      return o.textInput ? n === q.options.length + 1 : n <= q.options.length && squash(o.label) === squash(q.options[n - 1].label);
    });
    return shown.length > 0 && fits ? [i] : [];
  });
  return matches.length === 1 ? matches[0] : -1;
}

// AskUserQuestion の input から質問を取り出す。形が違えば null
export function askQuestionsOf(input: unknown): AskQuestion[] | null {
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const questions = list.map((q) => ({
    question: text(q?.question),
    header: text(q?.header),
    multiSelect: q?.multiSelect === true || q?.multiSelect === 'true',
    options: Array.isArray(q?.options)
      ? q.options.map((o: unknown) => {
          const opt = o as { label?: unknown; description?: unknown; preview?: unknown };
          return { label: text(opt?.label), description: text(opt?.description), preview: text(opt?.preview) || undefined };
        })
      : [],
  }));
  return questions.every((q) => q.question && q.options.length > 0) ? questions : null;
}

// 画面では質問文が端末の幅で折り返されるので、空白をすべて除いて比べる
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function parseTabs(line: string): { label: string; answered: boolean }[] {
  return line
    .replace(/[←→]/g, '')
    .split(/\s{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    // 最後の「✔ Submit」は質問ではなく、回答の確認画面
    .filter((t) => !t.startsWith('✔'))
    .map((t) => ({ label: t.replace(/^[☐☒]\s*/, ''), answered: t.startsWith('☒') }));
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}
