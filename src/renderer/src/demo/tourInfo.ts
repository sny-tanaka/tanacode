// 機能紹介のツアーの名前と説明。デモのサイトの親のページ（機能一覧・上の帯）は、台本（tours.ts）を読み込まずにこれだけを使う
// （台本はアプリの部品や Monaco エディタまで読み込むため）

export type TourInfo = {
  id: string;
  // Storybook のストーリー名と、デモのサイトの機能一覧に出す名前
  title: string;
  // 機能一覧に出す、1〜2 文の説明
  summary: string;
};

export const TOUR_INFO: TourInfo[] = [
  { id: 'basic', title: '基本', summary: '指示を送ると、ツール・質問・書き換えたファイル・サブエージェントが、それぞれ見やすい形で並びます。' },
  { id: 'review', title: 'レビュー', summary: 'ブランチの変更を PR のように見て、差分の行にコメント。まとめて Claude に直してもらえます。' },
  { id: 'workflow', title: 'ワークフロー', summary: 'Claude が動かしたワークフローを図で表示。並列に動くエージェントの進み具合と会話を追えます。' },
  { id: 'multi', title: '複数のセッション', summary: 'いくつものセッションを並行して動かし、一覧の印で「作業中」「回答待ち」「新しい応答」を見分けます。' },
  { id: 'preview', title: 'プレビュー', summary: '開発中のページをアプリ内のブラウザで開き、崩れている要素をクリックで選んで直してもらいます。' },
  { id: 'visibility', title: '見える化', summary: 'Claude が読んだファイル・コンテキストの量・hooks・利用枠を、作業に合わせて表示します。' },
];
