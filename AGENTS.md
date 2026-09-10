# エージェント開発・運用ガイドライン (asabon.github.io)

本リポジトリ (`asabon.github.io`) を Antigravity などの AI エージェントと共に保守・運用するための開発ルールおよびガイドラインです。

## 1. 開発フロー (GitHub Flow)
本リポジトリでは GitHub Flow に従って開発を行います。

- **`main` ブランチへの直接 commit / push は禁止**
  - リポジトリの保護ルールにより `main` への直接 push は拒否されます。
  - `main` は常にリモートの最新状態を追従する専用ブランチとし、ローカルの `main` への直接 commit も禁止とします。
  - すべての変更は、最新の `main` からトピックブランチを作成して行います。
  - 誤コミット防止のため、`.githooks/pre-commit` にて `main` ブランチでのコミットをブロックする Git フックを用意しています（有効化: `git config core.hooksPath .githooks`）。
- **ブランチの作成**
  - 作業内容に応じた明確なブランチ名を作成します（例: `feature/xxx`, `fix/xxx`, `add-xxx`, `update-xxx`）。
- **コミットとプッシュ**
  - 変更内容を論理的な単位でコミットします。
  - コミットメッセージは日本語で簡潔・具体的に記述します（例: `_config.yml を追加`）。
  - 作業ブランチをリモートに push します (`git push -u origin <branch-name>`)。
- **プルリクエスト (PR) の作成**
  - GitHub CLI (`gh pr create`) を活用し、PR を作成します。
  - タイトルと変更内容のサマリーを記載します。
- **マージとクリーンアップ**
  - PR のマージ方式には通常のマージコミットのほか、履歴を1つにまとめる「Squash and merge (スカッシュマージ)」も用いられます。
  - PR がマージされたら、ローカルの `main` ブランチを最新に同期します (`git checkout main && git pull origin main`)。
  - スカッシュマージの場合、コミットハッシュが `main` 上で新しく生成されるため、通常の `git branch -d` では未マージ警告（not fully merged）が出ることがあります。PR のマージが完了していることを確認の上、必要に応じて `git branch -D <branch-name>` で作業ブランチを削除・整理します。
  - 不要になったリモート追跡ブランチを整理します (`git remote prune origin` または `git fetch --prune`)。

## 2. リポジトリ概要・構成
- 本リポジトリは GitHub Pages (`https://asabon.github.io` / `https://www.asabon.net/`) で公開される静的サイトおよびアプリ関連ページです。
- 各種アプリケーションの公開情報、プライバシーポリシー（Markdown 形式）などを管理しています。
- 主要ファイル・ディレクトリ:
  - `_config.yml`: GitHub Pages (Jekyll) のサイト設定
  - `CNAME`: カスタムドメイン設定 (`www.asabon.net`)
  - `ads.txt`: 広告配信関連の設定
  - `index.md`: トップページ
  - アプリ用ディレクトリ (例: `gymkit/` (旧 `interval_timer/`), `comic_progress/`, `bus_timetable/`, `place_keeper/`, `smart_shop_calc/` など)

## 3. ドキュメント・規約
- 日本語の文章・Markdown を作成・修正する際は、既存ドキュメントの文体やフォーマットに合わせる。
- ファイルの文字コードは UTF-8 (改行コード LF/CRLF 既存準拠) を使用する。
