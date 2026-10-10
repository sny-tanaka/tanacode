import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { t, type MessageKey } from '@shared/i18n';
import type { SlashCommand } from '@shared/ipc';
import { claudeConfigDir, projectLogDir } from './claude-config';

// 説明の文言がある組み込みコマンドの名前（文言は commands.builtin.<名前>）
type BuiltinName = MessageKey extends infer K ? (K extends `commands.builtin.${infer N}` ? N : never) : never;

// Claude Code の組み込みコマンド（v2.1.283 の / メニューから）。[名前, 別名]。説明は文言（commands.builtin.<名前>）にある。
// /model・/effort・/config などは既定値を書き換えるので、アプリの画面（モデル・エフォートの切り替え）を使う前提で説明に書いておく
const BUILTIN: [BuiltinName, string[]?][] = [
  ['add-dir'],
  ['advisor'],
  ['artifacts'],
  ['auto-mode-setup'],
  ['autocompact'],
  ['autofix-pr'],
  ['background'],
  ['branch'],
  ['btw'],
  ['bug'],
  ['cd'],
  ['chrome'],
  ['clear'],
  ['color'],
  ['compact'],
  ['config'],
  ['context'],
  ['copy'],
  ['design'],
  ['design-login'],
  ['desktop'],
  ['diff'],
  ['effort'],
  ['exit'],
  ['export'],
  ['fast'],
  ['feedback'],
  ['focus'],
  ['fork'],
  ['goal'],
  ['help'],
  ['hooks'],
  ['ide'],
  ['import'],
  ['import-memory'],
  ['install-github-app'],
  ['install-slack-app'],
  ['keybindings'],
  ['list-agents'],
  ['login'],
  ['logout'],
  ['mcp'],
  ['memory'],
  ['mobile'],
  ['morning'],
  ['model'],
  ['output-style'],
  ['passes'],
  ['permissions'],
  ['plan'],
  ['plugin'],
  ['powerup'],
  ['privacy-settings'],
  ['radio'],
  ['recap'],
  ['release-notes'],
  ['reload-plugins'],
  ['reload-skills'],
  ['remote-control'],
  ['remote-env'],
  ['rename'],
  ['resume'],
  ['rewind', ['checkpoint']],
  ['run'],
  ['sandbox'],
  ['scroll-speed'],
  ['skill-doctor'],
  ['skills'],
  ['slides'],
  ['status'],
  ['stickers'],
  ['subtask'],
  ['tasks'],
  ['teleport'],
  ['terminal-setup'],
  ['theme'],
  ['tui'],
  ['ultrareview'],
  ['upgrade'],
  ['usage'],
  ['usage-credits'],
  ['voice'],
  ['web-setup'],
  ['workflows'],
  ['batch'],
  ['code-review'],
  ['debug'],
  ['doctor', ['checkup']],
  ['fewer-permission-prompts'],
  ['init'],
  ['insights'],
  ['loop'],
  ['schedule'],
  ['security-review'],
  ['simplify'],
  ['statusline'],
  ['team-onboarding'],
  ['verify'],
];

// 会話ログの skill_listing は最初の発言のあとに書かれる。新しいセッションでは同じフォルダの新しい会話ログから借りる
const BORROW_FROM_LOGS = 3;

// / で始まる入力の補完候補: カスタムコマンド（.claude/commands）・スキル・組み込みコマンド。
// スキルは Claude Code が会話ログに書く一覧（skill_listing）に、組み込み・プラグインのものも含めて載っている。
// まだ会話が無ければ、同じフォルダの前の会話とフォルダ（.claude/skills）から探す
// claudeDir: プロファイルの Claude Code の設定のフォルダ（null は既定のプロファイル）
export async function listCommands(cwd: string, transcript: string | null, claudeDir: string | null = null): Promise<SlashCommand[]> {
  const config = claudeConfigDir(claudeDir);
  let listed = transcript ? await skillsFromTranscript(transcript) : [];
  if (listed.length === 0) listed = await skillsFromProjectLogs(cwd, claudeDir);
  const custom = [
    ...(await commandsIn(join(cwd, '.claude', 'commands'), 'project')),
    ...(await commandsIn(join(config, 'commands'), 'user')),
    ...(await skillsIn(join(cwd, '.claude', 'skills'), 'project')),
    ...(await skillsIn(join(config, 'skills'), 'user')),
    ...listed,
  ];
  const seen = new Set<string>();
  const builtin = BUILTIN.map(([name, aliases]) => ({ name, description: t(`commands.builtin.${name}`), aliases, source: 'builtin' as const }));
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

async function skillsFromProjectLogs(cwd: string, claudeDir: string | null): Promise<SlashCommand[]> {
  const dir = projectLogDir(cwd, claudeDir);
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
