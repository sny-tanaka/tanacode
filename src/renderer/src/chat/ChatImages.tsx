import { useEffect, useState, type ReactNode } from 'react';
import { t } from '@shared/i18n';

// 一度取った画像（data URL）。同じ画像を何度も取りに行かない
const loaded = new Map<string, string | null>();

// 並べる画像。key は並びの中で重ならないもの。load は data URL を返す（読めなければ null）。footer は画像の下に添えるもの
export type ImageSource = { key: string; load: () => Promise<string | null>; footer?: ReactNode };

// 会話ログに埋め込まれた画像を小さく並べる。クリックで大きく出す
export function ChatImages({ keys }: { keys: string[] }) {
  return <ImageList images={keys.map((key) => ({ key, load: () => loadLogImage(key) }))} />;
}

// 会話ログの画像は中身が変わらないので、取ったものを覚えておく
async function loadLogImage(key: string): Promise<string | null> {
  if (loaded.has(key)) return loaded.get(key) ?? null;
  const value = await window.tanacode.sessions.image(key);
  loaded.set(key, value);
  return value;
}

// 画像を小さく並べる。クリックで大きく出す
export function ImageList({ images }: { images: ImageSource[] }) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomed(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);
  return (
    <div className="chat-images" onClick={(e) => e.stopPropagation()}>
      {images.map(({ key, load, footer }) =>
        footer ? (
          <div key={key} className="chat-image-with-footer">
            <ChatImage imageKey={key} load={load} onZoom={setZoomed} />
            {footer}
          </div>
        ) : (
          <ChatImage key={key} imageKey={key} load={load} onZoom={setZoomed} />
        ),
      )}
      {zoomed && (
        <div className="image-zoom" onClick={() => setZoomed(null)} role="dialog" aria-label={t('composer.images.closeZoom')}>
          <img src={zoomed} alt="" />
        </div>
      )}
    </div>
  );
}

function ChatImage({ imageKey, load, onZoom }: { imageKey: string; load: () => Promise<string | null>; onZoom: (url: string) => void }) {
  const [url, setUrl] = useState<string | null | undefined>(() => loaded.get(imageKey));
  useEffect(() => {
    if (loaded.has(imageKey)) return;
    let alive = true;
    void load().then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
    // load は描くたびに作り直されるので、画像が変わったか（key）だけを見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);

  if (url === undefined) return <div className="chat-image placeholder">{t('composer.images.loading')}</div>;
  if (url === null) return <div className="chat-image placeholder">{t('composer.images.unreadable')}</div>;
  return (
    <button className="chat-image" onClick={() => onZoom(url)} title={t('composer.images.zoom')}>
      <img src={url} alt="" />
    </button>
  );
}
