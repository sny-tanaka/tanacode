import { randomUUID } from 'node:crypto';
import type { CredentialLink } from '@shared/credential-links';
import type { BrowserRememberChange, BrowserRememberOffer } from '@shared/ipc';

// Claude がチャットで渡されたリンクで 1Password から入れたあと、そのサイトでは次からこのアイテムを使うかを、人に聞く（fill_credential。browser-credentials.ts）。
// 聞くのはアプリ内ブラウザの帯（画面の PreviewPane の RememberBar）。macOS のダイアログのように待たせない: fill_credential は返事を待たずに返す。
// 人が「使う」を押したときだけ、サイトごとの控え（settings.json の credentialLinks）に足す。「使わない」・閉じたら何もしない（勝手には控えない。
// ページに書かれたリンクを Claude が使っても、人が選ばなければ控えに残らない）。
// 帯はセッションごとに 1 つ。新しく聞いたら前のものは消す（同じセッションで続けて入れたとき、古い問いを残さない）

type Pending = { offer: BrowserRememberOffer; link: string };

export class CredentialOffers {
  private readonly pending = new Map<string, Pending>();

  constructor(
    // 帯を出した・消した（offer が null）
    private readonly send: (change: BrowserRememberChange) => void,
    // 人が「使う」を押した。控えに足す
    private readonly save: (link: CredentialLink) => void,
  ) {}

  // 聞く。site: 控えるサイト（ホスト名か host:port）/ link: 渡されたリンク / title: 1Password が返したアイテムの名前（帯に出す）
  offer(sessionId: string, site: string, link: string, title: string): void {
    const offer: BrowserRememberOffer = { id: randomUUID(), site, title };
    this.pending.set(sessionId, { offer, link });
    this.send({ sessionId, offer });
  }

  // 今出している帯（画面を作り直したとき用）
  list(): BrowserRememberChange[] {
    return [...this.pending].map(([sessionId, { offer }]) => ({ sessionId, offer }));
  }

  // 人の返事。use: 「使う」を押した（false は「使わない」か閉じた）。今出している帯への返事でなければ何もしない
  answer(sessionId: string, offerId: unknown, use: unknown): void {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.offer.id !== offerId) return;
    this.pending.delete(sessionId);
    this.send({ sessionId, offer: null });
    if (use === true) this.save({ site: pending.offer.site, link: pending.link });
  }

  // セッションを消した・アーカイブした
  forget(sessionId: string): void {
    if (!this.pending.delete(sessionId)) return;
    this.send({ sessionId, offer: null });
  }
}
