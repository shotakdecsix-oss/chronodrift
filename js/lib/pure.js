/**
 * js/lib/pure.js — THREE.js・scene・グローバルなゲーム状態に依存しない純粋関数群。
 * 【2026-07-17・CODE_REVIEW_20260717 P13-1】part1〜9.js(classicスクリプトの機械分割、
 * 全ファイルが同一グローバルスコープを共有)に散っていた「入力だけから出力が決まる」関数を
 * ここへ集約したもの。index.html でTHREE.js読み込み直後・part1.js読み込み前に読み込まれ、
 * 以降は従来どおりグローバル関数として全ファイルから参照できる(挙動・呼び出し方は不変)。
 * 目的: (1) 読みやすさ、(2) node:test 等でTHREE無しに単体テストできる土台
 * (CODE_REVIEW_20260717 P14参照)。移動元にはgrep用の一行コメントを残してある。
 */

// ハッシュベースの疑似乱数(0〜1)。座標などから決定的に値を作りたい場面で使う
// (Math.randomと違い同じ入力なら常に同じ値 → 再生成してもちらつかない)。
function _fhash(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177 | 0; return ((h ^ (h >> 16)) >>> 0) / 4294967296; }

// weights({key: 重み, ...})から1つキーを重み付き抽選する。タグ欠損時のフォールバック等に使用。
function pickWeighted(weights) {
  const keys = Object.keys(weights);
  const total = keys.reduce((s, k) => s + (weights[k] || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const k of keys) {
    r -= weights[k] || 0;
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

// 0xRRGGBB を係数fで乗算した明暗違いの色にする(壁色のティント・陰影表現に使用)。
function shadeHex(c, f) {
  const r = Math.min(255, ((c >> 16 & 255) * f) | 0),
        g = Math.min(255, ((c >> 8 & 255) * f) | 0),
        b = Math.min(255, ((c & 255) * f) | 0);
  return r << 16 | g << 8 | b;
}

// 経度を[-180, 180)に正規化する。
function wrapLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }

// 汎用のバイリニア補間。inRangeOnly=true のときは範囲外で null を返す(NEARの範囲外判定に使う)。
function sampleGrid(elev, cx, cz, w, d, segs, segs1, x, z, inRangeOnly) {
  if (!elev) return null;
  const nx = (x - cx + w / 2) / w * segs;
  const nz = (z - cz + d / 2) / d * segs;
  if (inRangeOnly && (nx < 0 || nx > segs || nz < 0 || nz > segs)) return null;
  const ix = Math.max(0, Math.min(segs - 1, Math.floor(nx)));
  const iz = Math.max(0, Math.min(segs - 1, Math.floor(nz)));
  const fx = Math.max(0, Math.min(1, nx - ix));
  const fz = Math.max(0, Math.min(1, nz - iz));
  const h00 = elev[ iz    * segs1 + ix    ];
  const h10 = elev[ iz    * segs1 + ix + 1];
  const h01 = elev[(iz+1) * segs1 + ix    ];
  const h11 = elev[(iz+1) * segs1 + ix + 1];
  return h00*(1-fx)*(1-fz) + h10*fx*(1-fz) + h01*(1-fx)*fz + h11*fx*fz;
}

// 点(px,pz)が多角形pts([{x,z},...])の内側にあるか(レイキャスト法)。
function pointInPolygon(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length-1; i < pts.length; j=i++) {
    const xi=pts[i].x, zi=pts[i].z, xj=pts[j].x, zj=pts[j].z;
    if (((zi>pz)!==(zj>pz)) && (px < (xj-xi)*(pz-zi)/(zj-zi)+xi)) inside=!inside;
  }
  return inside;
}

// 点(px,pz)から線分(x1,z1)-(x2,z2)までの距離の二乗(clamp-t方式)。
// 【2026-07-17・CODE_REVIEW_20260717 P9-1】roadNear/isOnRoad/nearMinorRoad/isNearWaterの
// 4箇所にほぼ同じ計算が重複していたのを1つの純関数に切り出したもの。
function distSqPointToSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const nx = x1 + dx * t - px, nz = z1 + dz * t - pz;
  return nx * nx + nz * nz;
}

// 頂点の間引き — 直前の採用点から tol[m] 未満の点をスキップ(大河川の負荷対策)。
function thinPts(pts, tol) {
  if (tol <= 0 || pts.length < 20) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    const dx = pts[i].x - last.x, dz = pts[i].z - last.z;
    if (dx * dx + dz * dz >= tol * tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ======= multipolygon 水面(相模川クラスの大河川)のリング組み立て =======
// 大きな水面はOSMでは relation(multipolygon) で表現され、outer が複数wayに
// 分割されていることが多い。端点一致で連結して閉リングを組み立てる。
function _llEq(a, b) { return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6; }
function stitchRings(members) {
  const segs = members.map(m => m.geometry.slice());
  const rings = [];
  while (segs.length) {
    let ring = segs.pop().slice();
    let guard = 0;
    while (guard++ < 500) {
      const head = ring[0], tail = ring[ring.length - 1];
      if (_llEq(head, tail)) break; // 閉じた
      let found = -1, rev = false, atEnd = true;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], sh = s[0], st = s[s.length - 1];
        if (_llEq(tail, sh)) { found = i; rev = false; atEnd = true;  break; }
        if (_llEq(tail, st)) { found = i; rev = true;  atEnd = true;  break; }
        if (_llEq(head, st)) { found = i; rev = false; atEnd = false; break; }
        if (_llEq(head, sh)) { found = i; rev = true;  atEnd = false; break; }
      }
      if (found < 0) break; // これ以上つながらない → 開いたまま採用(earcutは閉じ扱い)
      let s = segs.splice(found, 1)[0];
      if (rev) s = s.slice().reverse();
      ring = atEnd ? ring.concat(s.slice(1)) : s.concat(ring.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// 【2026-07-16】実OSM建物の寸法を、周囲の道路・線路リボンと重ならないよう中心を保ったまま
// 縮める際に使う窓関数。窓 |p(t)|<=win (t∈[0,1], p=ap+t*dp) 内での |q(t)| の最小値。
// 窓と交差しなければnull。呼び出し元(fitRealBuildingToRoads, part2.js)の数学部分のみ切り出し。
function _minAbsOverWindow(ap, aq, dp, dq, win) {
  let t0 = 0, t1 = 1;
  if (Math.abs(dp) > 1e-9) {
    const ta = (-win - ap) / dp, tb = (win - ap) / dp;
    t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb));
    if (t0 > t1) return null;
  } else if (Math.abs(ap) > win) return null;
  const q0 = aq + t0 * dq, q1 = aq + t1 * dq;
  if ((q0 <= 0 && q1 >= 0) || (q0 >= 0 && q1 <= 0)) return 0; // 符号反転=貫通
  return Math.min(Math.abs(q0), Math.abs(q1));
}

// OSMのbuilding:colour/roof:colourタグ(#rrggbb・#rgb・一部の色名)を数値カラーへ変換する。
// 未対応の表記は静かにnullを返し、既存の既定色にフォールバックする(タグ読み取りのみでコストはほぼゼロ)。
const OSM_COLOR_NAMES = {
  white: 0xf0f0ec, black: 0x202020, gray: 0x888888, grey: 0x888888,
  silver: 0xc0c0c0, red: 0xcc3333, green: 0x3a7a3a, blue: 0x3a5a9a,
  yellow: 0xe0c040, orange: 0xd88a30, brown: 0x8a6040, beige: 0xd8c8a0,
  tan: 0xd2b48c, cream: 0xf0e8d0, pink: 0xe8a0b0, purple: 0x7a4a9a,
  darkgray: 0x555555, darkgrey: 0x555555, lightgray: 0xcccccc, lightgrey: 0xcccccc,
  darkgreen: 0x2a5a2a, darkblue: 0x2a3a6a, darkred: 0x8a2222,
  cyan: 0x40b0c0, gold: 0xd4af37, ivory: 0xf0ead6, maroon: 0x7a2a2a,
  navy: 0x1a2a5a, olive: 0x707a30, bronze: 0x8a6a3a, copper: 0xb0684a,
};
function parseOsmColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^#[0-9a-f]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3];
    return parseInt(r + r + g + g + b + b, 16);
  }
  return OSM_COLOR_NAMES.hasOwnProperty(s) ? OSM_COLOR_NAMES[s] : null;
}

// waterway の実幅: width タグ優先、なければ種別から推定。
function waterwayWidth(tags) {
  const wtag = parseFloat(tags.width || tags['width:river'] || tags.est_width); // "5 m" 等も parseFloat で拾える
  if (wtag > 0) return Math.min(300, Math.max(1.5, wtag));
  switch (tags.waterway) {
    case 'river':  return 16;
    case 'canal':  return 5;
    case 'stream': return 2.5;
    default:       return 3;
  }
}

// 明治期(迅速測図)データのメッシュコード算出。
function meijiMeshCode(lat, lon) {
  const p = Math.floor(lat * 1.5), u = Math.floor(lon - 100);
  const q = Math.floor((lat * 1.5 - p) * 8), v = Math.floor(((lon - 100) - u) * 8);
  return { m1: '' + p + u, m2: '' + p + u + q + v };
}
