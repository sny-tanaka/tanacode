import { useEffect, useState } from 'react';
import { App } from '../../App';
import type { DemoBackend } from '../backend';
import { Director, setPaused } from '../director';
import { Claude } from '../scenarios/claude';
import { type Tour, TOURS } from '../tours';
import { setInputBlocked } from './inputGuard';
import { isShellMessage, type Phase, type StageMessage } from './messages';

// iframe の中のアプリの画面。ツアーを選んでいれば台本を流し、操作の説明と状態を親のページに知らせる。
// 終わったら（ツアーを選んでいなければ初めから）、そのまま触れる

const FREE_REPLY = [
  'これはデモです。本物の Claude には繋がっていないので、指示は実行されません。',
  '',
  '上の「機能一覧」から機能を選ぶと、実際の画面で操作の流れを紹介します。',
].join('\n');

const post = (message: StageMessage) => window.parent.postMessage(message, '*');

// 自由に触るときの返事。送った発言には、デモであることを知らせる決まった返事をする（本物の Claude には繋がない）
function enterFreeMode(backend: DemoBackend): void {
  const claudes = new Map<string, Claude>();
  backend.onUserMessage = (id, text, images) => {
    let claude = claudes.get(id);
    if (!claude) {
      claude = new Claude(backend, id, 'free-');
      claudes.set(id, claude);
    }
    const c = claude;
    backend.push(id, { type: 'user', id: c.next('u'), text, images });
    c.startWorking();
    setTimeout(() => {
      c.stopWorking();
      c.say(FREE_REPLY);
      backend.push(id, { type: 'turn-end' });
    }, 1200);
  };
  // 質問のカードが残っていたら、答えたところで閉じる
  backend.onChoose = (id) => {
    backend.setScreen(id, { state: { kind: 'prompt' } });
    backend.update(id, { attention: null });
  };
}

export function Stage({ tour, backend }: { tour: Tour | null; backend: DemoBackend }) {
  const [phase, setPhase] = useState<Phase>(tour ? 'playing' : 'free');

  // ツアーを流す（ツアーを選んでいなければ、最初のツアーの始まりの状態のまま触れるようにする）
  useEffect(() => {
    let director: Director | null = null;
    let cancelled = false;
    const start = setTimeout(() => {
      if (!tour) {
        backend.select(TOURS[0].session);
        enterFreeMode(backend);
        return;
      }
      backend.select(tour.session);
      const d = new Director();
      director = d;
      d.onCaption = (text) => post({ type: 'demo:caption', text });
      tour
        .run(backend, d)
        .then(
          () => !cancelled && setPhase('done'),
          (error: unknown) => {
            console.error('demo failed', error);
            if (!cancelled) setPhase('failed');
          },
        )
        .finally(() => {
          d.dispose();
          enterFreeMode(backend);
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(start);
      director?.dispose();
    };
  }, [backend, tour]);

  // 再生中は見ている人の操作を止める。状態は親のページにも知らせる（帯の文言とボタンが変わる）
  useEffect(() => {
    setInputBlocked(phase === 'playing');
    if (phase !== 'playing') setPaused(false);
    post({ type: 'demo:phase', phase });
  }, [phase]);

  // 親のページの一時停止（帯のボタンと、機能一覧を開いている間）
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === window.parent && isShellMessage(e.data)) setPaused(e.data.paused);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="demo-app">
      <App />
    </div>
  );
}
