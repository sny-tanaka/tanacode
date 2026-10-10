// ファイルを文字列のまま読む import（Vite の ?raw）。画面の型（vite/client）には入っているが、main とテストの型には無いので足す
declare module '*?raw' {
  const text: string;
  export default text;
}
