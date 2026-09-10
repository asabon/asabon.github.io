# Antigravity 開発・運用ガイドライン (asabon.github.io)

本リポジトリ (`asabon.github.io`) を Antigravity と共に保守・運用するための開発ルールおよびガイドラインです。

## 1. 開発フロー (GitHub Flow)
本リポジトリでは GitHub Flow に従って開発を行います。

- **`main` ブランチへの直接 push は禁止**
  - リポジトリの保護ルールにより `main` への直接 push は拒否されます。
  - すべての変更はトピックブランチを作成して行います。
- **ブランチの作成**
  - 作業内容に応じた明確なブランチ名を作成します（例: `feature/xxx`, `fix/xxx`, `add-xxx`, `update-xxx`）。
- **コミットとプッシュ**
  - 変更内容を論理的な単位でコミットします。
  - コミットメッセージは日本語で簡潔・具体的に記述します（例: `_config.yml を追加`）。
  - 作業ブランチをリモートに push します (`git push -u origin <branch-name>`)。
- **プルリクエスト (PR) の作成**
  - GitHub CLI (`gh pr create`) を活用し、PR を作成します。
  - タイトルと変更内容のサマリーを記載します。
- **マージ後のクリーンアップ**
  - PR がマージされたら、ローカルの `main` ブランチを最新に同期します (`git checkout main && git pull origin main`)。
  - 不要になったローカル作業ブランチおよびリモートトラッキング参照を整理します (`git branch -d <branch-name>`, `git remote prune origin`)。

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
