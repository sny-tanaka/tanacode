import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelCatalog, ModelChoice } from '@shared/models';

// Claude Code が /model の一覧として持っている控え（~/.claude/cache/model-catalog/<組織>-<…>-cc.json）
const CATALOG_DIR = join(homedir(), '.claude', 'cache', 'model-catalog');

type CatalogModel = {
  id?: string;
  name?: string;
  description?: string;
  section?: string;
  min_claude_code_version?: string | null;
  thinking?: { effort_options?: { id?: string }[] } | null;
};

// 控えのうち、Claude Code 用（surface が cc）で一番新しいものを読む。/model の画面は開かない
export async function readModelCatalog(): Promise<ModelCatalog | null> {
  const names = await readdir(CATALOG_DIR).catch(() => [] as string[]);
  const files = await Promise.all(
    names.filter((n) => n.endsWith('-cc.json')).map(async (n) => ({ path: join(CATALOG_DIR, n), mtime: (await stat(join(CATALOG_DIR, n))).mtimeMs })),
  );
  const newest = files.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return null;
  const data = JSON.parse(await readFile(newest.path, 'utf8')) as {
    fetchedAt?: number;
    catalog?: { surface?: string; config?: { models?: CatalogModel[] } };
  };
  const models = data.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  const installed = await claudeVersion();
  // /model と同じく、主なもの（main）を先に、旧モデル（overflow）をあとに並べる
  const ordered = [...models.filter((m) => m.section !== 'overflow'), ...models.filter((m) => m.section === 'overflow')];
  const choices: ModelChoice[] = ordered
    .filter((m): m is CatalogModel & { id: string } => typeof m.id === 'string')
    .map((m) => {
      const needs = m.min_claude_code_version ?? null;
      const disabled = !!needs && !!installed && compareVersions(installed, needs) < 0;
      return {
        value: m.id,
        name: m.name ?? m.id,
        detail: disabled ? `Claude Code ${needs} 以上が必要（今は ${installed}）` : (m.description ?? ''),
        disabled,
        efforts: m.thinking?.effort_options?.map((e) => e.id).filter((id): id is string => !!id) ?? [],
      };
    });
  return { choices, updatedAt: data.fetchedAt ?? newest.mtime };
}

function claudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : (stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null)));
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
