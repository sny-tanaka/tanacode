import { useState } from 'react';
import { t } from '@shared/i18n';
import type { PendingPermission, PermissionReply } from '@shared/questions';
import { CloseIcon, IconButton } from '../icons';

// カードに出す、ツールの入力の中身（Bash はコマンド、ファイルを書き換えるツールはファイル、ほかは入力の JSON。長ければ頭だけ）
const MAX_INPUT_CHARS = 4000;
function inputText(permission: PendingPermission): string {
  const { input } = permission;
  if (typeof input.command === 'string') return input.command;
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (file) return file;
  const json = JSON.stringify(input, null, 2);
  return json.length > MAX_INPUT_CHARS ? `${json.slice(0, MAX_INPUT_CHARS)}\n…` : json;
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

  const options: { key: string; label: string; reply: PermissionReply | null }[] = plan
    ? [
        { key: 'approve', label: t('screen.permission.planApprove'), reply: { kind: 'allow' } },
        { key: 'accept-edits', label: t('screen.permission.planAcceptEdits'), reply: { kind: 'accept-edits' } },
        { key: 'keep', label: t('screen.permission.planKeep'), reply: null },
      ]
    : [
        { key: 'allow', label: t('screen.permission.allow'), reply: { kind: 'allow' } },
        ...(permission.always ? [{ key: 'always', label: t('screen.permission.always', { rules: permission.always.join(', ') }), reply: { kind: 'allow', always: true } as const }] : []),
        { key: 'deny', label: t('screen.permission.deny'), reply: null },
      ];

  return (
    <div className={`menu-card ${plan ? 'plan' : 'permission'}`}>
      {/* 見出しの行。断って止めるのは右上（Claude Code の画面の Esc と同じ） */}
      <div className="menu-card-head">
        <div className="menu-card-kind">{t(plan ? 'screen.kind.plan' : 'screen.kind.permission')}</div>
        <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} tip={t('screen.permission.stopTip')} disabled={sending} onClick={() => send({ kind: 'stop' })} />
      </div>
      {plan ? permission.plan && <pre className="menu-context menu-plan">{permission.plan}</pre> : <pre className="menu-context">{inputText(permission)}</pre>}
      <div className="menu-title">{plan ? t('screen.permission.planTitle') : (permission.title ?? permission.tool)}</div>
      {(permission.description || permission.reason || permission.agent) && (
        <div className="menu-notes">
          {permission.description && <div>{permission.description}</div>}
          {permission.reason && <div>{t('screen.permission.reason', { reason: permission.reason })}</div>}
          {permission.agent && <div>{t('screen.permission.fromSubagent')}</div>}
        </div>
      )}
      <div className="menu-options">
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
              className="menu-option"
              disabled={sending}
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
