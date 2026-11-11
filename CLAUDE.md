# CLAUDE.md

- 会話・コメント・ドキュメントは日本語。
- ブラウザで動く3D探索ゲーム（three.js r128、ビルド工程なし）。GitHub の main へ push すると Render（無料プラン）に自動デプロイされる。
- ユーザーの PowerShell は 5.x。コマンドは `;` 区切りで書く。
- コードを変更したら、最後に必ずデプロイ用コマンドを示す: `git add -A; git commit -m "<要約>"; git push origin main`
- ローカル確認: `npm start` → http://localhost:8080 。テスト: `npm test`（全JSの構文検査＋純関数のユニットテスト）。
- 大原則: OSMの実データ（道路・線路・建物）への忠実さを、手続き生成や性能の都合より優先する。
- 構成は `ARCHITECTURE.md`。過去の資料は `docs/archive/`（必要な時だけ参照）。
- 改善の実装指示は `docs/IMPL_PLAN_20261111.md`（段階1〜8。これが正本）。根拠は `docs/CODE_REVIEW_20261111_ZEROBASE.md` と `docs/CODE_REVIEW_20261109_ZEROBASE.md`。実装状況は後者の「実装状況」節に追記する。
- コメントは「なぜそうするか」を短く書く。日付付きの経緯はコミットメッセージと docs/ に残す。
- 性能の比較は ⚙ → デバッグ → ⏱ 性能表示 の数値で行う。
