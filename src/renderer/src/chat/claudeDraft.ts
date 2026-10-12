import { useEffect, useRef } from 'react';
import { useTypingInClaudeScreen } from '../terminal/claudeScreenTyping';

// Claude Code の入力欄に文字（draft）が残っていたら（巻き戻し直後は戻した発言が入る）、チャットの入力欄に移して（onTake）向こうは消す。
// 残したまま送ると、送った文字がその後ろにつながってしまう。
// pastes: 中断で戻った発言に添えてあった札の中身（main が知らせる）。入力欄では目印（[Pasted text #1 +30 lines]）になっているので、
// 目印を除いた文と、札に分けて移す
// ターミナルモードで Claude Code の画面を出している間は移さない（そこにある文字は、人が画面で打っているもの）。チャットに戻したら移す
export function useTakeClaudeDraft(sessionId: string, draft: string, pastes: string[] | undefined, onTake: (text: string, pastes: string[]) => void): void {
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
    if (pastes) take.current(draft.replace(/\[Pasted text #\d+[^\]]*\]/g, '').trim(), pastes);
    else take.current(draft, []);
    window.tanacode.pty.write(sessionId, '\x15'.repeat(draft.split('\n').length + 1));
    // pastes は draft と一緒に届く（draft が同じなら、中身も同じ）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, typingInTerminal, sessionId]);
}
