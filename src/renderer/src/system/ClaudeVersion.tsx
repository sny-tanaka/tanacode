import { useEffect, useState } from 'react';
import { VERIFIED_CLAUDE_CODE_VERSION, versionMatch, type VersionMatch } from '@shared/claude-code';
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

// ステータスバーの Claude Code のバージョン（「Claude Code 待機中」などの隣に、v2.1.286 の形で出す）。
// 動作確認済のバージョンと同じならチェックマーク、違えば新しいときと古いときで印と色を分けて知らせる。バージョンにも印にも、マウスを乗せると理由が出る
export function ClaudeVersion({ version }: { version: string | null | undefined }) {
  if (version === undefined) return null;
  const match = versionMatch(version);
  const Mark = MARKS[match];
  return (
    <span className={`claude-version ${match}`} data-tip={reason(match, version)} data-tip-side="top">
      <Mark size={12} />
      {version ? `v${version}` : 'Claude Code が見つかりません'}
    </span>
  );
}

function reason(match: VersionMatch, version: string | null): string {
  const verified = VERIFIED_CLAUDE_CODE_VERSION;
  switch (match) {
    case 'same':
      return `Claude Code ${version} は、tanacode で動作確認済のバージョンです`;
    case 'newer':
      return `Claude Code ${version} は、tanacode で動作確認済のバージョン（${verified}）より新しいバージョンです。\n画面や会話ログの形が変わっていると、一部の表示や操作が動かない場合があります。`;
    case 'older':
      return `Claude Code ${version} は、tanacode で動作確認済のバージョン（${verified}）より古いバージョンです。\ntanacode が使う機能や表示が無いと、一部の表示や操作が動かない場合があります。`;
    case 'missing':
      return `claude コマンドが見つからないか、バージョンを読めませんでした。\nClaude Code を入れて、ターミナルで一度 claude を起動してください。`;
  }
}

// 動作確認済のバージョンと比べた印。同じならチェックマーク、新しいときは ↑、古いときは ↓、見つからないときは !（どれも丸で囲む）
const MARKS: Record<VersionMatch, IconComponent> = {
  same: CheckCircleIcon,
  newer: ArrowUpCircleIcon,
  older: ArrowDownCircleIcon,
  missing: AlertCircleIcon,
};
