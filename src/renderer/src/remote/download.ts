// 文字のファイルを、スマホにダウンロードする（作業の書き出しなど。Mac の保存のダイアログの代わり。Issue #464）。保存した名前を返す
export function downloadFile(text: string, fileName: string, type = 'text/html'): string {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // ダウンロードが始まってから外す（すぐ外すと、Safari では始まらないことがある）
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return fileName;
}
