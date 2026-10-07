// jsdom に無いもの（画面の部品が使う）を、何もしないものとして補う。テストのファイルの先頭で読み込む
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.requestAnimationFrame) window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
