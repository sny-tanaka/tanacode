import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import { CheckIcon, ChevronDownIcon, CompressIcon, IconButton, OptimizedCompressIcon } from '../icons';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';

// 圧縮のしかた。plain: /compact をそのまま送る / optimized: Haiku に残すもの・捨てるものを選ばせてから送る（最適化圧縮）
export type CompactMode = 'plain' | 'optimized';

const MODE_KEY = 'tanacode.compactMode';
const MODES: CompactMode[] = ['plain', 'optimized'];

function loadMode(): CompactMode {
  return readSharedPref(MODE_KEY) === 'optimized' ? 'optimized' : 'plain';
}

// 選んだ圧縮のしかた（プロファイルをまたいで同じ）
export function useCompactMode(): [CompactMode, (mode: CompactMode) => void] {
  const [mode, setMode] = useState<CompactMode>(loadMode);
  useSharedPrefChange(MODE_KEY, () => setMode(loadMode()));
  const change = (next: CompactMode) => {
    setMode(next);
    writeSharedPref(MODE_KEY, next);
  };
  return [mode, change];
}

// チャットのヘッダーの「圧縮」。右の ▾ で、通常圧縮と最適化圧縮を切り替える。
// optimizing: 最適化圧縮で、Haiku が選んでいる途中 / compacting: /compact を送って、圧縮が終わるのを待っている
export function CompactButton({
  mode,
  onModeChange,
  canCompact,
  compacting,
  optimizing,
  onCompact,
}: {
  mode: CompactMode;
  onModeChange: (mode: CompactMode) => void;
  canCompact: boolean;
  compacting: boolean;
  optimizing: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (next: CompactMode) => {
    setOpen(false);
    if (next !== mode) onModeChange(next);
  };
  const name = mode === 'optimized' ? t('chat.pane.compactModeOptimized') : t('chat.pane.compact');
  const tip = optimizing ? t('chat.pane.optimizing') : mode === 'optimized' ? t('chat.pane.compactOptimizedTip') : t('chat.pane.compactTip');

  return (
    <div className="compact-button" ref={ref}>
      <IconButton size="md" icon={mode === 'optimized' ? OptimizedCompressIcon : CompressIcon} label={name} tip={tip} busy={compacting || optimizing} disabled={!canCompact} onClick={onCompact} />
      <button
        type="button"
        className="compact-mode-toggle"
        aria-label={t('chat.pane.compactMode')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : t('chat.pane.compactMode')}
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon size={12} />
      </button>
      {open && (
        <div className="compact-menu" role="menu" aria-label={t('chat.pane.compactMode')}>
          {MODES.map((m) => (
            <button key={m} role="menuitemradio" aria-checked={m === mode} className="compact-menu-item" onClick={() => pick(m)}>
              <span className="compact-menu-icon">{m === 'optimized' ? <OptimizedCompressIcon size={14} /> : <CompressIcon size={14} />}</span>
              <span className="compact-menu-text">
                <span className="compact-menu-name">{m === 'optimized' ? t('chat.pane.compactModeOptimized') : t('chat.pane.compactModePlain')}</span>
                <span className="compact-menu-desc">{m === 'optimized' ? t('chat.pane.compactModeOptimizedDesc') : t('chat.pane.compactModePlainDesc')}</span>
              </span>
              <span className="compact-menu-check">{m === mode && <CheckIcon size={12} />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
