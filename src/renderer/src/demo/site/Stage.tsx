import { useEffect, useState } from 'react';
import { App } from '../../App';
import { Director, isFastForward, setFastForward, setPaused } from '../director';
import { Claude } from '../scenarios/claude';
import { CHAPTERS } from '../story/chapters';
import type { Story } from '../story/story';
import { setInputBlocked } from './inputGuard';
import { isShellMessage, type Phase, type StageMessage } from './messages';

// iframe の中のアプリの画面。ツアー（story/）を章の順に流し、操作の説明・章・状態を親のページに知らせる。
// start より前の章は早送りで流す（目次から途中の章へ飛んだとき）。ツアーが終わったら（ツアーを流さないときは初めから）、そのまま触れる

const FREE_REPLY = [
  'これはデモです。本物の Claude には繋がっていないので、指示は実行されません。',
  '',
  '上の「目次」から章を選ぶと、実際の画面で操作の流れを紹介します。',
].join('\n');

const post = (message: StageMessage) => window.parent.postMessage(message, '*');

// 自由に触るときの返事。送った発言には、デモであることを知らせる決まった返事をする（本物の Claude には繋がない）
function enterFreeMode(story: Story): void {
  const { backend } = story;
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

// start: ツアーを始める章の番号（-1 ならツアーを流さない）
export function Stage({ story, start }: { story: Story; start: number }) {
  const [phase, setPhase] = useState<Phase>(start >= 0 ? 'playing' : 'free');

  // ツアーを流す
  useEffect(() => {
    let director: Director | null = null;
    let cancelled = false;
    // 「次の章へ」を押したら、この番号の章までを早送りで流す
    let skipTo = start;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || !isShellMessage(e.data)) return;
      if (e.data.type === 'demo:pause') setPaused(e.data.paused);
      else if (e.data.type === 'demo:next' && director) {
        skipTo = current + 1;
        setFastForward(true);
        director.clearCaption();
        post({ type: 'demo:caption', text: '', box: null });
      }
    };
    let current = 0;
    window.addEventListener('message', onMessage);
    const timer = setTimeout(async () => {
      if (start < 0) {
        story.showStart();
        enterFreeMode(story);
        return;
      }
      const d = new Director();
      director = d;
      story.d = d;
      story.showExport = (html) => post({ type: 'demo:export', html });
      story.hideExport = () => post({ type: 'demo:export', html: null });
      // 早送りの間の説明は出さない（Director が出さない。親のページは「手前まで進めています」と出す）
      d.onCaption = (text, box) => post({ type: 'demo:caption', text, box });
      try {
        for (current = 0; current < CHAPTERS.length && !cancelled; current++) {
          const ff = current < skipTo;
          setFastForward(ff);
          d.clearCaption();
          post({ type: 'demo:chapter', index: current, preparing: ff });
          await CHAPTERS[current].run(story);
          if (!ff && !isFastForward()) post({ type: 'demo:watched', index: current });
        }
        if (!cancelled) setPhase('done');
      } catch (error) {
        console.error('demo failed', error);
        if (!cancelled) setPhase('failed');
      } finally {
        setFastForward(false);
        d.dispose();
        post({ type: 'demo:caption', text: '', box: null });
        enterFreeMode(story);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      director?.dispose();
    };
  }, [story, start]);

  // 再生中は見ている人の操作を止める。状態は親のページにも知らせる（帯の文言とボタンが変わる）
  useEffect(() => {
    setInputBlocked(phase === 'playing');
    if (phase !== 'playing') setPaused(false);
    post({ type: 'demo:phase', phase });
  }, [phase]);

  return (
    <div className="demo-app">
      <App />
    </div>
  );
}
