import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BROWSER_HOSTS, normalizeHostPattern } from '@shared/browser-tools';
import { errorMessage } from '../errorMessage';
import { AddIcon, CloseIcon, IconButton, TrashIcon } from '../icons';

// アプリ内ブラウザで、Claude が開いて・読んで・操作してよい先。既定（localhost・127.0.0.1・*.local）に足す。
// アプリ内ブラウザはログイン状態を共有するので、外のサイトは、ユーザーが足したものだけにする。メニューから開く
export function BrowserHostsDialog({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.tanacode.browser.hosts().then((list) => setHosts(Array.isArray(list) ? list : []));
    // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
    const before = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const save = async (next: string[]) => {
    try {
      setHosts(await window.tanacode.browser.setHosts(next));
      setError(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const add = async () => {
    const host = normalizeHostPattern(input);
    if (!host) {
      setError(`書き方が違います: ${input.trim() || '（空）'}（例: example.test・*.example.test・192.168.0.10）`);
      return;
    }
    if (DEFAULT_BROWSER_HOSTS.includes(host) || hosts.includes(host)) {
      setInput('');
      setError(null);
      return;
    }
    if (await save([...hosts, host])) setInput('');
  };

  const remove = async (host: string) => {
    await save(hosts.filter((h) => h !== host));
    dialog.current?.focus();
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="quick-open settings-files-dialog"
        ref={dialog}
        role="dialog"
        aria-label="アプリ内ブラウザで Claude に許す先"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="settings-files-head">
          <h2>アプリ内ブラウザで Claude に許す先</h2>
          <p>
            {'Claude がアプリ内ブラウザで開いて・読んで・操作できるのは、ここにある先のページだけです。' +
              'アプリ内ブラウザはログイン状態を共有するので、信頼できる開発用の先だけを足してください。'}
          </p>
        </div>
        <div className="quick-open-list">
          {DEFAULT_BROWSER_HOSTS.map((host) => (
            <div key={host} className="settings-file-row">
              <div className="settings-file-body">
                <span className="browser-host">{host}</span>
              </div>
              <span className="browser-host-default">既定</span>
            </div>
          ))}
          {hosts.map((host) => (
            <div key={host} className="settings-file-row">
              <div className="settings-file-body">
                <span className="browser-host">{host}</span>
              </div>
              <IconButton icon={TrashIcon} danger label="削除" onClick={() => void remove(host)} />
            </div>
          ))}
        </div>
        {error && <div className="browser-hosts-error">{error}</div>}
        <form
          className="settings-files-foot browser-hosts-foot"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            ref={inputRef}
            className="browser-hosts-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例: myapp.test・*.example.test"
            spellCheck={false}
            aria-label="足す先"
          />
          <IconButton icon={AddIcon} type="submit" label="追加" disabled={!input.trim()} />
          <IconButton icon={CloseIcon} label="閉じる" tip="閉じる（Esc）" onClick={onClose} />
        </form>
      </div>
    </div>
  );
}
