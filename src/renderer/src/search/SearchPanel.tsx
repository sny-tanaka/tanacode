import { forwardRef, useEffect, useState } from 'react';
import type { SearchResult } from '@shared/ipc';

type Props = { sessionId: string; onOpen: (path: string, line: number) => void };

// ⌘⇧F: ワークスペースの全文検索
export const SearchPanel = forwardRef<HTMLInputElement, Props>(function SearchPanel({ sessionId, onOpen }, inputRef) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query) {
      setResult(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      void window.tanacode.workspace.search(sessionId, query, { caseSensitive, regex }).then((r) => {
        if (cancelled) return;
        setResult(r);
        setSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, query, caseSensitive, regex]);

  const count = result?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0;
  return (
    <div className="search-panel">
      <div className="search-box">
        <input ref={inputRef} value={query} placeholder="検索" onChange={(e) => setQuery(e.target.value)} />
        <button className={`search-flag${caseSensitive ? ' on' : ''}`} onClick={() => setCaseSensitive((v) => !v)} data-tip="大文字と小文字を区別" aria-label="大文字と小文字を区別" aria-pressed={caseSensitive}>
          Aa
        </button>
        <button className={`search-flag${regex ? ' on' : ''}`} onClick={() => setRegex((v) => !v)} data-tip="正規表現" aria-label="正規表現" aria-pressed={regex}>
          .*
        </button>
      </div>
      <div className="search-summary">
        {result?.error ??
          (searching ? '検索中…' : result ? `${result.files.length} ファイル · ${count} 件${result.truncated ? '（多すぎるため省略）' : ''}` : '')}
      </div>
      <div className="search-results">
        {result?.files.map((file) => (
          <div key={file.path} className="search-file">
            <div className="search-file-name" title={file.path}>
              {file.path.split('/').pop()}
              <span className="search-file-dir">{file.path.split('/').slice(0, -1).join('/')}</span>
              <span className="search-file-count">{file.matches.length}</span>
            </div>
            {file.matches.map((m) => (
              <button key={`${m.line}:${m.column}`} className="search-match" onClick={() => onOpen(file.path, m.line)}>
                <span className="search-line">{m.line}</span>
                <span className="search-text">
                  {m.text.slice(0, m.matchStart).trimStart()}
                  <mark>{m.text.slice(m.matchStart, m.matchStart + m.matchLength)}</mark>
                  {m.text.slice(m.matchStart + m.matchLength)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});
