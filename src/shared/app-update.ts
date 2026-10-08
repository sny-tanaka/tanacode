// tanacode のリポジトリ（GitHub）
export const REPO_URL = 'https://github.com/sny-tanaka/tanacode';

// tanacode の新しいバージョンの知らせ（タイトルバーのバージョンの横の印）
export type AppUpdate = {
  // GitHub の Releases で公開されている最新バージョン（例: 0.1.5）
  latest: string;
  // 今のアプリより新しいか
  available: boolean;
  // そのバージョンの Releases のページ
  url: string;
  // Homebrew で入れたアプリなら、新しいバージョンの用意（brew で入れていない・新しいバージョンが無いときは無し）
  homebrew?: HomebrewUpdate;
};

// downloading: 裏で brew update・brew fetch をしている（tap の cask が新しくなるのを待っているときも）/
// ready: ダウンロード済み。終了すると入れ替えられる（version は brew が入れるバージョン）/ failed: 用意できなかった（あとでやり直す）
export type HomebrewUpdate = { status: 'downloading' } | { status: 'ready'; version: string } | { status: 'failed' };
