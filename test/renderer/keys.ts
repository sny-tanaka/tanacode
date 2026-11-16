import { fireEvent } from '@testing-library/react';

// 一覧（layout/keyRow.ts の keyList）をキーで動かすテストの手伝い

// Tab を押す（押したときに、一覧の tabindex を付け替える。jsdom は Tab でフォーカスを動かさないので、移るのはテストが focus() で）
export const pressTab = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
// root の中で、Tab で止まる行（一覧の行と、質問のカードの選択肢）
export const tabStops = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[data-key-row], .menu-option')].filter((el) => el.tabIndex === 0);
// フォーカスのある要素でキーを押す
export const key = (name: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: name, ...init });
// Tab で入ったのと同じに、フォーカスを移す（:focus-visible にする）。
// :focus-visible は、直前の操作（キー・マウス）で見分ける（dom.ts）ので、Tab を押してから移す
export const focusByTab = (el: HTMLElement) => {
  fireEvent.keyDown(document.body, { key: 'Tab' });
  el.focus();
};
