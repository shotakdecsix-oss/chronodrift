/**
 * js/core/shop-signs.js — 【2026-11-10・H-7】店の看板に実際の店名(OSMの name)を描く。
 *
 * 文字は1枚の共有アトラス(1024×1024。256×32の区画×128)に描き、看板の文字面は道路と同じ
 * セル単位の結合(road-batch.js)で描く。店が増えても描画コールはセルごとに1回。
 * 区画は「店名・地の色・縦横比」ごとに使い回し、参照が無くなった区画から再利用する
 * (足りない時は文字なしの帯だけになる)。文字は帯の縦横比に合わせて横に伸縮して描くので、
 * 帯に貼った時に元の字形に戻る。主なチェーン店は実際に近い地の色・文字色にする(ロゴは描かない)。
 */
const SIGN_COLS = 4, SIGN_ROWS = 32, SIGN_SW = 256, SIGN_SH = 32;
const SIGN_KINDS = new Set(['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bank', 'pharmacy', 'post_office',
  'karaoke_box', 'cinema', 'clinic', 'dentist', 'doctors', 'ice_cream', 'internet_cafe', 'car_rental', 'veterinary']);
const AWNING_COLORS = [0x2e7d32, 0xc62828, 0x1565c0, 0xf9a825, 0x6d4c41, 0x00838f];
const SIGN_BRANDS = [
  [/セブン.?イレブン|7-eleven/i, '#ffffff', '#e8541a'], [/ファミリーマート|ファミマ/, '#0e9a48', '#ffffff'],
  [/ローソン|lawson/i, '#0068b7', '#ffffff'], [/ミニストップ/, '#1d3f8f', '#ffd800'],
  [/デイリーヤマザキ|ヤマザキショップ/, '#e60012', '#ffffff'], [/マクドナルド/, '#da291c', '#ffc72c'],
  [/すき家/, '#e60012', '#ffffff'], [/吉野家/, '#f39800', '#4a2508'], [/松屋/, '#ffd400', '#003f8e'],
  [/スターバックス|starbucks/i, '#00704a', '#ffffff'], [/ドトール/, '#ffe200', '#3d2b1f'],
  [/郵便局/, '#e60012', '#ffffff'], [/銀行|信用金庫|信金/, '#1b3a6b', '#ffffff'],
];
const SIGN_FONT = 'bold 24px "Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif';
const _signCanvas = document.createElement('canvas');
_signCanvas.width = SIGN_COLS * SIGN_SW; _signCanvas.height = SIGN_ROWS * SIGN_SH;
const _signCtx = _signCanvas.getContext('2d');
const SIGN_TEX = new THREE.CanvasTexture(_signCanvas);
SIGN_TEX.anisotropy = 4;
const SIGN_MAT = new THREE.MeshBasicMaterial({ map: SIGN_TEX, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
const _signSlots = new Map(); // key → { i, ref }
const _signFree = [];         // 参照0になった区画のキー(古い順)
let _signNext = 0, _signDirty = false, _signLastUp = 0;
const _signBandMats = new Map();
const _signStat = { panels: 0, full: 0 };

function signBrand(name) {
  if (!name) return null;
  for (const b of SIGN_BRANDS) if (b[0].test(name)) return { bg: b[1], fg: b[2] };
  return null;
}
// ブランド色の帯(bldg-batchの汎用経路で色ごとにまとまる)
function signBandMat(css) {
  let m = _signBandMats.get(css);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(css) }); _signBandMats.set(css, m); }
  return m;
}
function _signDraw(i, name, bg, fg, A) {
  const x0 = (i % SIGN_COLS) * SIGN_SW, y0 = Math.floor(i / SIGN_COLS) * SIGN_SH, g = _signCtx;
  g.save();
  g.fillStyle = bg; g.fillRect(x0, y0, SIGN_SW, SIGN_SH);
  g.beginPath(); g.rect(x0, y0, SIGN_SW, SIGN_SH); g.clip();
  g.font = SIGN_FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fg;
  const sx = (SIGN_SW / SIGN_SH) / A;                        // 帯の縦横比に合わせた横の伸縮
  const k = Math.min(1, (SIGN_SW - 14) / Math.max(1, g.measureText(name).width * sx));
  g.translate(x0 + SIGN_SW / 2, y0 + SIGN_SH / 2 + 1);
  g.scale(sx * k, k);
  g.fillText(name, 0, 0);
  g.restore();
  _signDirty = true;
}
function _signAlloc(name, bg, fg, A) {
  const key = name + '|' + bg + '|' + fg + '|' + A;
  let s = _signSlots.get(key);
  if (s) {
    if (s.ref === 0) { const j = _signFree.indexOf(key); if (j >= 0) _signFree.splice(j, 1); }
    s.ref++;
    return { key, i: s.i };
  }
  let i;
  if (_signNext < SIGN_COLS * SIGN_ROWS) i = _signNext++;
  else if (_signFree.length) { const old = _signFree.shift(); i = _signSlots.get(old).i; _signSlots.delete(old); }
  else { _signStat.full++; return null; }
  _signSlots.set(key, { i, ref: 1 });
  _signDraw(i, name, bg, fg, A);
  return { key, i };
}
function _signRelease(key) {
  const s = _signSlots.get(key);
  if (!s || s.ref <= 0) return;
  if (--s.ref === 0) _signFree.push(key);
}
// 文字面を出す場所(看板の帯ごとに1つ)。区画には限りがあるので、プレイヤーに近い所から順に文字面を付け、
// 離れた所の文字面は外して区画を空ける(signsUpdate)。文字面は建物の部品配列にも入れ、地形追従(Y移動)と解放に乗せる
const SIGN_RANGE = 300, SIGN_MAX = 112, SIGN_PER_UPDATE = 24;
const _signSites = new Set();
let _signLastAssign = 0;
function signAddSite(name, bg, fg, cx, cz, nx, nz, W, H, band, parts) {
  if (typeof bg !== 'string') bg = '#' + bg.getHexString();
  const site = { name, bg, fg, cx, cz, nx, nz, W, H, band, parts, panel: null, d2: 0 };
  _signSites.add(site);
  band.addEventListener('removed', () => { _signSites.delete(site); _signDrop(site); });
  _signLastAssign = 0; // 次のフレームで割り当て直す
  return site;
}
function _signMake(site) {
  const A = Math.max(3, Math.min(17, Math.round(site.W / site.H)));
  const s = _signAlloc(site.name, site.bg, site.fg, A);
  if (!s) return false;
  const { cx, cz, nx, nz, W, H } = site, y = site.band.position.y;
  const col = s.i % SIGN_COLS, row = Math.floor(s.i / SIGN_COLS);
  const eu = 0.5 / _signCanvas.width, ev = 0.5 / _signCanvas.height;
  const u0 = col / SIGN_COLS + eu, u1 = (col + 1) / SIGN_COLS - eu;
  const v1 = 1 - row / SIGN_ROWS - ev, v0 = 1 - (row + 1) / SIGN_ROWS + ev;
  const rx = nz * W / 2, rz = -nx * W / 2, hh = H / 2; // 外から見た右方向 = up × n
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([cx - rx, y - hh, cz - rz, cx + rx, y - hh, cz + rz, cx + rx, y + hh, cz + rz, cx - rx, y + hh, cz - rz]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const p = rbMakePart(g, SIGN_MAT, cx, cz);
  p.renderOrder = 2;
  p.userData.noRot = true;
  p.addEventListener('removed', () => { _signRelease(s.key); _signStat.panels--; if (site.panel === p) site.panel = null; });
  scene.add(p);
  site.parts.push(p);
  site.panel = p;
  _signStat.panels++;
  return true;
}
function _signDrop(site) {
  const p = site.panel;
  if (!p) return;
  site.panel = null;
  const j = site.parts.indexOf(p);
  if (j >= 0) site.parts.splice(j, 1);
  if (p.parent) p.parent.remove(p);
  p.geometry.dispose();
}
// 毎フレーム(part9.js、rbUpdateの隣): 0.4秒ごとに近い順で文字面を付け外しし、描き足した区画をまとめて転送する
function signsUpdate() {
  const now = performance.now();
  if (now - _signLastAssign > 400 && _signSites.size) {
    _signLastAssign = now;
    const px = player.position.x, pz = player.position.z, R2 = SIGN_RANGE * SIGN_RANGE;
    const near = [];
    for (const s of _signSites) {
      const dx = s.cx - px, dz = s.cz - pz;
      s.d2 = dx * dx + dz * dz;
      if (s.d2 <= R2) near.push(s); else if (s.panel) _signDrop(s);
    }
    near.sort((a, b) => a.d2 - b.d2);
    for (let i = SIGN_MAX; i < near.length; i++) if (near[i].panel) _signDrop(near[i]);
    let made = 0, miss = 0;
    for (let i = 0; i < near.length && i < SIGN_MAX && made < SIGN_PER_UPDATE; i++) {
      if (near[i].panel) continue;
      if (_signMake(near[i])) made++; else miss++;
    }
    _signStat.full = miss;
  }
  if (!_signDirty || now - _signLastUp < 250) return;
  _signLastUp = now; _signDirty = false;
  SIGN_TEX.needsUpdate = true;
}
function signsStats() { return '看板 ' + _signStat.panels + '/' + _signSites.size + '面 区画' + _signSlots.size + '/' + (SIGN_COLS * SIGN_ROWS) + (_signStat.full ? ' 不足' + _signStat.full : ''); }
