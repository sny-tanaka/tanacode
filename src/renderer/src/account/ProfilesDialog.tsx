import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import { DEFAULT_PROFILE_ID, PROFILE_COLORS, type ProfileInfo } from '@shared/profile';
import { errorMessage } from '../errorMessage';
import { tx } from '../i18n';
import { AddIcon, CloseIcon, IconButton, TrashIcon } from '../icons';
import { defaultClaudeDir, useProfiles, type ProfilesDialogMode } from './profiles';

// プロファイル（Claude Code のアカウントごとの環境）の管理。名前と色を変える・登録から外す・足す。
// 足すと、そのプロファイルに切り替えて閉じる（ログインはアカウント欄のメニューから）
export function ProfilesDialog({ mode, onClose }: { mode: ProfilesDialogMode; onClose: () => void }) {
  const state = useProfiles();
  const profiles = state?.profiles ?? [];
  const [adding, setAdding] = useState(mode === 'add');
  // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  // 名前を直している途中なら、閉じる前に確定させる（入力欄が消えると blur が届かない）
  const close = () => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    onClose();
  };

  const remove = async (profile: ProfileInfo) => {
    if (!window.confirm(t('account.profiles.confirmRemove', { name: profile.name, dir: tilde(profile.claudeDir) }))) return;
    try {
      await window.tanacode.profiles.remove(profile.id);
    } catch (error) {
      window.alert(t('account.profiles.removeFailed', { error: errorMessage(error) }));
    }
    dialog.current?.focus();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open settings-files-dialog profiles-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('account.profiles.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="settings-files-head">
          <h2>{t('account.profiles.title')}</h2>
          <p>{t('account.profiles.about')}</p>
        </div>
        <div className="quick-open-list">
          {profiles.map((profile) => (
            <ProfileRow key={profile.id} profile={profile} onRemove={() => void remove(profile)} />
          ))}
        </div>
        {adding ? (
          <NewProfileForm profiles={profiles} onCancel={() => setAdding(false)} onAdded={close} />
        ) : (
          <div className="settings-files-foot">
            <IconButton icon={AddIcon} label={t('common.add')} tip={t('account.profiles.addTip')} onClick={() => setAdding(true)} />
            <IconButton icon={CloseIcon} label={t('common.close')} tip={t('account.profiles.closeTip')} onClick={close} />
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileRow({ profile, onRemove }: { profile: ProfileInfo; onRemove: () => void }) {
  const [name, setName] = useState(profile.name);
  // 名前は main が決めて返す（空白を除くなど）ので、届いた名前が変わったら合わせる。
  // useEffect で合わせると、表示したあとに遅れて走り、打ち始めた名前を元に戻してしまうことがあるので、描くときに変わったかを見る
  const [shownName, setShownName] = useState(profile.name);
  if (profile.name !== shownName) {
    setShownName(profile.name);
    setName(profile.name);
  }
  // Escape で戻したときは、続く blur で確定しない
  const cancelled = useRef(false);
  const update = (patch: { name?: string; color?: string }) =>
    window.tanacode.profiles.update(profile.id, patch).catch((error: unknown) => {
      setName(profile.name);
      window.alert(t('account.profiles.updateFailed', { error: errorMessage(error) }));
    });
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (name !== profile.name) void update({ name });
  };

  return (
    <div className="settings-file-row profile-row">
      <span className="profile-dot" style={{ background: profile.color }} />
      <div className="settings-file-body">
        <input
          className="settings-file-name"
          value={name}
          spellCheck={false}
          aria-label={t('account.profiles.name')}
          title={t('account.profiles.renameTip')}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              // ダイアログは閉じず、名前を戻すだけ
              e.stopPropagation();
              cancelled.current = true;
              setName(profile.name);
              e.currentTarget.blur();
            }
          }}
        />
        <span className="settings-file-path" title={profile.claudeDir ?? undefined}>
          {profile.claudeDir === null ? t('account.profiles.defaultDir') : tilde(profile.claudeDir)}
        </span>
      </div>
      <ColorPicker value={profile.color} onChange={(color) => void update({ color })} />
      {profile.id !== DEFAULT_PROFILE_ID ? (
        <IconButton size="sm" icon={TrashIcon} label={t('common.delete')} tip={t('account.profiles.removeTip')} onClick={onRemove} />
      ) : (
        <span className="profile-row-spacer" />
      )}
    </div>
  );
}

// 足す欄。名前・色・Claude Code の設定のフォルダ（既定は ~/.claude-<名前>。既にあるフォルダも選べる）
function NewProfileForm({ profiles, onCancel, onAdded }: { profiles: ProfileInfo[]; onCancel: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  // 色とフォルダは、自分で選ぶまでは、まだ使っていない色と、名前から決めたフォルダ
  const [chosenColor, setColor] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const color = chosenColor ?? PROFILE_COLORS.find((c) => !profiles.some((p) => p.color === c)) ?? PROFILE_COLORS[0];
  const claudeDir = dir ?? defaultClaudeDir(name, profiles.map((p) => p.claudeDir));
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => nameInput.current?.focus(), []);

  const pick = async () => {
    const picked = await window.tanacode.profiles.pickDir();
    if (picked) setDir(picked);
  };
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const added = await window.tanacode.profiles.add({ name, color, claudeDir });
      await window.tanacode.profiles.switch(added.id);
      onAdded();
    } catch (error) {
      window.alert(t('account.profiles.addFailed', { error: errorMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="profile-new"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="profile-new-field">
        <span>{t('account.profiles.name')}</span>
        <input
          ref={nameInput}
          value={name}
          spellCheck={false}
          placeholder={t('account.profiles.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="profile-new-field">
        <span>{t('account.profiles.color')}</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="profile-new-field">
        <span>{t('account.profiles.folder')}</span>
        <input aria-label={t('account.profiles.folderLabel')} value={claudeDir} spellCheck={false} onChange={(e) => setDir(e.target.value)} />
        <button type="button" className="ghost-button" onClick={() => void pick()}>
          {t('account.profiles.pickFolder')}
        </button>
      </div>
      <p className="profile-new-note">{tx('account.profiles.folderNote', { command: <code>CLAUDE_CONFIG_DIR={claudeDir} claude</code> })}</p>
      <div className="settings-files-foot">
        <button type="button" className="ghost-button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="send-button" disabled={!name.trim() || busy}>
          {t('common.add')}
        </button>
      </div>
    </form>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="profile-colors" role="radiogroup" aria-label={t('account.profiles.color')}>
      {PROFILE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={color}
          className={`profile-color${color === value ? ' selected' : ''}`}
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

function tilde(path: string | null): string {
  return (path ?? '~/.claude').replace(/^\/Users\/[^/]+/, '~');
}
