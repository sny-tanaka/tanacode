import type { Session } from 'electron';
import { isLocalUrl } from '@shared/browser-tools';

// アプリ内ブラウザ（プレビューのセッション）の HTTPS の証明書の扱い。
// この Mac の中だけで動いているページ（localhost・127.0.0.1・[::1]・*.localhost。isLocalUrl と同じ）は、証明書を確かめられなくても開く
// （自己署名の証明書・mkcert の開発サーバーなど）。ほかの先は、Chromium の確かめたとおりにする（誤りがあれば開かない）。
// - この Mac の中の先だけにする理由: localhost・*.localhost は Chromium が DNS を引かずにこの Mac（ループバック）につなぎ、127.0.0.1・[::1] も
//   この Mac なので、ネットワークの途中の人が成りすませない（中間者攻撃にならない）。証明書が守るもの（正しい相手につながっていること）が、
//   はじめから守られている。Chrome の allow-insecure-localhost と同じ考え方
// - *.local・ユーザーが足した先・/etc/hosts でこの Mac に向けた名前は含めない。*.local は同じネットワークの誰でも mDNS で答えられ、
//   ほかの名前も DNS の答えしだいで外の機械につながる（その先の証明書の誤りを通すと、中間者攻撃を通してしまう）。
//   名前で決める（つないだ先の IP アドレスは、ここでは分からない）
// - 設定でのオン・オフは設けない。この Mac の中の先では通しても危なくならず、外の先では決して通さないので、選ぶものが無い
// 確かめるのは Chromium が先にする（verificationResult）。通すのは、Chromium が誤りとしたこの Mac の中の先だけ。
// セッションごとに付けるので、アプリの画面やほかの通信（GitHub など。既定のセッションと Node の通信）には効かない
export function trustLocalCertificates(preview: Session): void {
  preview.setCertificateVerifyProc((request, callback) => {
    // 0: 通す / -3: Chromium の確かめたとおり
    callback(request.verificationResult !== 'net::OK' && isLocalHost(request.hostname) ? 0 : -3);
  });
}

// この Mac の中の先のホスト名か。IPv6 のアドレスは、括弧の無い形（::1）でも来る
export function isLocalHost(hostname: string): boolean {
  // URL に組み込むので、ホスト名に使う文字だけのものに限る（/・#・@ などで、別のホストに読ませない）
  if (!/^[a-z0-9.\-:[\]]+$/i.test(hostname)) return false;
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return isLocalUrl(`https://${host}/`);
}

// 開けなかった理由が証明書の誤りのとき、Claude に添える説明（英語）。ほかの理由なら空
export function certificateErrorHint(error: string): string {
  if (!/ERR_CERT_/.test(error)) return '';
  return (
    ' The certificate of this site could not be verified. tanacode accepts such certificates only for pages on this Mac ' +
    '(localhost, 127.0.0.1, [::1] and *.localhost), and never for other hosts, because there it could be a man-in-the-middle attack. ' +
    'If this is a development server on this Mac, open it as https://localhost (with its port) instead. Otherwise tell the user; do not try to get around it.'
  );
}
