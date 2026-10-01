// tanacode のリポジトリ（GitHub）
export const REPO_URL = 'https://github.com/sny-tanaka/tanacode';

// tanacode の新しい版の知らせ（タイトルバーのバージョンの横の印）
export type AppUpdate = {
  // GitHub の Releases で公開されている最新の版（例: 0.1.5）
  latest: string;
  // 今のアプリより新しいか
  available: boolean;
  // その版の Releases のページ
  url: string;
};
