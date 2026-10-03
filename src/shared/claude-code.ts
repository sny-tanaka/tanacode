// tanacode で動作確認済の Claude Code のバージョン。互換性の確認（npm run test:cli）が通った版にする。
// 版は低くても高くても動かない場合があるので、これと同じ版でなければステータスバーで知らせる
export const VERIFIED_CLAUDE_CODE_VERSION = '2.1.288';

// same: 動作確認済のバージョン / newer: それより新しい / older: 古い / missing: claude が見つからない・版が読めない
export type VersionMatch = 'same' | 'newer' | 'older' | 'missing';

// installed: `claude --version` の版（null なら見つからない）
export function versionMatch(installed: string | null, verified = VERIFIED_CLAUDE_CODE_VERSION): VersionMatch {
  if (!installed) return 'missing';
  const d = compareVersions(installed, verified);
  return d === 0 ? 'same' : d > 0 ? 'newer' : 'older';
}

// 2.1.286 のような版を比べる（a が新しければ正、古ければ負）
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
