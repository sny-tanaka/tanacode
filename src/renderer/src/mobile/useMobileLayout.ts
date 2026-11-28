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
    // キーボードが出ている間は、見えている範囲に画面を合わせる（入力欄がキーボードに隠れないように）。
    // iOS は入力欄に触れると、キーボードの分だけ見えている範囲を下へずらす（visualViewport.offsetTop）。高さだけ合わせると、
    // 画面の上の端がずれた分だけ見えない所に残り、入力欄ごと上へ押し出される。上の端もずれに合わせる（--app-top。CSS の .app.mobile）
    const viewport = window.visualViewport;
    const root = document.documentElement.style;
    const fit = () => {
      root.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
      root.setProperty('--app-top', `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
    };
    fit();
    viewport?.addEventListener('resize', fit);
    viewport?.addEventListener('scroll', fit);
    return () => {
      query.removeEventListener('change', change);
      viewport?.removeEventListener('resize', fit);
      viewport?.removeEventListener('scroll', fit);
    };
  }, []);
  return mobile;
}
