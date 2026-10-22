import { useEffect, useState } from 'react';

// PDF を、Electron 組み込みの PDF ビューア（Chromium のもの。ページ送り・拡大・検索・印刷が付く）で出す。
// ビューアは URL で開くので、ファイルの中身（バイト列）を Blob にして blob: の URL にする（CSP の frame-src は blob: だけを通す。
// data: やファイルの URL は通さない）。ディスクでファイルが変わって中身が替わったら、URL を作り直して開き直す（スクロールの位置は先頭に戻る）
export function PdfView({ data, title }: { data: Uint8Array<ArrayBuffer>; title: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [data]);

  return <div className="editor-pdf">{url && <iframe src={url} title={title} />}</div>;
}
