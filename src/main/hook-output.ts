// アプリが --settings に足すフックの、標準出力に書くもの。
// チャットでは、何も出力しなかったフックを、Claude Code が知らせる hook_response（--include-hook-events）から出す（会話ログには残らない）。
// hook_response にはコマンドが載らないので、アプリのフックは、何も決めないときも suppressOutput: true を書いて、ユーザーのフックと見分ける。
// suppressOutput は、Claude に渡す中身にも、フックの答え（判断・additionalContext）の効き目にも関わらない（Claude Code 2.1.302 で実測）。
// ただし、何かを書いたフックは会話ログに記録（hook_success）が残る（チャットでは、コマンドの印でアプリのフックとして除く）

export const SUPPRESS_OUTPUT = '{"suppressOutput":true}';

// output: フックの答え（JSON。何も決めないときは空・空の JSON）。JSON のオブジェクトなら suppressOutput を足し、そうでなければそのまま返す
export function appHookOutput(output: string): string {
  const text = output.trim();
  if (!text) return SUPPRESS_OUTPUT;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return output;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  return JSON.stringify({ ...value, suppressOutput: true });
}
