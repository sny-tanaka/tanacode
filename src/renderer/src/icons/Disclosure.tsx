import { ChevronRightIcon, type IconSize } from './icons';

// 展開・折りたたみの矢印。閉じているときは右向きで、開くと下向きに回る（文字の ▸▾ を入れ替えない）
export function DisclosureIcon({ open, size = 12 }: { open: boolean; size?: IconSize }) {
  return (
    <span className={`disclosure${open ? ' open' : ''}`}>
      <ChevronRightIcon size={size} />
    </span>
  );
}
