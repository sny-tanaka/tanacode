import { useEffect, useState } from 'react';
import { VERIFIED_CLAUDE_CODE_VERSION, versionMatch, type VersionMatch } from '@shared/claude-code';

// 入っている Claude Code の版。undefined はまだ確かめていない、null は見つからない
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

// ステータスバーの Claude Code の版（「Claude Code 待機中」などの隣に、v2.1.286 の形で出す）。
// tanacode で確かめた版と違えば、新しいときと古いときで印と色を分けて知らせる。版にも印にも、マウスを乗せると理由が出る
export function ClaudeVersion({ version }: { version: string | null | undefined }) {
  if (version === undefined) return null;
  const match = versionMatch(version);
  return (
    <span className={`claude-version ${match}`} data-tip={reason(match, version)} data-tip-side="top">
      {match !== 'same' && <AlertMark match={match} />}
      {version ? `v${version}` : 'Claude Code が見つかりません'}
    </span>
  );
}

function reason(match: VersionMatch, version: string | null): string {
  const verified = VERIFIED_CLAUDE_CODE_VERSION;
  switch (match) {
    case 'same':
      return `Claude Code ${version} は、tanacode で動作を確かめた版です`;
    case 'newer':
      return `Claude Code ${version} は、tanacode で動作を確かめた版（${verified}）より新しい版です。\n画面や会話ログの形が変わっていると、一部の表示や操作が動かない場合があります。`;
    case 'older':
      return `Claude Code ${version} は、tanacode で動作を確かめた版（${verified}）より古い版です。\ntanacode が使う機能や表示が無いと、一部の表示や操作が動かない場合があります。`;
    case 'missing':
      return `claude コマンドが見つからないか、版を読めませんでした。\nClaude Code を入れて、ターミナルで一度 claude を起動してください。`;
  }
}

// 確かめた版と違うことを示す印。新しい版は ↑、古い版は ↓、見つからないときは !
function AlertMark({ match }: { match: Exclude<VersionMatch, 'same'> }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="6.5" />
      {match === 'newer' && <path d="M8 11.5v-7M5.2 7.2 8 4.4l2.8 2.8" />}
      {match === 'older' && <path d="M8 4.5v7M5.2 8.8 8 11.6l2.8-2.8" />}
      {match === 'missing' && <path d="M8 4.6v4.2M8 11.3v.1" />}
    </svg>
  );
}
