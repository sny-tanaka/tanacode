import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { visibleOrganization, type ClaudeAccount } from '@shared/account';
import { locale, t } from '@shared/i18n';
import type { UsageLimit, UsageLimits } from '@shared/usage';
import { openSettingsFilesDialog } from '../chat/settingsFiles';
import { CheckIcon } from '../icons';
import { runInTerminal } from '../terminal/runInTerminal';
import { openProfilesDialog, useProfiles } from './profiles';

// これより古い値は、いつの値かを添えて出す
const STALE_MS = 30 * 60_000;
// いつも出す利用枠。値が無くても灰色の 0% で場所を取っておき、この 2 つの行は増減させない（ゲージが上下しないように）。
// モデル別の週の枠の行は、その下に、プランにあるモデルの分だけ出す（増え・消える）。
// label は main が付ける利用枠の名前（UsageLimit.label）で、どの枠かを見分ける値として比べる。画面に出す名前は name のキーで読む
const LIMITS = [
  { label: '5時間', name: 'fiveHour' },
  { label: '週', name: 'week' },
] as const;
// マウスを乗せたときの説明の、利用枠の出どころ
const USAGE_SOURCES = {
  statusline: 'account.panel.usageFromStatusline',
  usage: 'account.panel.usageFromUsage',
  'claude-cache': 'account.panel.usageFromCache',
} as const satisfies Record<UsageLimits['source'], string>;
// 応答のたびに届く利用枠をきっかけにアカウントを読み直すのは、この間隔に 1 回まで（~/.claude.json は大きくなることがあるため）
const ACCOUNT_REREAD_MS = 60_000;

// セッション一覧の最下部に出す、Claude Code にログインしているアカウントと、そのプランの利用枠（5 時間枠・週の枠）。
// 利用枠はアプリのセッションが応答するたびに更新される。アカウント（~/.claude.json）は、応答があったとき（1 分に 1 回まで）・アプリに戻ったとき・メニューを開いたときに読み直す。
// メールアドレスは画面共有などに写らないよう、マウスを乗せたときとメニューの中にだけ出す。押すとメニューを開く。
// プロファイル（アカウントごとの環境）が 2 つ以上あれば、名前の前の色の点・欄の背景の色・ほかのアカウントの通知の点・メニューの切り替えも出す
export function AccountPanel() {
  const profiles = useProfiles();
  const [usage, setUsage] = useState<UsageLimits | null>(null);
  // undefined は、まだ読んでいない（そのあいだは名前の行を空けておく）。null は、ログインしていない
  const [account, setAccount] = useState<ClaudeAccount | null | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  // 最後にアカウントを読んだ時刻
  const readAt = useRef(0);

  const readAccount = () => {
    readAt.current = Date.now();
    void window.tanacode.account.get().then((a) => setAccount(a ?? null));
  };
  useEffect(() => {
    void window.tanacode.usage.get().then((u) => u && setUsage(u));
    readAccount();
    const off = window.tanacode.usage.onChanged((u) => {
      setUsage(u);
      if (Date.now() - readAt.current >= ACCOUNT_REREAD_MS) readAccount();
    });
    window.addEventListener('focus', readAccount);
    // ターミナルで claude auth login を終えたら読み直す
    const offShell = window.tanacode.shell.onExit(() => readAccount());
    return () => {
      off();
      offShell();
      window.removeEventListener('focus', readAccount);
    };
  }, []);
  // リセットまでの残り時間を進める
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // 欄と同じ幅で、欄のすぐ上に開く（セッション一覧の最下部なので、下には空きが無い）
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPosition({ left: rect.left + 6, width: rect.width - 12, bottom: window.innerHeight - rect.top + 4 });
  }, [open]);

  const toggle = () => {
    setNow(Date.now());
    if (!open) readAccount();
    setOpen(!open);
  };
  const reload = () => {
    setOpen(false);
    setNow(Date.now());
    readAccount();
    void window.tanacode.usage.refresh();
  };
  const manageSettingsFiles = () => {
    setOpen(false);
    openSettingsFilesDialog();
  };
  const manageProfiles = (mode: 'manage' | 'add') => {
    setOpen(false);
    openProfilesDialog(mode);
  };
  const switchTo = (id: string) => {
    setOpen(false);
    void window.tanacode.profiles.switch(id);
  };
  // このプロファイルの Claude Code の設定のフォルダで、今見ているもののターミナルから claude auth login を動かす
  const login = () => {
    setOpen(false);
    if (!runInTerminal(null, 'claude auth login')) {
      window.alert(t('account.panel.noTerminal'));
    }
  };

  const list = profiles?.profiles ?? [];
  const multiple = list.length > 1;
  const current = list.find((p) => p.id === profiles?.current) ?? null;
  const attention = multiple && !!profiles?.othersAttention;

  const at = usage ? timeOf(usage.updatedAt) : '';
  const stale = usage !== null && now - usage.updatedAt > STALE_MS;
  const organization = account ? visibleOrganization(account) : null;
  const tip = [
    multiple && current ? t('account.panel.profile', { name: current.name }) : null,
    account ? account.email : account === null ? t('account.panel.notLoggedIn') : null,
    usage ? t(USAGE_SOURCES[usage.source], { time: at }) : t('account.panel.usagePending'),
  ]
    .filter(Boolean)
    .join('\n');
  const plan = account === undefined ? '' : account ? (account.plan ?? 'Claude') : t('account.panel.notLoggedIn');

  return (
    <div
      className={`account-panel${multiple && current ? ' tinted' : ''}`}
      ref={ref}
      style={multiple && current ? ({ '--profile-color': current.color } as CSSProperties) : undefined}
    >
      <button className="account-summary" aria-haspopup="menu" aria-expanded={open} title={open ? undefined : tip} onClick={toggle}>
        <div className="account-row">
          {multiple && current ? (
            <>
              <span className="profile-dot" style={{ background: current.color }} />
              <span className="account-name">{current.name}</span>
              <span className={`account-org${account === null ? ' none' : ''}`}>{[plan, organization].filter(Boolean).join(' · ')}</span>
            </>
          ) : (
            <>
              <span className={`account-name${account === null ? ' none' : ''}`}>{plan}</span>
              {organization && <span className="account-org">{organization}</span>}
            </>
          )}
          {stale && <span className="account-stale">{t('account.panel.staleAt', { time: at })}</span>}
          {attention && (
            <span className="account-attention" role="img" aria-label={t('account.panel.othersAttention')} title={t('account.panel.othersAttention')} />
          )}
        </div>
        {LIMITS.map(({ label, name }) => (
          <Gauge key={label} label={t(`account.usage.${name}`)} limit={usage?.limits.find((l) => l.label === label && !l.model) ?? null} now={now} />
        ))}
        {/* モデル別の週の枠（プランにあれば）。モデルの一覧が届いたら、そこに無いモデルの行は消える。一覧の無い知らせでは前の値を残す */}
        {usage?.limits
          .filter((l) => l.model)
          .map((l) => <Gauge key={`model:${l.model}`} label={t('account.usage.weekModel', { model: l.model! })} limit={l} now={now} />)}
      </button>
      {open && (
        <div className="account-menu" style={position} role="menu" aria-label={t('account.panel.menu')}>
          <div className="account-menu-heading">
            {account ? (
              <>
                <span className="account-menu-email">{account.email}</span>
                {(account.plan || organization) && (
                  <span className="account-menu-detail">{[account.plan, organization].filter(Boolean).join(' · ')}</span>
                )}
              </>
            ) : (
              <>
                <span className="account-menu-email">{t('account.panel.notLoggedIn')}</span>
                <span className="account-menu-detail">{t('account.panel.loginHint')}</span>
              </>
            )}
          </div>
          {multiple && (
            <>
              <div className="account-menu-sep" />
              {list.map((p) => (
                <button
                  key={p.id}
                  role="menuitemradio"
                  aria-checked={p.id === profiles?.current}
                  className="account-menu-item account-menu-profile"
                  onClick={() => (p.id === profiles?.current ? setOpen(false) : switchTo(p.id))}
                >
                  <span className="profile-dot" style={{ background: p.color }} />
                  <span className="account-menu-profile-name">{p.name}</span>
                  {p.id === profiles?.current && (
                    <span className="account-menu-check">
                      <CheckIcon size={12} />
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          <div className="account-menu-sep" />
          <button role="menuitem" className="account-menu-item" onClick={reload}>
            {t('account.panel.reload')}
          </button>
          <button role="menuitem" className="account-menu-item" onClick={login}>
            {account ? t('account.panel.relogin') : t('account.panel.login')}
          </button>
          <button role="menuitem" className="account-menu-item" onClick={manageSettingsFiles}>
            {t('account.panel.manageSettingsFiles')}
          </button>
          <div className="account-menu-sep" />
          <button role="menuitem" className="account-menu-item" onClick={() => manageProfiles('add')}>
            {t('account.panel.addProfile')}
          </button>
          {multiple && (
            <button role="menuitem" className="account-menu-item" onClick={() => manageProfiles('manage')}>
              {t('account.panel.manageProfiles')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// limit が null なら、まだ値が無い（灰色の 0% と「未取得」）
function Gauge({ label, limit, now }: { label: string; limit: UsageLimit | null; now: number }) {
  if (!limit) {
    return (
      <div className="usage-gauge unknown">
        <div className="usage-row">
          <span className="usage-label">{label}</span>
          <span className="usage-percent">0%</span>
          <span className="usage-reset">{t('account.usage.unknown')}</span>
        </div>
        <div className="usage-bar">
          <span style={{ width: 0 }} />
        </div>
      </div>
    );
  }
  // リセット時刻を過ぎていれば、まだ使っていない（新しい値が届くまで 0% とする）
  const reset = limit.resetsAt !== null && limit.resetsAt <= now;
  const percent = reset ? 0 : limit.percent;
  const level = percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low';
  // 前の値から残した枠（新しい知らせに無かったもの）が古ければ、残り時間の代わりに何時点の値かを出す（欄の幅に両方は入らない）
  const stale = limit.updatedAt !== undefined && now - limit.updatedAt > STALE_MS;
  const detail = reset ? t('account.usage.reset') : stale ? t('account.panel.staleAt', { time: timeOf(limit.updatedAt!) }) : remaining(limit.resetsAt, now);
  return (
    <div className={`usage-gauge ${level}`}>
      <div className="usage-row">
        <span className="usage-label">{label}</span>
        <span className="usage-percent">{percent}%</span>
        <span className="usage-reset">{detail}</span>
      </div>
      <div className="usage-bar">
        <span style={{ width: `${reset ? 0 : Math.min(100, Math.max(percent, 1))}%` }} />
      </div>
    </div>
  );
}

// 値を得た時刻（「10/7 9:20」）
function timeOf(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// 「あと 2時間13分」「あと 4日18時間」
function remaining(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '';
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 60) return t('account.usage.remainingMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('account.usage.remainingHours', { hours, minutes: minutes % 60 });
  return t('account.usage.remainingDays', { days: Math.floor(hours / 24), hours: hours % 24 });
}
