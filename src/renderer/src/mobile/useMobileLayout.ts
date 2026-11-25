import { useEffect, useState } from 'react';
import { isRemoteMode } from '../remote/mode';

// スマホの配置（上の帯・セッションの引き出し・下のタブ）にするか（Issue #464）。スマホの画面（遠隔の接続）で、幅が狭いときだけ。
// Mac の画面は、窓を狭くしても変えない
export const MOBILE_MAX_WIDTH = 760;

export function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(() => isRemoteMode() && window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches);
  useEffect(() => {
    if (!isRemoteMode()) return;
    const query = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
    const change = () => setMobile(query.matches);
    query.addEventListener('change', change);
    // キーボードが出ている間は、見えている高さに画面を合わせる（入力欄がキーボードに隠れないように）
    const viewport = window.visualViewport;
    const fit = () => document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
    fit();
    viewport?.addEventListener('resize', fit);
    return () => {
      query.removeEventListener('change', change);
      viewport?.removeEventListener('resize', fit);
    };
  }, []);
  return mobile;
}
