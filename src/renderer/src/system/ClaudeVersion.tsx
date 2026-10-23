import { useEffect, useState } from 'react';
import { VERIFIED_CLAUDE_CODE_VERSION, versionMatch, type VersionMatch } from '@shared/claude-code';
import { t } from '@shared/i18n';
import { AlertCircleIcon, ArrowDownCircleIcon, ArrowUpCircleIcon, CheckCircleIcon, type IconComponent } from '../icons';

// 入っている Claude Code のバージョン。undefined はまだ確かめていない、null は見つからない
export function useClaudeVersion(): string | null | undefined {
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void window.tanacode.claudeVersion.get().then((v) => active && setVersion(v));
    const off = window.tanacode.claudeVersion.onChanged(setVersion);
    return () => {
      active = false;
      off();
    };
  }, []);
  return version;
}

// 動作確認済の Claude Code のバージョン（リポジトリの対応表の、このアプリの行。読めなければアプリに組み込んだバージョン）
export function useVerifiedClaudeVersion(): string {
  const [verified, setVerified] = useState(VERIFIED_CLAUDE_CODE_VERSION);
  useEffect(() => {
    let active = true;
    void window.tanacode.claudeVersion.getVerified().then((v) => active && setVerified(v));
    const off = window.tanacode.claudeVersion.onVerifiedChanged(setVerified);
    return () => {
      active = false;
      off();
    };
  }, []);
  return verified;
}

// ステータスバーの Claude Code のバージョン（「Claude Code 待機中」などの隣に、v2.1.286 の形で出す）。
// 動作確認済のバージョンと同じならチェックマーク、違えば新しいときと古いときで印と色を分けて知らせる。バージョンにも印にも、マウスを乗せると理由が出る
export function ClaudeVersion({ version, verified = VERIFIED_CLAUDE_CODE_VERSION }: { version: string | null | undefined; verified?: string }) {
  if (version === undefined) return null;
  const match = versionMatch(version, verified);
  const Mark = MARKS[match];
  return (
    <span className={`claude-version ${match}`} data-tip={reason(match, version, verified)} data-tip-side="top">
      <Mark size={12} />
      {version ? `v${version}` : t('app.claudeVersion.notFound')}
    </span>
  );
}

function reason(match: VersionMatch, version: string | null, verified: string): string {
  switch (match) {
    case 'same':
      return t('app.claudeVersion.same', { version: version ?? '' });
    case 'newer':
      return t('app.claudeVersion.newer', { version: version ?? '', verified });
    case 'older':
      return t('app.claudeVersion.older', { version: version ?? '', verified });
    case 'missing':
      return t('app.claudeVersion.missing');
  }
}

// 動作確認済のバージョンと比べた印。同じならチェックマーク、新しいときは ↑、古いときは ↓、見つからないときは !（どれも丸で囲む）
const MARKS: Record<VersionMatch, IconComponent> = {
  same: CheckCircleIcon,
  newer: ArrowUpCircleIcon,
  older: ArrowDownCircleIcon,
  missing: AlertCircleIcon,
};
