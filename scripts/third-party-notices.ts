// アプリに入れて配る依存のライセンス表示（THIRD_PARTY_NOTICES.txt）を組み立てる。
// electron.vite.config.ts の rollup-plugin-license から使う
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Dependency } from 'rollup-plugin-license';

type Entry = { name: string; version: string | null; license: string | null; source: string | null; text: string | null };
type PackageJson = {
  name: string;
  version: string;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
  dependencies?: Record<string, string>;
};

// パッケージに LICENSE のファイルが無い依存は、同じプロジェクトの別のパッケージの文を借りる（どれも xterm.js の MIT）
const SAME_LICENSE_AS: Record<string, string> = {
  '@xterm/headless': '@xterm/xterm',
  '@xterm/addon-serialize': '@xterm/xterm',
};

// CSS だけを読み込むもの（フォント）は、プラグインから見えないので書き足す
const CSS_ONLY = ['@fontsource/jetbrains-mono'];

// package.json にライセンスが無い依存（mermaid が使う khroma など）は、同梱の LICENSE の文から判断する
export function licenseOf(license: string | null | undefined, text: string | null | undefined): string | null {
  return license ?? (/^\s*The MIT License/i.test(text ?? '') ? 'MIT' : null);
}

// 「github:owner/repo」「owner/repo」「git://…」「git+https://….git」などの書き方を、https の URL にそろえる
function sourceOf(repository: PackageJson['repository'] | Dependency['repository'], homepage: string | null | undefined): string | null {
  const raw = typeof repository === 'string' ? repository : (repository?.url ?? null);
  if (!raw) return homepage ?? null;
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function readPackage(name: string): { dir: string; pkg: PackageJson; text: string | null } {
  const dir = resolve('node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return { dir, pkg, text: file ? readFileSync(join(dir, file), 'utf8') : null };
}

function fromPackage(name: string): Entry {
  const { pkg, text } = readPackage(name);
  const borrowed = !text && SAME_LICENSE_AS[name] ? readPackage(SAME_LICENSE_AS[name]).text : null;
  return {
    name,
    version: pkg.version,
    license: licenseOf(pkg.license, text ?? borrowed),
    source: sourceOf(pkg.repository, pkg.homepage),
    text: text ?? borrowed,
  };
}

// main が使う依存（同梱せず node_modules ごとアプリに入るもの）を、依存の依存までたどって集める
function runtimeEntries(): Entry[] {
  const root = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as PackageJson;
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name) || !existsSync(resolve('node_modules', name, 'package.json'))) return;
    seen.add(name);
    for (const child of Object.keys(readPackage(name).pkg.dependencies ?? {})) walk(child);
  };
  for (const name of Object.keys(root.dependencies ?? {})) walk(name);
  return [...seen].map(fromPackage);
}

function format(e: Entry): string {
  return [
    `${e.name}@${e.version ?? ''}`,
    `License: ${e.license ?? ''}`,
    // ソースの入手先（EPL-2.0 の elkjs などで要る）
    `Source: ${e.source ?? `https://www.npmjs.com/package/${e.name}`}`,
    '',
    (e.text ?? '').trim(),
    '',
    '-'.repeat(72),
  ].join('\n');
}

// 画面に同梱した依存（プラグインが見つけたもの）に、フォントと main の依存を足して、名前の順に並べる
export function thirdPartyNotices(bundled: Dependency[]): string {
  const entries = new Map<string, Entry>();
  for (const d of bundled) {
    if (!d.name) continue;
    entries.set(d.name, { name: d.name, version: d.version, license: licenseOf(d.license, d.licenseText), source: sourceOf(d.repository, d.homepage), text: d.licenseText });
  }
  for (const e of [...CSS_ONLY.map(fromPackage), ...runtimeEntries()]) if (!entries.has(e.name)) entries.set(e.name, e);
  const header = 'tanacode に同梱しているサードパーティのソフトウェアと、そのライセンスです。\n(Third-party software bundled with tanacode, and their licenses.)\n\n' + '='.repeat(72);
  return [header, ...[...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map(format)].join('\n\n') + '\n';
}
