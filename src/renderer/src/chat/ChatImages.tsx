import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';

// 一度取った画像（data URL）。同じ画像を何度も取りに行かない
const loaded = new Map<string, string | null>();

// 会話ログに埋め込まれた画像を小さく並べる。クリックで大きく出す
export function ChatImages({ keys }: { keys: string[] }) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomed(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);
  return (
    <div className="chat-images" onClick={(e) => e.stopPropagation()}>
      {keys.map((key) => (
        <ChatImage key={key} imageKey={key} onZoom={setZoomed} />
      ))}
      {zoomed && (
        <div className="image-zoom" onClick={() => setZoomed(null)} role="dialog" aria-label={t('composer.images.closeZoom')}>
          <img src={zoomed} alt="" />
        </div>
      )}
    </div>
  );
}

function ChatImage({ imageKey, onZoom }: { imageKey: string; onZoom: (url: string) => void }) {
  const [url, setUrl] = useState<string | null | undefined>(() => loaded.get(imageKey));
  useEffect(() => {
    if (loaded.has(imageKey)) return;
    let alive = true;
    void window.tanacode.sessions.image(imageKey).then((value) => {
      loaded.set(imageKey, value);
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [imageKey]);

  if (url === undefined) return <div className="chat-image placeholder">{t('composer.images.loading')}</div>;
  if (url === null) return <div className="chat-image placeholder">{t('composer.images.unreadable')}</div>;
  return (
    <button className="chat-image" onClick={() => onZoom(url)} title={t('composer.images.zoom')}>
      <img src={url} alt="" />
    </button>
  );
}
