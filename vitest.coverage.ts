// カバレッジの測り方（npm run coverage・npm run coverage:cli で使う。--coverage を付けたときだけ測る）。
// 結果は coverage/<name>/coverage-final.json に書き、scripts/coverage-report.mjs が、測ったものをまとめて層ごとに出す
export function coverage(name: string) {
  return {
    provider: 'v8' as const,
    // テストで読み込まなかったファイルも 0% として数える
    include: ['src/**/*.{ts,tsx}'],
    // 見た目の確認（ストーリー）と、デモのサイトの台本は数えない
    exclude: ['src/**/*.stories.tsx', 'src/**/*.d.ts', 'src/renderer/src/demo/**'],
    reporter: [['json', { file: 'coverage-final.json' }]] as [string, Record<string, unknown>][],
    reportsDirectory: `coverage/${name}`,
    // 1 つ落ちても、ほかのテストで通ったところは数える（手元で、環境のせいで落ちるテストがあるときも測れるように）
    reportOnFailure: true,
  };
}
