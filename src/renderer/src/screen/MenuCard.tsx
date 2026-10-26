import { useState } from 'react';
import { diffLines } from 'diff';
import { t } from '@shared/i18n';
import type { PendingPermission, PermissionReply } from '@shared/questions';
import { stripControlChars } from '../chat/sanitize';
import { CloseIcon, IconButton } from '../icons';
import { keyList } from '../layout/keyRow';

// カードに出すツールの入力は、ひとまとまり（コマンド・差分・ほかの入力の値）ごとに、長ければ頭だけ
const MAX_INPUT_CHARS = 4000;

// 差分の 1 行。add: 足す行 / del: 消す行 / same: 変わらない行 / edit: 何個めの編集か（MultiEdit の区切り） / note: 編集のほかの入力・省いた印など、中身でない行
type DiffLine = { kind: 'add' | 'del' | 'same' | 'edit' | 'note'; text: string };
const DIFF_MARK: Record<DiffLine['kind'], string> = { add: '+', del: '-', same: ' ', edit: '', note: '' };

// カードに出す、ツールの入力。中身を見ずに許すことにならないよう、入力は全部出す。
// main: Bash はコマンド、ファイルを書き換えるツールはファイルのパス、ほかは入力の JSON / path: main がファイルのパスか /
// diff: ファイルを書き換えるツールの変更 / rest: main と diff に出していない入力（名前と値）
type InputView = { main: string; path: boolean; diff: DiffLine[] | null; rest: { key: string; value: string }[] };

// Claude Code から届いた文字（ツールの入力・確認する理由・プランなど）は、制御文字を除いてから出す。
// 入力の中身はモデルが、確認する理由はフォルダのフックが書くことがあり、ANSI のエスケープや、見た目の並びを入れ替える
// 双方向の制御文字（U+202E など）が入りうる。除くと、実際に使われる文字の並びのまま見える
const clean = stripControlChars;

// 長い文は頭だけにして、省いた文字の数を添える
function clip(text: string): string {
  return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n${t('screen.permission.omitted', { count: text.length - MAX_INPUT_CHARS })}` : text;
}

// 差分の行も、合わせて MAX_INPUT_CHARS 文字までにして、省いた文字の数を添える
function clipLines(lines: DiffLine[]): DiffLine[] {
  const total = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  const shown: DiffLine[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.text.length + 1 > MAX_INPUT_CHARS) {
      const head = line.text.slice(0, Math.max(0, MAX_INPUT_CHARS - used));
      if (head) shown.push({ ...line, text: head });
      shown.push({ kind: 'note', text: t('screen.permission.omitted', { count: total - used - head.length }) });
      return shown;
    }
    used += line.text.length + 1;
    shown.push(line);
  }
  return shown;
}

// 文を行に分ける（最後の改行のあとの空の行は数えない）
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

// 置き換える前と後の差分（行ごと）
function editLines(before: string, after: string): DiffLine[] {
  return diffLines(before, after).flatMap((part) =>
    splitLines(part.value).map((text): DiffLine => ({ kind: part.added ? 'add' : part.removed ? 'del' : 'same', text })),
  );
}

// 入力の値を文字にする（文字はそのまま、ほかは JSON）
const valueText = (value: unknown) => clip(clean(typeof value === 'string' ? value : JSON.stringify(value)));

// main と diff に出していない入力。説明（description）がカードの説明と同じなら、二度は出さない
function restOf(input: Record<string, unknown>, shown: string[], description: string | null): InputView['rest'] {
  return Object.entries(input)
    .filter(([key, value]) => !shown.includes(key) && !(key === 'description' && value === description))
    .map(([key, value]) => ({ key, value: valueText(value) }));
}

function inputView(permission: PendingPermission): InputView {
  const { tool, input, description } = permission;
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : null);
  const file = (key: string, diff: DiffLine[], shown: string[]): InputView => ({
    main: clean(text(key)!),
    path: true,
    diff: diff.length > 0 ? clipLines(diff.map((line) => ({ ...line, text: clean(line.text) }))) : null,
    rest: restOf(input, [key, ...shown], description),
  });
  if (tool === 'Edit' && text('file_path') !== null && text('old_string') !== null && text('new_string') !== null) {
    return file('file_path', editLines(text('old_string')!, text('new_string')!), ['old_string', 'new_string']);
  }
  if (tool === 'MultiEdit' && text('file_path') !== null && Array.isArray(input.edits) && input.edits.every(isEdit)) {
    const edits = input.edits;
    // 編集ごとに、何個めかと、置き換える前後でない入力（replace_all など）を先に出す
    const diff = edits.flatMap(({ old_string, new_string, ...extra }, i): DiffLine[] => [
      { kind: 'edit', text: t('screen.permission.editNumber', { n: i + 1, total: edits.length }) },
      ...Object.entries(extra).map(([key, value]): DiffLine => ({ kind: 'note', text: t('screen.permission.inputField', { key, value: valueText(value) }) })),
      ...editLines(old_string, new_string),
    ]);
    return file('file_path', diff, ['edits']);
  }
  // Write は書く中身を、NotebookEdit はセルの新しい中身を、足す行として出す（消すセルには新しい中身が無い）
  if (tool === 'Write' && text('file_path') !== null && text('content') !== null) {
    return file('file_path', splitLines(text('content')!).map((line) => ({ kind: 'add', text: line })), ['content']);
  }
  if (tool === 'NotebookEdit' && text('notebook_path') !== null && (input.new_source === undefined || text('new_source') !== null)) {
    const source = text('new_source');
    return file('notebook_path', source ? splitLines(source).map((line) => ({ kind: 'add', text: line })) : [], ['new_source']);
  }
  if (text('command') !== null) return { main: clip(clean(text('command')!)), path: false, diff: null, rest: restOf(input, ['command'], description) };
  return { main: clip(clean(JSON.stringify(input, null, 2))), path: false, diff: null, rest: [] };
}

function isEdit(value: unknown): value is { old_string: string; new_string: string } & Record<string, unknown> {
  const edit = value as { old_string?: unknown; new_string?: unknown } | null;
  return !!edit && typeof edit === 'object' && typeof edit.old_string === 'string' && typeof edit.new_string === 'string';
}

// ツールの入力（コマンドかファイルのパス、ファイルの変更、ほかの入力）
function InputDetail({ view }: { view: InputView }) {
  return (
    <div className="menu-input">
      {view.path ? <div className="menu-input-path">{view.main}</div> : <pre className="menu-context">{view.main}</pre>}
      {view.diff && (
        <pre className="menu-context menu-diff">
          {view.diff.map((line, i) => (
            <span key={i} className={line.kind}>
              {DIFF_MARK[line.kind]}
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {view.rest.length > 0 && (
        <div className="menu-input-rest">
          {view.rest.map(({ key, value }) => (
            // サンドボックスを外す（dangerouslyDisableSandbox など）入力は目立たせる
            <div key={key} className={key.startsWith('dangerously') && value !== 'false' ? 'danger' : undefined}>
              {t('screen.permission.inputField', { key, value })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Props = {
  sessionId: string;
  permission: PendingPermission;
};

// Claude Code が答えを待っている、質問でない要求（stream-json の can_use_tool）のカード。
// 許可の確認: 許可する・許可して今後は聞かない（Claude Code が候補を出したときだけ）・理由を伝えて断る（作業は続く）・右上の × で断って止める。
// プランの承認（ExitPlanMode）: 承認する・承認して編集を自動で進める・直してほしいことを伝えて計画を続ける・× で止める
// （「コンテキストを消して承認」は作らない。決めたこと）
export function MenuCard({ sessionId, permission }: Props) {
  const plan = permission.plan !== null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // 送れなかったときの知らせ
  const [failure, setFailure] = useState<string | null>(null);

  const send = (reply: PermissionReply) => {
    setSending(true);
    setFailure(null);
    window.tanacode.permission
      .reply(sessionId, permission.id, reply)
      .then(
        // 送れたら、待っている要求が無くなってカードが消える
        (ok) => !ok && setFailure(t('screen.permission.gone')),
        () => setFailure(t('screen.card.sendFailed')),
      )
      .finally(() => setSending(false));
  };

  const submitText = () => {
    if (!text.trim()) return;
    send({ kind: 'deny', message: text.trim() });
  };

  // プランの本文を読めなかった（main がプランのファイルからも Claude の呼び出しからも取れなかった）。
  // 中身を見ずに承認しないよう、承認の 2 つは押せなくする。計画を続ける・× は使える
  const planMissing = permission.plan === '';

  const options: { key: string; label: string; reply: PermissionReply | null; unavailable?: boolean }[] = plan
    ? [
        { key: 'approve', label: t('screen.permission.planApprove'), reply: { kind: 'allow' }, unavailable: planMissing },
        { key: 'accept-edits', label: t('screen.permission.planAcceptEdits'), reply: { kind: 'accept-edits' }, unavailable: planMissing },
        { key: 'keep', label: t('screen.permission.planKeep'), reply: null },
      ]
    : [
        { key: 'allow', label: t('screen.permission.allow'), reply: { kind: 'allow' } },
        ...(permission.always ? [{ key: 'always', label: t('screen.permission.always', { rules: clean(permission.always.join(', ')) }), reply: { kind: 'allow', always: true } as const }] : []),
        { key: 'deny', label: t('screen.permission.deny'), reply: null },
      ];

  return (
    <div className={`menu-card ${plan ? 'plan' : 'permission'}`} data-answer-card="">
      {/* 見出しの行。断って止めるのは右上（Claude Code の画面の Esc と同じ働き）。キーの Esc には割り当てない。
          エディタ・ターミナル・入力欄の候補・ダイアログを閉じるのに押した Esc で、作業まで止めてしまうため */}
      <div className="menu-card-head">
        <div className="menu-card-kind">{t(plan ? 'screen.kind.plan' : 'screen.kind.permission')}</div>
        <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} tip={t('screen.permission.stopTip')} disabled={sending} onClick={() => send({ kind: 'stop' })} />
      </div>
      {!plan ? (
        <InputDetail view={inputView(permission)} />
      ) : planMissing ? (
        <div className="menu-plan-missing" role="status">
          {t('screen.permission.planMissing')}
        </div>
      ) : (
        <pre className="menu-context menu-plan">{clean(permission.plan!)}</pre>
      )}
      <div className="menu-title">{plan ? t('screen.permission.planTitle') : clean(permission.title ?? permission.tool)}</div>
      {(permission.description || permission.reason || permission.agent) && (
        <div className="menu-notes">
          {permission.description && <div>{clean(permission.description)}</div>}
          {permission.reason && <div>{t('screen.permission.reason', { reason: clean(permission.reason) })}</div>}
          {permission.agent && <div>{t('screen.permission.fromSubagent')}</div>}
        </div>
      )}
      <div className="menu-options" {...keyList()}>
        {options.map((option) =>
          option.reply === null && editing ? (
            <form
              key={option.key}
              className="menu-text-input multiline"
              onSubmit={(e) => {
                e.preventDefault();
                submitText();
              }}
            >
              <textarea
                autoFocus
                rows={3}
                value={text}
                placeholder={t(plan ? 'screen.permission.planPlaceholder' : 'screen.permission.denyPlaceholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // チャットの入力欄と同じく、Enter は改行、⌘+Enter で送る。変換確定の Enter では送らない
                  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  submitText();
                }}
              />
              <div className="menu-text-actions">
                <button className="send-button" type="submit" disabled={!text.trim() || sending}>
                  {t('screen.card.send')}
                </button>
                {/* やめたら書きかけは捨てる（開き直した欄は空） */}
                <IconButton
                  icon={CloseIcon}
                  size="md"
                  label={t('screen.card.stopEditing')}
                  onClick={() => {
                    setEditing(false);
                    setText('');
                  }}
                />
              </div>
            </form>
          ) : (
            <button
              key={option.key}
              type="button"
              className={`menu-option${option.unavailable ? ' unavailable' : ''}`}
              disabled={sending || option.unavailable}
              onClick={() => (option.reply ? send(option.reply) : setEditing(true))}
            >
              <span className="menu-option-text">
                <span className="menu-option-label">{option.label}</span>
              </span>
            </button>
          ),
        )}
      </div>
      {failure && (
        <div className="menu-card-error" role="alert">
          {failure}
        </div>
      )}
    </div>
  );
}
