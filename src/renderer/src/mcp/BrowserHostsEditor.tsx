import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BROWSER_HOSTS, normalizeHostPattern } from '@shared/browser-tools';
import { t } from '@shared/i18n';
import { errorMessage } from '../errorMessage';
import { AddIcon, IconButton, TrashIcon } from '../icons';

// アプリ内ブラウザで、Claude が開いて・読んで・操作してよい先。既定（localhost・127.0.0.1・*.local）に足す。
// アプリ内ブラウザはログイン状態を共有するので、外のサイトは、ユーザーが足したものだけにする。MCP の設定のダイアログの、アプリ内ブラウザの見出しの下に出す
export function BrowserHostsEditor() {
  const [hosts, setHosts] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.tanacode.browser.hosts().then((list) => setHosts(Array.isArray(list) ? list : []));
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
      setError(t('preview.hosts.invalid', { input: input.trim() || t('preview.hosts.empty') }));
      return;
    }
    if (DEFAULT_BROWSER_HOSTS.includes(host) || hosts.includes(host)) {
      setInput('');
      setError(null);
      return;
    }
    if (await save([...hosts, host])) setInput('');
  };

  // 押したボタンは消えるので、Esc で閉じられるよう、包んでいるダイアログにフォーカスを戻す
  const remove = async (host: string) => {
    await save(hosts.filter((h) => h !== host));
    box.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  };

  return (
    <div ref={box} className="browser-hosts-editor" role="group" aria-label={t('mcpSettings.hostsTitle')}>
      <h4>{t('mcpSettings.hostsTitle')}</h4>
      <p className="browser-hosts-about">{t('preview.hosts.description')}</p>
      {DEFAULT_BROWSER_HOSTS.map((host) => (
        <div key={host} className="settings-file-row">
          <div className="settings-file-body">
            <span className="browser-host">{host}</span>
          </div>
          <span className="browser-host-default">{t('preview.hosts.default')}</span>
        </div>
      ))}
      {hosts.map((host) => (
        <div key={host} className="settings-file-row">
          <div className="settings-file-body">
            <span className="browser-host">{host}</span>
          </div>
          <IconButton icon={TrashIcon} danger label={t('common.delete')} onClick={() => void remove(host)} />
        </div>
      ))}
      {error && <div className="browser-hosts-error">{error}</div>}
      <form
        className="browser-hosts-foot"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="browser-hosts-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('preview.hosts.placeholder')}
          spellCheck={false}
          aria-label={t('preview.hosts.inputLabel')}
        />
        <IconButton icon={AddIcon} type="submit" label={t('common.add')} disabled={!input.trim()} />
      </form>
    </div>
  );
}
