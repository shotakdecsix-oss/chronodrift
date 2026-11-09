# 実装指示 ⑥:モード表示を1箇所に集約する(D-1)

## 着手前に必ず

```
grep -rn "Badge" js/legacy/*.js index.html
grep -rn "ModeRegistry" js/legacy/*.js js/core/mode-registry.js index.html
grep -n "geoBtn\|routeBtn\|geoFollowBadge\|routeSimBadge\|railLockBadge" index.html
```

## 前提(調査済みの事実)

1. **モードに関わる軸が4つ並存している**:

   | 軸 | UI | 状態表示 |
   |---|---|---|
   | ① 時代モード(見た目) | `#modeBtn`(`#modeIco` + `#modeSub`) | ボタン自身のサブラベル |
   | ② 視点 | `#viewBtn` / `#viewIco` / `#viewSub` / `#birdBtn` / `#birdDownBtn` / `#camDirBtn` / `#altKeepBtn` | バラバラ |
   | ③ **ゲームモード** | `#geoBtn` / `#routeBtn` | **`#geoFollowBadge` / `#routeSimBadge` / `#railLockBadge` の3つの独立バッジ** |
   | ④ 設定 | `#perfBtn`(⚙) | `#perfSub` |

2. `js/core/mode-registry.js` は**設計は良いが、まだ2つしか登録されていない**:
   - `routesim`(`part10.js:274`)
   - `geo`(`part7.js:630`)
   - `explore` は**暗黙の戻り先**としてしか使われていない(`ModeRegistry.switchMode('explore')` は呼ばれるが `registerMode` されていない)。
3. ④(設定)は過去にユーザー要望で ⚙ 1つに統合済み。**同じことを ③ でやる番。**

## 目的

**「今どの状態か」の単一の場所を UI に作る。** 今は画面の3箇所に散っていて、今後「電車でGO」やアルバムが増えるとバッジが5〜6個になる。

**⚠ これは「電車でGO」やアルバムを実装する *前* にやること。** 後からだと移行コストが上がる。

---

## Phase 1:バッジを1つに統合

### やること

1. **まず `grep -n "Badge" js/legacy/*.js index.html` で全参照を洗い出す。** `part7.js` / `part9.js` / `part10.js` に散っているはず。見落とすと「消えないバッジ」が残る。
2. `#geoFollowBadge` / `#routeSimBadge` / `#railLockBadge` を廃止し、**画面上部固定の `#modeBadge` 1つ**に置き換える。
3. 表示内容は `ModeRegistry.getActiveMode()` から生成する:
   ```
   🚶 探索                          ← explore のときは非表示でもよい
   📡 GPS追従
   🧭 経路シミュレーション
   📡 GPS追従 · 🚃 線路ロック        ← サブ状態はドット区切りで連結
   ```
4. **バッジをタップすると解除**(`ModeRegistry.switchMode('explore')`)。これで「抜け方が分からない」が構造的に解決する。
   - タップ判定は **`touchend` 起点**にすること。過去に横向きでタップが効かない不具合があり、6ボタンを `click` → `touchend` に統一した経緯がある([[project_isehara_game_tree_on_water_and_landscape_tap]])。

### やらないこと

- **視点(②)は混ぜない。** 「どのモードか」と「どこから見ているか」は独立した軸。混ぜると分かりにくくなる。
- 時代モード(①)も混ぜない。
- `#geoBtn` / `#routeBtn` はこの Phase では残す(Phase 3 で外す)。

---

## Phase 2:ModeRegistry を本物の単一軸にする

1. **`explore` を正式に `registerMode` する。** 今は暗黙の戻り先でしかない。
2. 各モードの `onEnter` / `onExit` に、**バッジ更新・専用UIの表示/非表示を集約**する。現在は各所で個別に DOM を触っているはずなので、それをレジストリ側へ寄せる。
3. `registerMode` の引数に **`category` フィールドを1つ足しておく**(値は `walk` / `follow` / `ride` / `view` など)。今すぐ使わなくてよい。将来「歩く/追う/乗る/見る」の4分類UIを被せるための**安い保険**。

これをやっておくと、**「電車でGO」もアルバムも `registerMode` 1回で HUD に正しく現れる**ようになる。

---

## Phase 3(Phase 1・2 の実機確認後):モード切替シート

- `#modeBadge` をタップ → 下からシートが出て、登録済みモードの一覧から選べる。
- **`#perfCtrl` のポップオーバー実装をそのまま流用する**(新しいUI機構を作らない)。
- ここまでやると `#geoBtn` / `#routeBtn` を hudRail から外せる = **ボタンが2つ減る**。

---

## 完了判定

- Phase 1:
  1. GPS追従中も経路シム中も、**画面の同じ場所に1つだけ**バッジが出る。
  2. 線路ロックはサブ状態としてそのバッジ内に連結表示される。
  3. バッジをタップすると探索モードに戻る。
  4. **モードを何度も往復しても、古いバッジが残らない**(全参照を洗えている証拠)。
  5. スマホの縦・横どちらでもタップが効く。
- Phase 2:
  6. 試しにダミーのモードを `registerMode` すると、コードを他に足さなくてもバッジに正しく出る。
  7. 既存の GPS追従 / 経路シム / 線路ロックの挙動が一切変わっていない。
- 日本語・英語の両方で表示が崩れない(i18n 経由にすること)。
