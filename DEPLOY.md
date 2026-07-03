# Render デプロイ手順

## 1. Git リポジトリ作成とコミット (このフォルダで)

```
git init
git add .
git commit -m "Add proxy server and Render config"
```

## 2. GitHub へ push

GitHub で空リポジトリ (例: `isehara-game`) を作成後:

```
git remote add origin https://github.com/<ユーザー名>/isehara-game.git
git branch -M main
git push -u origin main
```

## 3. Render に接続

1. [Render ダッシュボード](https://dashboard.render.com/) → **New** → **Blueprint**
2. GitHub リポジトリ `isehara-game` を選択
3. `render.yaml` が自動検出される → **Apply** (無料プラン・`node server/server.js` 起動が設定済み)
4. デプロイ完了後、`https://isehara-game.onrender.com` のようなURLでアクセス可能

以後は `git push` するだけで自動再デプロイされます。

## 注意点

- **無料プランのスリープ**: 約15分アクセスがないとスリープし、次のアクセス時の起動に
  1分程度かかります。
- **キャッシュの揮発**: Render のディスクは永続化されないため、`server/cache/` は
  再デプロイ・再起動のたびに消えます。消えた後の初回読み込みだけ従来どおり時間がかかり、
  以降は再び高速になります。
- ローカル利用は従来どおり `node server/server.js` (8080番) で変わりません。
