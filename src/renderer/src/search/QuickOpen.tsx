import { useEffect, useMemo, useRef, useState } from 'react';

const MAX_RESULTS = 60;

type Props = { sessionId: string; onOpen: (path: string) => void; onClose: () => void };

// ⌘P: ファイル名で探して開く。文字が順番どおりに含まれていれば候補にし、ファイル名に近いものを上に出す
export function QuickOpen({ sessionId, onOpen, onClose }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.tanacode.workspace.listFiles(sessionId).then(setFiles);
  }, [sessionId]);

  const results = useMemo(() => {
    const q = query.toLowerCase().replace(/\s+/g, '');
    if (!q) return files.slice(0, MAX_RESULTS);
    return files
      .map((path) => ({ path, score: fuzzyScore(path.toLowerCase(), q) }))
      .filter((r) => r.score !== null)
      .sort((a, b) => a.score! - b.score! || a.path.length - b.path.length)
      .slice(0, MAX_RESULTS)
      .map((r) => r.path);
  }, [files, query]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="ファイル名で探す"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setSelected((i) => Math.max(0, Math.min(results.length - 1, i + step)));
            } else if (e.key === 'Enter' && results[selected]) {
              onOpen(results[selected]);
              onClose();
            }
          }}
        />
        <div className="quick-open-list" ref={listRef}>
          {results.map((path, i) => (
            <button
              key={path}
              className={`quick-open-item${i === selected ? ' selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                onOpen(path);
                onClose();
              }}
            >
              <span className="quick-open-name">{path.split('/').pop()}</span>
              <span className="quick-open-dir">{path.split('/').slice(0, -1).join('/')}</span>
            </button>
          ))}
          {results.length === 0 && <div className="quick-open-empty">見つかりません</div>}
        </div>
      </div>
    </div>
  );
}

// q の文字が path に順番どおり含まれていればスコア（小さいほど良い）。ファイル名の中で一致するほど、まとまって一致するほど良い
function fuzzyScore(path: string, q: string): number | null {
  const nameStart = path.lastIndexOf('/') + 1;
  const inName = path.slice(nameStart).indexOf(q);
  if (inName !== -1) return inName;
  let score = 100;
  let pos = 0;
  let prev = -2;
  for (const ch of q) {
    const i = path.indexOf(ch, pos);
    if (i === -1) return null;
    score += i === prev + 1 ? 0 : i < nameStart ? 3 : 1;
    prev = i;
    pos = i + 1;
  }
  return score;
}
