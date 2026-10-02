// IPC の失敗は「Error invoking remote method '…': Error: <本文>」の形で届くので、画面には本文だけを出す
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
