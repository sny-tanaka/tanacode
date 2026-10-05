import { Director, setFastForward } from '../director';
import { CHAPTERS } from './chapters';
import type { Story } from './story';

// README の紹介画像の場面を作る。ツアーを早送りで流し、台本の目印 'showcase'（章 3 の、Claude が読んだ・書いたファイルと hooks が止めた理由が見える場面）で止める。
// 止めたあとは台本を先へ進めない（目印の待ちを解かない）。作り物のカーソルは消し、早送りも戻して、画面の動き（ぐるぐるなど）はふつうに描く
export function runShowcase(story: Story): Promise<void> {
  const d = new Director();
  story.d = d;
  return new Promise((resolve, reject) => {
    story.mark = async (name) => {
      if (name !== 'showcase') return;
      setFastForward(false);
      d.dispose();
      resolve();
      await new Promise<never>(() => {});
    };
    setFastForward(true);
    void (async () => {
      for (const chapter of CHAPTERS) await chapter.run(story);
      throw new Error("demo: 目印 'showcase' の場面がありません");
    })().catch(reject);
  });
}
