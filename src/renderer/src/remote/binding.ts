// ログインの画面（src/main/remote-login-page.ts）が IndexedDB に置いた束縛の鍵で、乱数に署名する（Issue #464）。
// 鍵は取り出せない P-256 の鍵で、ホーム画面の PWA の保存先にだけある。登録の途中の鍵（pending）は使わない（ログインで binding に移る）

const DB = 'tanacode-remote';
const STORE = 'keys';

type BindingKey = { privateKey: CryptoKey };

export const toBase64 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export const toBase64url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readKey(): Promise<BindingKey | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('binding');
      tx.oncomplete = () => resolve(req.result as BindingKey | undefined);
      tx.onerror = () => reject(tx.error);
    };
  });
}

// 乱数（文字列）に署名して base64url で返す。鍵が無ければ null（ログインし直す）
export async function signWithBinding(challenge: string): Promise<string | null> {
  const key = await readKey();
  if (!key) return null;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(challenge));
  return toBase64url(new Uint8Array(signature));
}
