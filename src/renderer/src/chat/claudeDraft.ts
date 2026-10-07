import { useEffect, useRef } from 'react';
import { useTypingInClaudeScreen } from '../terminal/claudeScreenTyping';

// Claude Code の入力欄に文字（draft）が残っていたら（巻き戻し直後は戻した発言が入る）、チャットの入力欄に移して（onTake）向こうは消す。
// 残したまま送ると、送った文字がその後ろにつながってしまう。
// 人が Claude Code の画面（ターミナル）で打っている途中の文字は移さない（打つそばから移して消すと、途中の文字が欠ける）。画面を離れたら移す
export function useTakeClaudeDraft(sessionId: string, draft: string, onTake: (text: string) => void): void {
  const typingInTerminal = useTypingInClaudeScreen(sessionId);
  const take = useRef(onTake);
  take.current = onTake;
  const movedDraft = useRef<string | null>(null);
  useEffect(() => {
    // 消えたら忘れる（同じ発言をもう一度中断して戻ったときも移す）
    if (!draft) movedDraft.current = null;
    if (!draft || typingInTerminal || movedDraft.current === draft) return;
    // 送信中の文字（Claude Code の入力欄に打ち込んでいる途中のもの）は、main が draft から除いて知らせるので、ここには来ない
    movedDraft.current = draft;
    take.current(draft);
    window.tanacode.pty.write(sessionId, '\x15'.repeat(draft.split('\n').length + 1));
  }, [draft, typingInTerminal, sessionId]);
}
