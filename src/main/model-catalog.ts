import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions } from '@shared/claude-code';
import { t } from '@shared/i18n';
import type { ModelCatalog, ModelChoice } from '@shared/models';
import { claudeVersion } from './claude-version';
import { claudeConfigDir } from './claude-config';

// Claude Code が /model の一覧として持っている控え（~/.claude/cache/model-catalog/<組織>-<…>-cc.json）
const catalogDir = (claudeDir: string | null) => join(claudeConfigDir(claudeDir), 'cache', 'model-catalog');

type CatalogModel = {
  id?: string;
  name?: string;
  description?: string;
  section?: string;
  min_claude_code_version?: string | null;
  thinking?: { effort_options?: { id?: string }[] } | null;
};

// 控えのうち、Claude Code 用（surface が cc）で一番新しいものを読む。/model の画面は開かない
// claudeDir: プロファイルの Claude Code の設定のフォルダ（null は既定のプロファイル）
export async function readModelCatalog(claudeDir: string | null = null): Promise<ModelCatalog | null> {
  const dir = catalogDir(claudeDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names.filter((n) => n.endsWith('-cc.json')).map(async (n) => ({ path: join(dir, n), mtime: (await stat(join(dir, n))).mtimeMs })),
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
        detail: disabled ? t('main.model.needsVersion', { version: String(needs), installed: String(installed) }) : (m.description ?? ''),
        disabled,
        efforts: m.thinking?.effort_options?.map((e) => e.id).filter((id): id is string => !!id) ?? [],
      };
    });
  return { choices, updatedAt: data.fetchedAt ?? newest.mtime };
}
