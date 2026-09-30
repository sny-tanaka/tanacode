import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { SlashCommand } from '@shared/ipc';

// Claude Code の組み込みコマンド（v2.1.283 の / メニューから）。[名前, 説明, 別名]。
// /model・/effort・/config などは既定値を書き換えるので、アプリの画面（モデル・エフォートの切り替え）を使う前提で説明に書いておく
const BUILTIN: [string, string, string[]?][] = [
  ['add-dir', '作業フォルダを追加する'],
  ['advisor', '要所でより強いモデルに相談させる'],
  ['artifacts', '公開・共有した Artifact を見る'],
  ['auto-mode-setup', 'auto モードに環境を教える'],
  ['autocompact', '自動圧縮するコンテキストの量を設定'],
  ['autofix-pr', '今の PR の問題を見張って自動で直す'],
  ['background', 'このセッションをバックグラウンドに回す'],
  ['branch', 'この時点から会話を分岐する'],
  ['btw', '作業を止めずにちょっと質問する'],
  ['bug', '不具合を報告する'],
  ['cd', '作業フォルダを移す'],
  ['chrome', 'Claude in Chrome の設定'],
  ['clear', '会話をリセットして新しく始める'],
  ['color', '入力欄の色を設定'],
  ['compact', '会話を要約してコンテキストを空ける'],
  ['config', '設定を開く（ターミナルで操作）'],
  ['context', 'コンテキストの使用量を表示'],
  ['copy', '直前の返事をクリップボードにコピー'],
  ['design', 'Design プロジェクトへのアクセスを設定'],
  ['design-login', 'デザインシステムへのアクセスを認可'],
  ['desktop', 'Claude Desktop で続ける'],
  ['diff', '未コミットの変更とターンごとの差分を見る'],
  ['effort', 'エフォートを変える（既定値も変わる。下の欄推奨）'],
  ['exit', 'Claude Code を終了'],
  ['export', '会話をファイルやクリップボードに書き出す'],
  ['fast', '高速モードの切り替え'],
  ['feedback', 'Anthropic にフィードバックを送る'],
  ['focus', '発言・要約・返事だけの表示に切り替え'],
  ['fork', 'この会話を別のバックグラウンドセッションに複製'],
  ['goal', '終える前に確かめるゴールを設定'],
  ['help', 'ヘルプとコマンド一覧'],
  ['hooks', 'フックの設定を見る'],
  ['ide', 'IDE 連携の管理'],
  ['import', 'ほかのコーディングエージェントの設定を取り込む'],
  ['import-memory', 'ほかの AI アシスタントのメモリを取り込む'],
  ['install-github-app', 'GitHub Actions を設定'],
  ['install-slack-app', 'Slack アプリを入れる'],
  ['keybindings', 'キーボードショートカットの設定を開く'],
  ['list-agents', 'メッセージを送れるサブエージェント・セッションの一覧'],
  ['login', 'Anthropic アカウントでログイン'],
  ['logout', 'ログアウト'],
  ['mcp', 'MCP サーバーの管理'],
  ['memory', 'CLAUDE.md とメモリの編集'],
  ['mobile', 'モバイルアプリの QR コードを表示'],
  ['morning', '朝のまとめを作る・設定する'],
  ['model', 'モデルを変える（既定値も変わる。下のモデル欄推奨）'],
  ['output-style', '出力スタイルの一覧・切り替え'],
  ['passes', 'Claude Code の無料体験を友達に共有'],
  ['permissions', '権限ルールの管理'],
  ['plan', 'プランモードにする・今の計画を見る'],
  ['plugin', 'プラグインの管理'],
  ['powerup', '機能を短いレッスンで知る'],
  ['privacy-settings', 'プライバシー設定'],
  ['radio', 'Claude FM を聴く'],
  ['recap', 'セッションの一行まとめを作る'],
  ['release-notes', 'リリースノート'],
  ['reload-plugins', 'プラグインの変更を読み込む'],
  ['reload-skills', 'スキルの追加・変更を読み込む'],
  ['remote-control', 'スマホや claude.ai/code から操作'],
  ['remote-env', 'クラウドエージェントの既定の環境を選ぶ'],
  ['rename', '会話の名前を変える'],
  ['resume', '過去の会話を再開'],
  ['rewind', '会話やコードを以前の時点に戻す', ['checkpoint']],
  ['run', 'このプロジェクトのアプリを起動して変更を確かめる'],
  ['sandbox', 'サンドボックスの設定'],
  ['scroll-speed', 'スクロールの速さを調整'],
  ['skill-doctor', '使われずにコンテキストを使っているスキルを調べる'],
  ['skills', '使えるスキルの一覧'],
  ['slides', 'スライドを作る'],
  ['status', 'バージョン・モデル・アカウントなどの状態'],
  ['stickers', 'ステッカーを注文'],
  ['subtask', '今の文脈ごとサブエージェントに任せる'],
  ['tasks', 'バックグラウンドで動いているものを見る'],
  ['teleport', 'クラウドに送る・claude.ai から再開する'],
  ['terminal-setup', 'Shift+Enter の改行を設定'],
  ['theme', 'テーマを変える'],
  ['tui', 'ターミナル UI の描画方式を設定'],
  ['ultrareview', 'クラウドでバグを探して検証する'],
  ['upgrade', 'プランをアップグレード'],
  ['usage', '使用量・プランの状況'],
  ['usage-credits', '利用クレジットの設定'],
  ['voice', '音声モードの切り替え'],
  ['web-setup', 'Web 版の Claude Code を設定'],
  ['workflows', 'ワークフローの一覧'],
  ['batch', '大きな変更を調べて計画し、並列で実行'],
  ['code-review', '今の差分や PR をレビュー'],
  ['debug', 'デバッグログを有効にして問題を調べる'],
  ['doctor', 'インストールの診断と修正', ['checkup']],
  ['fewer-permission-prompts', '許可の確認を減らす設定を提案'],
  ['init', 'CLAUDE.md を作る'],
  ['insights', 'セッションの分析レポートを作る'],
  ['loop', 'プロンプトやコマンドを一定間隔で繰り返す'],
  ['schedule', 'クラウドエージェントの予約実行'],
  ['security-review', '今の変更のセキュリティレビュー'],
  ['simplify', '変更したコードの重複・簡素化・効率を見直す'],
  ['statusline', 'ステータスラインを設定'],
  ['team-onboarding', 'チーム向けの導入ガイドを作る'],
  ['verify', '変更が本当に意図どおり動くか確かめる'],
];

// 会話ログの skill_listing は最初の発言のあとに書かれる。新しいセッションでは同じフォルダの新しい会話ログから借りる
const BORROW_FROM_LOGS = 3;

// / で始まる入力の補完候補: カスタムコマンド（.claude/commands）・スキル・組み込みコマンド。
// スキルは Claude Code が会話ログに書く一覧（skill_listing）に、組み込み・プラグインのものも含めて載っている。
// まだ会話が無ければ、同じフォルダの前の会話とフォルダ（.claude/skills）から探す
export async function listCommands(cwd: string, transcript: string | null): Promise<SlashCommand[]> {
  const home = homedir();
  let listed = transcript ? await skillsFromTranscript(transcript) : [];
  if (listed.length === 0) listed = await skillsFromProjectLogs(cwd);
  const custom = [
    ...(await commandsIn(join(cwd, '.claude', 'commands'), 'project')),
    ...(await commandsIn(join(home, '.claude', 'commands'), 'user')),
    ...(await skillsIn(join(cwd, '.claude', 'skills'), 'project')),
    ...(await skillsIn(join(home, '.claude', 'skills'), 'user')),
    ...listed,
  ];
  const seen = new Set<string>();
  const builtin = BUILTIN.map(([name, description, aliases]) => ({ name, description, aliases, source: 'builtin' as const }));
  return [...custom, ...builtin].filter((c) => !seen.has(c.name) && !!seen.add(c.name));
}

// 会話ログの最後の skill_listing（「- 名前: 説明」の行が並ぶ）
async function skillsFromTranscript(file: string): Promise<SlashCommand[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const at = text.lastIndexOf('"type":"skill_listing"');
  if (at === -1) return [];
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  try {
    const entry = JSON.parse(text.slice(start, end === -1 ? undefined : end)) as { attachment?: { content?: unknown } };
    const content = entry.attachment?.content;
    if (typeof content !== 'string') return [];
    return content
      .split('\n')
      .map((line) => line.match(/^- ([^:\s]+(?::[^:\s]+)?): ?(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ name: m[1], description: m[2], source: 'skill' as const }));
  } catch {
    return [];
  }
}

async function skillsFromProjectLogs(cwd: string): Promise<SlashCommand[]> {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl'));
  const files = await Promise.all(names.map(async (n) => ({ file: join(dir, n), at: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const { file } of files.sort((a, b) => b.at - a.at).slice(0, BORROW_FROM_LOGS)) {
    const skills = await skillsFromTranscript(file);
    if (skills.length > 0) return skills;
  }
  return [];
}

async function commandsIn(dir: string, source: SlashCommand['source']): Promise<SlashCommand[]> {
  const files = await walk(dir, (name) => name.endsWith('.md'));
  return Promise.all(
    files.map(async (file) => {
      // サブフォルダは「フォルダ:名前」になる
      const name = relative(dir, file).replace(/\.md$/, '').split('/').join(':');
      const text = await readFile(file, 'utf8').catch(() => '');
      return { name, description: frontmatter(text, 'description') ?? firstLine(text), source };
    }),
  );
}

async function skillsIn(dir: string, source: SlashCommand['source']): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map(async (e) => {
        const text = await readFile(join(dir, e.name, 'SKILL.md'), 'utf8').catch(() => null);
        if (text === null) return null;
        return { name: frontmatter(text, 'name') ?? e.name, description: frontmatter(text, 'description') ?? '', source };
      }),
  );
  return skills.filter((s): s is SlashCommand => s !== null);
}

async function walk(dir: string, match: (name: string) => boolean, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(path, match, depth + 1)));
    else if (match(e.name)) out.push(path);
  }
  return out;
}

function frontmatter(text: string, key: string): string | null {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const value = block?.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  return value ? value.replace(/^(['"])(.*)\1$/, '$2') : null;
}

function firstLine(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim().split('\n')[0]?.slice(0, 100) ?? '';
}
