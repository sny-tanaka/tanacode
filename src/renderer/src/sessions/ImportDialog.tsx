import { useEffect, useMemo, useState } from 'react';
import { locale, t } from '@shared/i18n';
import type { DiscoveredSession } from '@shared/ipc';

type Props = { onImport: (session: DiscoveredSession) => void; onClose: () => void };

// アプリの外（ターミナルの claude など）で作られた会話を選んで取り込む
export function ImportDialog({ onImport, onClose }: Props) {
  const [sessions, setSessions] = useState<DiscoveredSession[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void window.tanacode.sessions.discover().then(setSessions);
  }, []);

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return (sessions ?? []).filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }, [sessions, query]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="quick-open import-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder={t('sessions.import.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <div className="quick-open-list">
          {sessions === null && <div className="quick-open-empty">{t('sessions.import.searching')}</div>}
          {sessions !== null && shown.length === 0 && <div className="quick-open-empty">{t('sessions.import.empty')}</div>}
          {shown.map((s) => (
            <button
              key={s.claudeSessionId}
              className="quick-open-item import-item"
              onClick={() => {
                onImport(s);
                onClose();
              }}
            >
              <span className="import-title">{s.title}</span>
              <span className="import-meta">
                {s.cwd.replace(/^\/Users\/[^/]+/, '~')} · {new Date(s.updatedAt).toLocaleString(locale())}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
