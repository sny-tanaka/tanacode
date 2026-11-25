import { t } from '@shared/i18n';

// スマホの配置の下のタブ（Issue #464）。選んでいるセッションの中を切り替える（Mac の画面の 2〜4 列目とターミナル）
export type MobileTab = 'chat' | 'panel' | 'editor' | 'terminal';

const TABS: MobileTab[] = ['chat', 'panel', 'editor', 'terminal'];

export function MobileTabs({ tab, onChange }: { tab: MobileTab; onChange: (tab: MobileTab) => void }) {
  return (
    <nav className="mobile-tabs" role="tablist">
      {TABS.map((id) => (
        <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => onChange(id)}>
          {t(`mobile.tab.${id}`)}
        </button>
      ))}
    </nav>
  );
}

// ほかのセッションが答えを待っている（チャットのタブで、下に出す。押すと、いちばん前から待っているセッションへ移る）
export function MobileWaiting({ count, onShow }: { count: number; onShow: () => void }) {
  if (count === 0) return null;
  return (
    <button className="mobile-waiting" onClick={onShow}>
      {t('mobile.waiting', { count })}
    </button>
  );
}
