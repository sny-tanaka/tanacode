import { useEffect, useRef, useState } from 'react';
import { locale, t, type MessageKey } from '@shared/i18n';
import { HANDOFF_CARD_CHARS, HANDOFF_TAG, RESUME_TAG } from '@shared/optimized-compact';
import { changedPrompts, defaultPrompt, PROMPT_GROUPS, PROMPT_KEYS, PROMPT_MAX_CHARS, PROMPT_PLACEHOLDERS, type CustomPrompts, type PromptKey } from '@shared/prompts';
import { USAGE_RESUME_TAG } from '@shared/usage-limit';
import { errorMessage } from '../errorMessage';
import { tx } from '../i18n';

type Group = (typeof PROMPT_GROUPS)[number]['kind'];

const TAGS: Record<Group, string> = { usageResume: USAGE_RESUME_TAG, handoff: HANDOFF_TAG, resume: RESUME_TAG };

// 本文の欄（ほかは、本文の終わりに足す短い文）。入力欄の高さを変える
const BODIES = new Set<PromptKey>(['usageResume', 'handoff', 'resume', 'resumeMidTurn']);

// 場合で使う欄だけの、いつ使うかの説明（本文の欄は、文の説明で足りる）
const HINTS: Partial<Record<PromptKey, MessageKey>> = {
  handoffAutoTurnEnd: 'prompts.hint.handoffAutoTurnEnd',
  handoffAutoMidTurn: 'prompts.hint.handoffAutoMidTurn',
  resumeMidTurn: 'prompts.hint.resumeMidTurn',
  resumeSkipped: 'prompts.hint.resumeSkipped',
};

// 欄の中身。保存した文（変えた欄）があればそれ、無ければ既定の文
const draftsOf = (saved: CustomPrompts) => Object.fromEntries(PROMPT_KEYS.map((key) => [key, saved[key] ?? defaultPrompt(key)])) as Record<PromptKey, string>;
const isDefault = (key: PromptKey, text: string) => text.trim() === defaultPrompt(key).trim();

// tanacode が人の代わりに Claude に送る文（利用枠からの再開・最適化圧縮の仕上げの頼みと再開の文）を変える。メニューから開く。
// 欄には、変えた文か既定の文が入っていて、そこから直す。変えた欄は「既定の文」を開いて見比べられ、「既定に戻す」で戻せる。
// 保存するまでは送る文は変わらない。保存では、既定の文と同じ欄は持たない（あとで既定の文が変わったら、それに付いていく）
export function PromptsDialog({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<CustomPrompts | null>(null);
  const [drafts, setDrafts] = useState<Record<PromptKey, string>>(() => draftsOf({}));
  const [group, setGroup] = useState<Group>('usageResume');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 片付けたあとに届いた返事は使わない（打ち始めた欄を、あとから届いた返事で上書きしないように）
    let alive = true;
    void window.tanacode.prompts.get().then((prompts) => {
      if (!alive) return;
      setSaved(prompts);
      setDrafts(draftsOf(prompts));
    });
    // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      alive = false;
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const loaded = draftsOf(saved ?? {});
  const dirty = PROMPT_KEYS.some((key) => drafts[key] !== loaded[key]);
  const empty = PROMPT_KEYS.filter((key) => !drafts[key].trim());

  const close = () => {
    if (saving) return;
    if (dirty && !window.confirm(t('prompts.confirmDiscard'))) return;
    onClose();
  };

  const save = async () => {
    setSaving(true);
    try {
      await window.tanacode.prompts.set(changedPrompts(drafts));
      onClose();
    } catch (e) {
      setError(t('prompts.saveFailed', { error: errorMessage(e) }));
      setSaving(false);
    }
  };

  const set = (key: PromptKey, text: string) => setDrafts((current) => ({ ...current, [key]: text }));
  const current = PROMPT_GROUPS.find((g) => g.kind === group)!;

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open prompts-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('prompts.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="settings-files-head">
          <h2>{t('prompts.title')}</h2>
          <p>{t('prompts.description')}</p>
        </div>
        <div className="prompts-body">
          <div className="prompts-tabs" role="tablist" aria-label={t('prompts.tabsLabel')} aria-orientation="vertical">
            {PROMPT_GROUPS.map((g) => (
              <button
                key={g.kind}
                role="tab"
                aria-selected={g.kind === group}
                className={`prompts-tab${g.kind === group ? ' selected' : ''}`}
                onClick={() => setGroup(g.kind)}
              >
                <span className="prompts-tab-name">{t(`prompts.group.${g.kind}`)}</span>
                {g.keys.some((key) => !isDefault(key, drafts[key])) && <span className="prompts-changed">{t('prompts.changed')}</span>}
              </button>
            ))}
          </div>
          <div className="prompts-pane" role="tabpanel" aria-label={t(`prompts.group.${group}`)}>
            <p className="prompts-about">{tx(`prompts.about.${group}`, { tag: <code>{`<${TAGS[group]}>`}</code> })}</p>
            {group === 'handoff' && <p className="prompts-warning">{t('prompts.handoffWarning')}</p>}
            {/* 保存した文を読むまでは、欄を出さない（読む前に打った文が、読んだ文で消えないように） */}
            {saved !== null && current.keys.map((key) => <PromptField key={key} name={key} text={drafts[key]} onChange={(text) => set(key, text)} />)}
          </div>
        </div>
        {error && <div className="browser-hosts-error">{error}</div>}
        <div className="worktree-dialog-foot">
          <div className="spacer" />
          <button className="ghost-button" disabled={saving} onClick={close}>
            {t('common.cancel')}
          </button>
          <button className="send-button" disabled={saving || saved === null || !dirty || empty.length > 0} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// 1 つの欄。見出し（変えたら「変更済み」と「既定に戻す」）・いつ使うか・入力欄・差し込みの印・既定の文（変えたときだけ）
function PromptField({ name, text, onChange }: { name: PromptKey; text: string; onChange: (text: string) => void }) {
  const fallback = defaultPrompt(name);
  const changed = !isDefault(name, text);
  const hint = HINTS[name];
  const placeholders = PROMPT_PLACEHOLDERS[name];
  const id = `prompt-${name}`;
  return (
    <section className="prompt-field">
      <div className="prompt-field-head">
        <label htmlFor={id}>{t(`prompts.label.${name}`)}</label>
        {changed && <span className="prompts-changed">{t('prompts.changed')}</span>}
        <div className="spacer" />
        <button className="ghost-button" disabled={text === fallback} onClick={() => onChange(fallback)}>
          {t('prompts.reset')}
        </button>
      </div>
      {hint && <p className="prompt-field-hint">{t(hint)}</p>}
      <textarea
        id={id}
        className="prompt-field-input"
        value={text}
        maxLength={PROMPT_MAX_CHARS}
        spellCheck={false}
        rows={BODIES.has(name) ? 12 : 4}
        onChange={(e) => onChange(e.target.value)}
      />
      {!text.trim() && <p className="prompt-field-error">{t('prompts.empty')}</p>}
      {placeholders.length > 0 && (
        <div className="prompt-field-hint">
          <div>{t('prompts.placeholdersHeading')}</div>
          <ul className="prompt-placeholders">
            {placeholders.map((placeholder) => (
              <li key={placeholder}>
                {placeholder === 'trigger'
                  ? tx('prompts.placeholder.trigger', {
                      name: <code>{'{trigger}'}</code>,
                      manual: t('chat.compactPrompt.handoff.triggerManual'),
                      auto: t('chat.compactPrompt.handoff.triggerAuto', { percent: 80 }),
                    })
                  : tx('prompts.placeholder.chars', { name: <code>{'{chars}'}</code>, chars: HANDOFF_CARD_CHARS.toLocaleString(locale()) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {changed && (
        <details className="prompt-default">
          <summary>{t('prompts.showDefault')}</summary>
          <pre>{fallback}</pre>
        </details>
      )}
    </section>
  );
}
