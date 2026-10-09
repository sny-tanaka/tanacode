import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PROFILE_ID, PROFILE_COLORS, type ProfileInfo } from '@shared/profile';
import { errorMessage } from '../errorMessage';
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
    if (!window.confirm(`「${profile.name}」を登録から外します。\nClaude Code の設定のフォルダ（${tilde(profile.claudeDir)}）とセッションのデータは消えません。もう一度足せば、同じログインのまま使えます。`)) return;
    try {
      await window.tanacode.profiles.remove(profile.id);
    } catch (error) {
      window.alert(`外せませんでした: ${errorMessage(error)}`);
    }
    dialog.current?.focus();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open settings-files-dialog profiles-dialog"
        ref={dialog}
        role="dialog"
        aria-label="プロファイル"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="settings-files-head">
          <h2>プロファイル</h2>
          <p>
            {'Claude Code のアカウントごとに、ログイン・セッション・設定を分けて使えます。' +
              'プロファイルごとに Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR）を持ち、ほかのプロファイルとは混ざりません。'}
          </p>
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
            <IconButton icon={AddIcon} label="追加" tip="プロファイルを追加…" onClick={() => setAdding(true)} />
            <IconButton icon={CloseIcon} label="閉じる" tip="閉じる（Esc）" onClick={close} />
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileRow({ profile, onRemove }: { profile: ProfileInfo; onRemove: () => void }) {
  const [name, setName] = useState(profile.name);
  // 名前は main が決めて返す（空白を除くなど）ので、一覧が変わったら合わせる
  useEffect(() => setName(profile.name), [profile.name]);
  // Escape で戻したときは、続く blur で確定しない
  const cancelled = useRef(false);
  const update = (patch: { name?: string; color?: string }) =>
    window.tanacode.profiles.update(profile.id, patch).catch((error: unknown) => {
      setName(profile.name);
      window.alert(`変えられませんでした: ${errorMessage(error)}`);
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
          aria-label="名前"
          title="クリックして名前を変える"
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
          {profile.claudeDir === null ? '~/.claude（標準）' : tilde(profile.claudeDir)}
        </span>
      </div>
      <ColorPicker value={profile.color} onChange={(color) => void update({ color })} />
      {profile.id !== DEFAULT_PROFILE_ID ? (
        <IconButton size="sm" icon={TrashIcon} label="削除" tip="登録から外す（設定のフォルダとデータは消えません）" onClick={onRemove} />
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
      window.alert(`追加できませんでした: ${errorMessage(error)}`);
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
        <span>名前</span>
        <input ref={nameInput} value={name} spellCheck={false} placeholder="例: 個人" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="profile-new-field">
        <span>色</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="profile-new-field">
        <span>フォルダ</span>
        <input aria-label="Claude Code の設定のフォルダ" value={claudeDir} spellCheck={false} onChange={(e) => setDir(e.target.value)} />
        <button type="button" className="ghost-button" onClick={() => void pick()}>
          選ぶ…
        </button>
      </div>
      <p className="profile-new-note">
        Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR）。無ければ作ります。ターミナルでも <code>CLAUDE_CONFIG_DIR={claudeDir} claude</code>{' '}
        で同じアカウントを使えます。追加したら、アカウント欄のメニューの「ログイン…」でログインしてください。
      </p>
      <div className="settings-files-foot">
        <button type="button" className="ghost-button" onClick={onCancel}>
          キャンセル
        </button>
        <button type="submit" className="send-button" disabled={!name.trim() || busy}>
          追加
        </button>
      </div>
    </form>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="profile-colors" role="radiogroup" aria-label="色">
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
