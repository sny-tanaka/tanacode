// npm run coverage:e2e のとき、アプリから起動する Node のプロセスに NODE_OPTIONS の --require で読み込ませる（test/e2e/app.ts）。
// MCP の中継（Claude Code が起動する *-mcp.js）は、Claude Code が終わるときにシグナル（SIGINT）で止められるので、
// そのままではカバレッジ（NODE_V8_COVERAGE）を書かずに終わる。中継のときだけ、シグナルを受けたら process.exit で終えて、書かせる。
// ほかのプロセスでは何もしない
if (process.env.ELECTRON_RUN_AS_NODE === '1' && /-mcp\.js$/.test(process.argv[1] ?? '')) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
}
