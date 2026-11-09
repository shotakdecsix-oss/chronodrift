# 実装指示 2026-08-16 — 環境音（Web Audio による手続き合成）

対象ファイル: `js/core/audio.js`（**新規**）、`index.html`（script追加・設定UI追加）、`js/legacy/part9.js`（1行のフック）
**1 Phase = 1コミット。この指示以外のことは一切やらないこと。**

参照プロトタイプ: `PROTO_20260816_SFX.html`（同フォルダ）
→ **合成パラメータはこのファイルから丸ごと写すこと。** 音色を一から作り直さない。
ユーザーが実際に聞いて「いい感じ」と承認済みの数値である。

---

## 0. なぜこれをやるか（背景・判断の根拠）

このアプリは実地図・実地形の3D生成に開発コストを集中投下してきたが、**音が1バイトも無い**
（`grep -rn "AudioContext\|new Audio" js/ index.html` → 0件、2026-08-16 確認）。

音を足す価値がこの時点で高いと判断した理由:

1. **描画・生成パイプラインに一切触らずに没入感を上げられる唯一に近い領域。**
   水没・z-fighting・タイル停滞・GPUメモリといった既存の難所と物理的に別レイヤーにある。
2. **音声処理はブラウザが別スレッドで回すため、GPU/生成スレッドと競合しない。**
   `bMax`・`chunkR` などの負荷予算を1バイトも消費しない。
3. **音声ファイルを持たない**（すべて合成）ため、配信バイト数が増えない。
   Render無料枠・スマホ通信量への影響ゼロ。

---

## 1. 大原則（これを破ったら差し戻し）

| # | 原則 |
|---|---|
| A | **既存ファイルへの変更は「script1行 + 設定UI + animate1行」だけ。** `part1〜part10` のロジックを書き換えない（`part9.js` の1行フックのみ例外） |
| B | **既定は音OFF。** ユーザーが設定(⚙)で明示的にONにするまで `AudioContext` を作らない |
| C | **`AudioContext` の生成・`resume()` は必ずユーザー操作イベントの中で行う。** iOS/Safari は操作外では音を出せない |
| D | **同時発音数に必ずハード上限を置く。** 予算切れ時は「鳴らさない」で黙って捨てる（[[feedback_per_building_decoration_budget]] と同じ考え方：ゲートだけでなく実数の上限を持つ） |
| E | **既存の環境判定関数を新規実装しない。** 使う前に必ず `grep` で存在とシグネチャを確認する（[[feedback_search_existing_mechanism_before_reimplementing]]） |
| F | 音の状態を `localStorage` に保存する。キー接頭辞は既存に合わせて `isehara*` |

---

## 2. ファイル構成と読み込み

新規: `js/core/audio.js`
`js/core/mode-registry.js` と同じ方針の**純粋な追加ファイル**とする。

- classic script（ESモジュールにしない）
- `window.GameAudio` だけを公開
- **THREE にも本体のグローバル変数にも load 時点で依存しない**
  （環境値は呼び出し側から引数で渡す。audio.js からグローバルを読みに行かない）

`index.html` の script 追加位置は `mode-registry.js` の直後:

```html
<script src="js/core/mode-registry.js"></script>
<script src="js/core/audio.js"></script>   <!-- ← 追加 -->
<script src="js/lib/pure.js"></script>
```

---

## 3. 公開API（この形を守る）

```js
window.GameAudio = {
  // 設定(⚙)のトグルから、ユーザー操作イベントの中で呼ばれる。
  // 初回呼び出しで AudioContext を作り、音声グラフを組む。2回目以降は resume するだけ。
  enable(),

  // OFFにする。ctx.suspend() を呼ぶ（close はしない = 再ONを軽くする）
  disable(),

  // 0.0〜1.0。設定スライダーから呼ばれる
  setVolume(v),

  // 毎フレーム animate() から呼ばれる。dt は秒。
  // env は「今フレームの環境」。null を渡した場合は前回値を使い回す（サンプリング省略時）
  update(dt, env),

  // 単発。呼び出し側が明示的に鳴らしたい時に使う（将来の電車モード等）
  oneShot(name),        // 'carPass' | 'trainPass' | 'horn' | 'thunder' | 'crossingBell'

  // デバッグ: 現在の合成レベルと発音数を返す
  debug(),
};
```

`env` の形（**この5つだけ**。増やさない）:

```js
{
  seaDist:  Number,   // 海岸線までの距離(m)。海が無い/不明なら Infinity
  waterNear: Boolean, // 川・池が近いか
  forest:   0..1,     // 樹木の濃さ
  urban:    0..1,     // 市街地の濃さ
  surface:  'asphalt' | 'grass' | 'gravel' | 'water',  // 足元
}
```

---

## 4. Phase 1 — 骨格 + 波 + 風 + 足音（コミット1）

**ここまでで単独に価値が出る。Phase 2 以降は Phase 1 の実機確認後に着手する。**

### (4-1) 音声グラフの土台

`PROTO_20260816_SFX.html` の `build()` を写す。構成:

```
（各音源）→ master → DynamicsCompressor → destination
                  ↘ revIn → Convolver(手続き生成IR) → revOut(0.22) → master
```

- ノイズバッファ（white / pink / brown）は**起動時に一度だけ**生成して使い回す。
  毎回 `createBuffer` すると GC 圧になる
- インパルス応答も手続き生成（1.6秒・指数減衰）。**音声ファイルは使わない**

### (4-2) 波・風

プロトタイプの以下をそのまま移植:

- `waveOne(amt, when)` — 1回の波を「寄せる（ローパスを開く）→ 砕ける（広帯域の破裂）→ 引く（ハイパスの泡）」の3イベントで構成する。
  **この3段構造が「波に聞こえる」ことの本体である。** ノイズを LFO で揺らすだけの実装に簡略化してはいけない（v1で試して却下済み）
- 波のスケジューリング: `2.6 + rand*2.2 - amt*0.9` 秒間隔で次を仕込む（重なって連続に聞こえる）
- 風: 低域(brown+lowpass) + 共鳴の鋭いバンドパス(Q 4〜13) + 強風時のみ笛(Q16)。
  強さで `frequency` と `Q` を動かす

### (4-3) 足音 — 距離ベースで鳴らす（重要な設計判断）

速度変数を読むのではなく、**プレイヤーの水平移動距離を積算し、`STRIDE` メートル進むたびに1歩鳴らす。**

```js
// audio.js 内部
_footAcc += horizontalDistanceMovedThisFrame;
while (_footAcc >= STRIDE) { _footAcc -= STRIDE; this._footstep(); }
```

理由: この方式なら**歩行・GPS追従・経路シムの全モードで自動的に正しく鳴る。**
各モードの速度変数を個別に読む実装にすると、モードが増えるたびに漏れる。

ゲート（いずれかを満たしたら鳴らさない）:

| 条件 | 理由 |
|---|---|
| `airborne === true` | 空中では足音は鳴らない。`part7.js:1062` に既存の `airborne` がある |
| 水平速度 > 12 km/h | 乗り物で移動中。走りではなく車・電車と判断する |
| 高度ロック中（`altLocked`） | 上空を飛んでいる |

`STRIDE` は 0.78m、水平速度 8km/h 超では 1.35m（走りに切り替え）。
地表別のフィルタ係数はプロトタイプの `SURF` テーブルを写す。

### (4-4) `part9.js` へのフック — 追加は1行だけ

`animate()`（`js/legacy/part9.js:922`）の中、`ModeRegistry.update(dt)` の**直後**に:

```js
  if (window.GameAudio) GameAudio.update(dt, _audioEnv());
```

`_audioEnv()` は **`part9.js` にヘルパーとして新設**する（audio.js からグローバルを読ませないため）。

```js
// 【2026-08-16】環境音用の環境サンプリング。
// 毎フレームやると landuseTypeAt / isNearWater のポリゴン走査が無駄なので 250ms に1回だけ。
let _audioEnvCache = null, _audioEnvT = 0;
function _audioEnv() {
  const now = performance.now();
  if (_audioEnvCache && now - _audioEnvT < 250) return null;  // null = 前回値を使い回す
  _audioEnvT = now;
  const px = player.position.x, pz = player.position.z;
  // ... 下の (4-5) の通りに組み立てる
  _audioEnvCache = { seaDist, waterNear, forest, urban, surface };
  return _audioEnvCache;
}
```

### (4-5) 環境値の取り方 — 既存関数を使う。新規実装しない

**着手前に必ず `grep` で存在とシグネチャを確認すること。** 2026-08-16 時点の確認結果:

| 欲しい値 | 使う既存関数 | 場所 | 備考 |
|---|---|---|---|
| 海までの距離 | `coastGeomAt(x, z)` | `part4.js` | **存在を必ず確認。** 無ければ Phase 1 では `seaDist = Infinity` 固定にし、海の音は保留（`isNearWater` で代用しないこと。川と海が混ざる） |
| 川・池が近いか | `isNearWater(cx, cz, r)` | `part8.js:2096` | r は 60 程度 |
| 森の濃さ | `landuseTypeAt(x, z) === 'forest'` | `part1.js:953` | lu の実在値は `residential/commercial/industrial/retail/forest` のみ（確認済み） |
| 市街地の濃さ | `landuseTypeAt(x, z)` | 同上 | `commercial`/`retail` → 1.0、`industrial` → 0.7、`residential` → 0.5、それ以外 → 0.15 |
| 足元 | `isOnRoad(px, pz, 1, 1)` | `part2.js:972` | true → `'asphalt'`。次に `isNearWater` → `'water'`、`forest` → `'grass'`、既定 → `'grass'` |

**`forest` / `urban` は 0/1 でパタパタさせず、audio.js 側で目標値へ時定数 0.35 秒で寄せる**
（`setTargetAtTime`）。ポリゴンの境界を歩くたびに音が瞬断するのを防ぐ。

### (4-6) 予算（原則D）

```js
const MAX_VOICES = 24;     // 同時に生きている OscillatorNode / BufferSource の上限
```

- 音を1つ作るたびにカウンタ +1、`stop` 予定時刻に `setTimeout` で −1
- 上限に達している間は**新しい単発音を作らない**（黙って捨てる。キューに積まない）
- `GameAudio.debug()` で現在の発音数を返せるようにする

### (4-7) 設定UI（⚙パネル内）

既存の `#perfCtrl` パネル（`index.html:462`）に **新しいセクションを1つ追加**する。
既存セクションの体裁に合わせること。

- ON/OFF トグル 1つ、音量スライダー 1つ
- **イベント登録は必ず既存の `bindTapButton(el, handler)`（`part1.js:2203`）を使う。**
  `click` だけで書かない（横向き時に発火しない既知の不具合がある。`part1.js:2188` のコメント参照）
- 文言は `t()` の i18n テーブルに追加（`part1.js:235`）。日本語/英語の両方
- 保存: `localStorage` の `iseharaAudioOn`（`'1'`/`'0'`）、`iseharaAudioVol`（`'0'`〜`'100'`）
- **起動時に自動でONにしない。** 保存値が `'1'` でも、`AudioContext` は最初のユーザー操作まで作らない
  （保存値が ON なら「最初のタップで有効化する」フラグを立てておき、`document` の1回限りの
  `touchend`/`click` で `enable()` を呼ぶ）

### (4-8) タブ離脱で止める

```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden) GameAudio._suspend(); else GameAudio._resumeIfEnabled();
});
```

バッテリー対策であり、「裏で鳴り続ける」というプロトタイプで実際に起きた不具合の再発防止でもある。

---

## 5. Phase 2 — 雨・川・街・電車・踏切（コミット2）

**Phase 1 が実機確認できてから着手する。**

プロトタイプから移植する（合成の要点はコード内コメントとして残すこと）:

- **雨**: 高域ノイズ + 中域 + 粒（`drop()`）。粒の発生率は強さの2乗に比例させる（強いほど急に増える）
- **川**: 帯域ノイズ + 「ポコッ」（`bubble()` = 周波数が上に跳ねる正弦波）。`isNearWater` が true の時
- **街**: 低域の唸り + `carPass()` を確率的に。`carPass` はドップラー（周波数を下げる）と
  `StereoPanner`（左→右）を**同時に**やること。片方だけでは通過に聞こえない
- **電車 / 踏切**: 実装するが、Phase 2 では `GameAudio.oneShot()` からの手動呼び出しのみとする。
  線路の位置から自動発火させるのは Phase 3 以降（線路データの参照が必要で、スコープが広がる）

---

## 6. Phase 3 — BGM（コミット3、任意）

`PROTO_20260816_SFX.html` の BGM セクション（ラウンジ・ジャズ）を移植。
**Phase 1・2 が安定してから。** 別バス + 独立音量 + 効果音でのダッキングまでを含む。
着手前にユーザーに確認を取ること。

---

## 7. やらないこと（明示的にスコープ外）

- 音声ファイルの追加・ダウンロード（すべて合成）
- 影（シャドウマップ）・時刻連動の太陽など、描画側の変更
- 音を出すための `part1〜part10` のリファクタリング
- 音量の自動調整、イコライザ、空間音響（`PannerNode` の3D版）
- 線路データからの踏切・電車の自動発火（Phase 3 以降）

---

## 8. 検証手順

VM が使えないため、**PC の Chrome DevTools と実機（スマホ）の両方**で確認する。

### 実装直後（PC）

1. Console で `GameAudio.debug()` → `{levels:{...}, voices:N}` が返ること
2. 設定でONにして無音でないこと。OFFで完全に無音になること
3. **`voices` が 24 を超えないこと。** 歩き続けて 30 秒観察する
4. `performance.now()` ベースで、`_audioEnv()` の呼び出しが 250ms に1回に間引かれていること
   （フレームごとに `landuseTypeAt` を呼んでいたら間引きが効いていない）
5. 森 → 市街地 → 森 と歩いて、境界で音が瞬断しないこと（時定数が効いているか）

### 実機（スマホ）

6. **初回タップまで無音、タップ後に鳴り出す**こと（iOS の制約を満たしているか）
7. 横向きにして設定トグルが反応すること（`bindTapButton` を使っているか）
8. 別アプリに切り替えて戻る → 裏で鳴り続けていないこと
9. 音ON/OFFでフレームレートに差が出ないこと（⚙のFPS表示で比較）

### 回帰確認

10. 音OFFの状態で、既存の生成・移動・ジャンプが**一切変わっていない**こと。
    Phase 1 の変更は「script1行 + 設定UI + animate1行」だけなので、
    もし挙動が変わったらフックの位置が間違っている

---

## 9. コミットとデプロイ

Phase ごとに1コミット。実装したら毎回:

```
git add -A
git commit -m "feat(audio): Phase1 環境音の骨格・波・風・足音（Web Audio手続き合成、既定OFF）"
git push origin main
```

Render は `main` への push で自動デプロイされる。ダッシュボード操作は不要。

---

## 10. 判断に迷ったときの優先順位

1. **既存の生成パイプラインを壊さないこと** が音の質より常に優先
2. 音が鳴らないことより、**音が原因でクラッシュ・フレーム落ちすること**の方が悪い。迷ったら予算を絞る
3. 音色の良し悪しで迷ったら、プロトタイプの数値に従う。ユーザーが承認済みの音である
4. 新しい環境判定が必要になったと感じたら、**実装せずに一度止まって報告する。**
   既存関数で代替できる可能性が高い

---
*2026-08-16 作成。相談チャットでのプロトタイプ（`PROTO_20260816_SFX.html`）に基づく。*
