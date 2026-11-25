import { t } from '@shared/i18n';
import { ChatIcon, CodeIcon, ColumnsIcon, GlobeIcon, TerminalIcon, type IconComponent } from '../icons';

// スマホの配置の下のタブ（Issue #464）。選んでいるセッションの中を切り替える（Mac の画面の 2〜4 列目と、真ん中の列のブラウザ・ターミナル）
export type MobileTab = 'chat' | 'panel' | 'editor' | 'browser' | 'terminal';

const TABS: { id: MobileTab; icon: IconComponent }[] = [
  { id: 'chat', icon: ChatIcon },
  { id: 'panel', icon: ColumnsIcon },
  { id: 'editor', icon: CodeIcon },
  { id: 'browser', icon: GlobeIcon },
  { id: 'terminal', icon: TerminalIcon },
];

export function MobileTabs({ tab, onChange }: { tab: MobileTab; onChange: (tab: MobileTab) => void }) {
  return (
    <nav className="mobile-tabs" role="tablist">
      {TABS.map(({ id, icon: Icon }) => (
        <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => onChange(id)}>
          <Icon size={22} />
          <span>{t(`mobile.tab.${id}`)}</span>
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
