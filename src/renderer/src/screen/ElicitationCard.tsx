import { useId, useState } from 'react';
import { initialDraft, readDraft, type ElicitationDraft, type ElicitationField, type ElicitationProblem, type ElicitationReply, type PendingElicitation, type TextFormat } from '@shared/elicitation';
import { t, type MessageKey } from '@shared/i18n';
import { CloseIcon, IconButton } from '../icons';

type Props = {
  sessionId: string;
  elicitation: PendingElicitation;
};

// 文字の項目の入力欄の種類（format ごと。キーボードと、日付・日時の選び方が変わる）
const INPUT_TYPE: Record<TextFormat, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };
const FORMAT_PROBLEM: Record<TextFormat, MessageKey> = {
  email: 'screen.elicitation.problem.email',
  uri: 'screen.elicitation.problem.uri',
  date: 'screen.elicitation.problem.date',
  'date-time': 'screen.elicitation.problem.dateTime',
};

// 入力の誤りの文
function problemText(field: ElicitationField, problem: ElicitationProblem): string {
  switch (problem.kind) {
    case 'required':
      return t(field.type === 'select' || field.type === 'multi' ? 'screen.elicitation.problem.pick' : 'screen.elicitation.problem.required');
    case 'tooShort':
      return t('screen.elicitation.problem.tooShort', { min: problem.min });
    case 'tooLong':
      return t('screen.elicitation.problem.tooLong', { max: problem.max });
    case 'format':
      return t(FORMAT_PROBLEM[problem.format]);
    case 'number':
      return t('screen.elicitation.problem.number');
    case 'integer':
      return t('screen.elicitation.problem.integer');
    case 'tooSmall':
      return t('screen.elicitation.problem.tooSmall', { min: problem.min });
    case 'tooLarge':
      return t('screen.elicitation.problem.tooLarge', { max: problem.max });
    case 'tooFew':
      return t('screen.elicitation.problem.tooFew', { min: problem.min });
    case 'tooMany':
      return t('screen.elicitation.problem.tooMany', { max: problem.max });
    case 'option':
      return t('screen.elicitation.problem.option');
  }
}

// 開くページ。ホスト（どこへ行くか）を目立たせる。user@host の形などで、見せかけのホストに惑わされないように
function UrlText({ url }: { url: string }) {
  let parts: [string, string, string] | null = null;
  try {
    const parsed = new URL(url);
    const tail = parsed.host + parsed.pathname + parsed.search + parsed.hash;
    if (parsed.host && url.endsWith(tail)) parts = [url.slice(0, url.length - tail.length), parsed.host, tail.slice(parsed.host.length)];
  } catch {
    // 読めない URL は、そのまま出す（開けない）
  }
  return (
    <div className="menu-input-path menu-elicitation-url">
      {parts ? (
        <>
          {parts[0]}
          <strong>{parts[1]}</strong>
          {parts[2]}
        </>
      ) : (
        url
      )}
    </div>
  );
}

// フォームの 1 項目の入力欄
function FieldInput({ field, id, value, disabled, invalid, onChange }: { field: ElicitationField; id: string; value: ElicitationDraft[string] | undefined; disabled: boolean; invalid: boolean; onChange: (value: ElicitationDraft[string]) => void }) {
  const text = typeof value === 'string' ? value : '';
  const common = { id, disabled, 'aria-invalid': invalid || undefined };
  switch (field.type) {
    case 'text':
      return (
        <input
          {...common}
          type={field.format ? INPUT_TYPE[field.format] : 'text'}
          value={text}
          maxLength={field.maxLength ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          {...common}
          type="number"
          inputMode={field.integer ? 'numeric' : 'decimal'}
          step={field.integer ? 1 : 'any'}
          min={field.minimum ?? undefined}
          max={field.maximum ?? undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'boolean':
      return null;
    case 'select':
      return (
        <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
          {/* 必須でなければ、選ばないこともできる。必須でも、はじめは選んでいないことを見せる */}
          {(!field.required || !text) && <option value="">{t(field.required ? 'screen.elicitation.choose' : 'screen.elicitation.none')}</option>}
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'multi': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div className="menu-field-choices" role="group" aria-labelledby={`${id}-label`}>
          {field.options.map((o) => (
            <label key={o.value} className="menu-field-check">
              <input
                type="checkbox"
                disabled={disabled}
                checked={picked.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...picked, o.value] : picked.filter((v) => v !== o.value))}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
  }
}

// MCP サーバーから人への質問（Claude Code の elicitation。PendingElicitation）のカード。どのサーバーからの質問かと、質問の文を出す。
// フォームの形: 項目の入力欄を並べ、確かめてから送る（accept と中身）か、断る（decline）。出せない形の項目があれば、断ることだけできる。
// URL の形: 「ページを開く」（ふだんのブラウザで開き、同意として accept を返す）か、断る。開いたあとは、MCP サーバーが完了を知らせるまで
// 完了待ちのカードにする（もう一度開く・閉じる）。右上の × は、答えずに閉じる（cancel。Claude の作業は止めない）
export function ElicitationCard({ sessionId, elicitation }: Props) {
  const { fields, mode, opened } = elicitation;
  const baseId = useId();
  const [draft, setDraft] = useState<ElicitationDraft>(() => initialDraft(fields));
  // 送ろうとしたあとから、入力の誤りを出す（打つ前から赤くしない）
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  // 送れなかったときの知らせ
  const [failure, setFailure] = useState<string | null>(null);

  const { content, problems } = readDraft(fields, draft);
  const unsupported = elicitation.unsupported.length > 0;
  // 送れる答え（フォームを送る・ページを開く）が無く、断ることしかできない
  const declineOnly = mode === 'url' ? !elicitation.openable : unsupported;

  const send = (reply: ElicitationReply) => {
    setSending(true);
    setFailure(null);
    window.tanacode.elicitation
      .reply(sessionId, elicitation.id, reply)
      .then(
        // 送れたら、待っている質問が無くなるか、完了待ちに変わって、カードが描き直される
        (ok) => !ok && setFailure(t('screen.elicitation.gone')),
        () => setFailure(t('screen.card.sendFailed')),
      )
      .finally(() => setSending(false));
  };

  const submit = () => {
    setTried(true);
    if (Object.keys(problems).length === 0) send({ kind: 'accept', content });
  };

  return (
    <div className={`menu-card elicitation${opened ? ' opened' : ''}`} data-answer-card="">
      <div className="menu-card-head">
        <div className="menu-card-kind">{t('screen.kind.elicitation')}</div>
        {!opened && <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} tip={t('screen.elicitation.cancelTip')} disabled={sending} onClick={() => send({ kind: 'cancel' })} />}
      </div>
      <div className="menu-elicitation-server">{t('screen.elicitation.server', { server: elicitation.server })}</div>
      {elicitation.title && <div className="menu-elicitation-heading">{elicitation.title}</div>}
      <div className="menu-title">{elicitation.message}</div>
      {elicitation.description && (
        <div className="menu-notes">
          <div>{elicitation.description}</div>
        </div>
      )}
      {mode === 'url' ? (
        <>
          {elicitation.url && <UrlText url={elicitation.url} />}
          {elicitation.openable ? (
            <div className="menu-notes" role={opened ? 'status' : undefined}>
              <div>{t(opened ? 'screen.elicitation.opened' : 'screen.elicitation.openNote')}</div>
            </div>
          ) : (
            <div className="menu-elicitation-warning" role="status">
              {t('screen.elicitation.notOpenable')}
            </div>
          )}
        </>
      ) : unsupported ? (
        <div className="menu-elicitation-warning" role="status">
          {t('screen.elicitation.unsupported', { fields: elicitation.unsupported.join(', ') })}
        </div>
      ) : (
        fields.length > 0 && (
          <form
            id={`${baseId}-form`}
            className="menu-fields"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {fields.map((field) => {
              const id = `${baseId}-${field.key}`;
              const problem = tried ? problems[field.key] : undefined;
              const set = (value: ElicitationDraft[string]) => setDraft((prev) => ({ ...prev, [field.key]: value }));
              return (
                <div key={field.key} className={`menu-field${problem ? ' invalid' : ''}`}>
                  {field.type === 'boolean' ? (
                    <label className="menu-field-check">
                      <input id={id} type="checkbox" disabled={sending} checked={draft[field.key] === true} onChange={(e) => set(e.target.checked)} />
                      <span className="menu-field-label">{field.title}</span>
                    </label>
                  ) : (
                    <label id={`${id}-label`} className="menu-field-label" htmlFor={field.type === 'multi' ? undefined : id}>
                      {field.title}
                      {field.required && <span className="menu-field-required">{t('screen.elicitation.required')}</span>}
                    </label>
                  )}
                  {field.description && <div className="menu-field-desc">{field.description}</div>}
                  <FieldInput field={field} id={id} value={draft[field.key]} disabled={sending} invalid={!!problem} onChange={set} />
                  {problem && <div className="menu-field-error">{problemText(field, problem)}</div>}
                </div>
              );
            })}
          </form>
        )
      )}
      <div className="menu-options">
        {opened ? (
          <>
            <button type="button" className="menu-option submit" disabled={sending} onClick={() => send({ kind: 'reopen' })}>
              {t('screen.elicitation.reopen')}
            </button>
            <button type="button" className="menu-option" disabled={sending} onClick={() => send({ kind: 'dismiss' })}>
              <span className="menu-option-text">
                <span className="menu-option-label">{t('screen.elicitation.dismiss')}</span>
              </span>
            </button>
          </>
        ) : (
          <>
            {!declineOnly &&
              (mode === 'url' ? (
                <button type="button" className="menu-option submit" disabled={sending} onClick={() => send({ kind: 'open' })}>
                  {t('screen.elicitation.open')}
                </button>
              ) : (
                // 項目が無ければ、フォームを出さずに確かめるだけ（送ると、空の中身で accept）
                <button type={fields.length > 0 ? 'submit' : 'button'} form={fields.length > 0 ? `${baseId}-form` : undefined} className="menu-option submit" disabled={sending} onClick={fields.length > 0 ? undefined : submit}>
                  {t('screen.elicitation.submit')}
                </button>
              ))}
            <button type="button" className="menu-option" disabled={sending} onClick={() => send({ kind: 'decline' })}>
              <span className="menu-option-text">
                <span className="menu-option-label">{t('screen.elicitation.decline')}</span>
              </span>
            </button>
          </>
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
