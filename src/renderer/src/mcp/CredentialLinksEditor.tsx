import { useEffect, useRef, useState } from 'react';
import { isItemLink, normalizeSite, type CredentialLink } from '@shared/credential-links';
import { t } from '@shared/i18n';
import { errorMessage } from '../errorMessage';
import { AddIcon, IconButton, TrashIcon } from '../icons';

// サイトごとに控える 1Password のアイテムのリンク。控えたサイトでは、Claude がリンクを書かなくても、fill_credential でそのアイテムを使える。
// 控えるのはリンクだけ（秘密は控えない）。MCP の設定のダイアログの、アプリ内ブラウザの見出しの下（許す先の下）に出す
export function CredentialLinksEditor() {
  const [links, setLinks] = useState<CredentialLink[]>([]);
  const [site, setSite] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.tanacode.browser.credentialLinks().then((list) => setLinks(Array.isArray(list) ? list : []));
  }, []);

  const save = async (next: CredentialLink[]) => {
    try {
      setLinks(await window.tanacode.browser.setCredentialLinks(next));
      setError(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const add = async () => {
    const normalized = normalizeSite(site);
    if (!normalized) {
      setError(t('preview.credentialLinks.invalidSite', { site: site.trim() || t('preview.hosts.empty') }));
      return;
    }
    if (!isItemLink(link)) {
      setError(t('preview.credentialLinks.invalidLink'));
      return;
    }
    // 同じサイトは置き換える
    if (await save([...links.filter((l) => l.site !== normalized), { site: normalized, link: link.trim() }])) {
      setSite('');
      setLink('');
    }
  };

  // 押したボタンは消えるので、Esc で閉じられるよう、包んでいるダイアログにフォーカスを戻す
  const remove = async (target: string) => {
    await save(links.filter((l) => l.site !== target));
    box.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  };

  return (
    <div ref={box} className="browser-hosts-editor credential-links-editor" role="group" aria-label={t('mcpSettings.credentialLinksTitle')}>
      <h4>{t('mcpSettings.credentialLinksTitle')}</h4>
      <p className="browser-hosts-about">{t('preview.credentialLinks.description')}</p>
      {links.length === 0 && <p className="credential-links-empty">{t('preview.credentialLinks.none')}</p>}
      {links.map((entry) => (
        <div key={entry.site} className="settings-file-row">
          <div className="settings-file-body credential-link-body">
            <span className="browser-host">{entry.site}</span>
            <span className="credential-link" title={entry.link}>
              {entry.link}
            </span>
          </div>
          <IconButton icon={TrashIcon} danger label={t('preview.credentialLinks.remove', { site: entry.site })} onClick={() => void remove(entry.site)} />
        </div>
      ))}
      {error && <div className="browser-hosts-error">{error}</div>}
      <form
        className="browser-hosts-foot credential-links-foot"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="browser-hosts-input credential-links-site"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder={t('preview.credentialLinks.sitePlaceholder')}
          spellCheck={false}
          aria-label={t('preview.credentialLinks.siteLabel')}
        />
        <input
          className="browser-hosts-input"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={t('preview.credentialLinks.linkPlaceholder')}
          spellCheck={false}
          aria-label={t('preview.credentialLinks.linkLabel')}
        />
        <IconButton icon={AddIcon} type="submit" label={t('preview.credentialLinks.add')} disabled={!site.trim() || !link.trim()} />
      </form>
    </div>
  );
}
