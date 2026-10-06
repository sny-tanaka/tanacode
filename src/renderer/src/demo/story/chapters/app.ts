import { REPO_URL } from '@shared/app-update';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { DiscoveredSession } from '@shared/ipc';
import { ROOT } from '../../data';
import { sleep } from '../../director';
import { pastTurn, statusLine } from '../../scenarios/claude';
import type { Story } from '../story';

// 章 9「アプリのまわり」: セッションの外のこと。ターミナルで始めた会話を取り込む → tanacode の新しいバージョンの印 →
// 動作確認済の Claude Code のバージョン → CPU とメモリ → 通知のオン・オフ

const HOUR = 3600_000;

// 「既存の会話を開く…」に並ぶ、ターミナルの claude で始めた会話
export const DISCOVERED: DiscoveredSession[] = [
  { claudeSessionId: 'b7e2c4a0-5d1f-4c3e-9a8b-2f6d0e1c3a57', cwd: ROOT, title: 'メニューの画像を WebP にする', updatedAt: Date.now() - 2 * HOUR },
  { claudeSessionId: '3a9f1e62-8c4b-4d07-b5e3-71c2a9d4f018', cwd: '/Users/demo/work/cafe-blog', title: 'ブログの記事一覧にページ送りを付ける', updatedAt: Date.now() - 30 * HOUR },
];

// 動作確認済のバージョンより 1 つ新しい Claude Code（ステータスバーの印が ↑ に変わる）
function newerClaudeCode(): string {
  const parts = VERIFIED_CLAUDE_CODE_VERSION.split('.').map(Number);
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

export async function runApp(story: Story): Promise<void> {
  const { backend, d } = story;

  // 1. ターミナルで始めた会話を取り込む
  d.caption('ここからは、セッションの外の機能です。ターミナルで始めた会話は「既存の会話を開く…」で取り込めます', '.import-session-button');
  backend.onImport = (session) => {
    const id = `imported-${session.claudeSessionId.slice(0, 8)}`;
    // 本物と同じく、取り込んだあとに Claude Code が会話を読み直して画面へ送る
    backend.addSession(id, { title: session.title, updatedAt: session.updatedAt });
    backend.push(
      id,
      ...pastTurn('webp', 'メニューの画像を WebP にして、読み込みを軽くして', [['Glob', 'public/menu/*.jpg', 500], ['Bash', 'npx sharp-cli -f webp public/menu/*.jpg', 900]], '`public/menu/` の画像を WebP に変えました。合計の大きさは 1.8 MB から 420 KB になっています。', 2 * HOUR),
    );
    backend.setStatusLine(id, statusLine(9, 18_000));
    return id;
  };
  // 右の列は、エクスプローラーに戻しておく（取り込んだ会話のフォルダのファイルが並ぶ）
  const explorer = document.querySelector('.activity-bar [aria-label="エクスプローラー"]');
  if (explorer && !explorer.classList.contains('on')) await d.click(explorer, { ms: 700 });
  await d.click('.import-session-button', { ms: 900 });
  await d.find('.import-dialog .import-item');
  await sleep(1300);
  await d.click(d.byText('.import-dialog .import-item', 'WebP'), { ms: 800 });
  await sleep(1500);
  d.caption('取り込んだ会話は一覧に並び、続きから指示できます', d.byText('.session-row', 'WebP'));
  await d.moveTo(d.byText('.session-row', 'WebP'), { ms: 700 });
  await sleep(2200);

  // 2. tanacode の新しいバージョン
  d.caption('tanacode の新しいバージョンが出ると、タイトルバーのバージョンの右に青い印が出ます', '.app-update');
  backend.setAppUpdate({ latest: '0.3.0', available: true, url: `${REPO_URL}/releases/latest` });
  await sleep(1800);
  d.caption('印にマウスを乗せると、更新の手順が読めます。押すと、GitHub の Releases のページを開きます', '.app-update.available');
  await d.moveTo('.app-update.available', { ms: 900 });
  await sleep(3200);

  // 3. 動作確認済の Claude Code
  d.caption('ステータスバーには、入っている Claude Code のバージョン。tanacode で動作確認済のバージョンには、チェックが付きます', '.statusbar .claude-version');
  await d.moveTo('.statusbar .claude-version', { ms: 900 });
  await sleep(2800);
  d.caption('Claude Code が更新されて、動作確認済のバージョンと違うと、印が変わります。理由もマウスを乗せると読めます', '.statusbar .claude-version');
  await d.moveTo('.claude-header', { ms: 600 });
  backend.setClaudeVersion(newerClaudeCode());
  await sleep(1200);
  await d.moveTo('.statusbar .claude-version', { ms: 700 });
  await sleep(3200);

  // 4. CPU とメモリ
  d.caption('右下には、CPU とメモリの使用量。Claude の作業やビルドが重いときに、すぐ気づけます', d.byText('.statusbar .system-stat', 'CPU'));
  await d.moveTo(d.byText('.statusbar .system-stat', 'CPU'), { ms: 900 });
  await sleep(2400);

  // 5. 通知
  d.caption('見ていないセッションの完了や確認待ちは、macOS の通知で知らせます。タイトルバーのベルで、オン・オフを切り替えられます', '.titlebar [role="switch"]');
  await d.moveTo('.titlebar [role="switch"]', { ms: 900 });
  await sleep(2600);
  await d.click('.titlebar [role="switch"]', { ms: 300 });
  await sleep(1200);
  await d.click('.titlebar [role="switch"]', { ms: 300 });
  await sleep(1500);
}
