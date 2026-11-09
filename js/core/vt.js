/**
 * js/core/vt.js — 【2026-11-09・B-2(docs/CODE_REVIEW_20261109_ZEROBASE.md)】
 * 地図データの一次ソースを Overpass から ベクタータイル(OpenFreeMap / OpenMapTilesスキーマ / z14)
 * へ切り替えるアダプタ。
 *
 * 【なぜ】Overpassの公開インスタンスが慢性的に混雑し(504・タイムアウト・接続拒否が常態化)、
 *   タイル取得待ちで道路・建物の描写範囲の広がりが止まっていた。ベクタータイルはCDN配信の
 *   静的ファイルで、z14の1枚(約2km四方)が0.3〜1秒で届く。
 * 【方式】z14タイルをデコードし、Overpassの `out geom` 応答と同じ形の要素
 *   (type/id/tags/geometry/bounds、穴あき水面はrelation+members)へ変換して、既存の
 *   processTileData(part8.js)へそのまま渡す。描画ロジックは変えない。
 *   タグはOverpass経路のクエリ(OSM_TILE_CLAUSES)で取得していた範囲に揃える。
 * 【切り戻し】URLに ?osm=overpass を付けると従来どおりOverpassのみ。ベクタータイルの取得に
 *   失敗したバッチは自動で従来経路(IndexedDBキャッシュ→Overpass)へフォールバックする
 *   (3回連続で失敗したら5分間はOverpassのみ)。
 * 【タイル境界】MVTは各タイルの図形が「タイル+バッファ(64/4096)」で切り取られている。
 *   - 線(道路・線路・水路): タイル本体の矩形でクリップし、隣の断片と境界上で接する形にする。
 *     橋・トンネルは境界で切れると高さ補間・長さ判定が狂うため、隣の断片と繋いだ全体の情報
 *     (vtBridgeChain / vtTunnelLen)を要素に添える(part8.js processTileData側で参照)。
 *   - 面(水面・土地利用): タイル本体の矩形でクリップ(隣と重ならない)。
 *   - 建物: 切らずに丸ごと扱い、重心のあるタイルが担当する。バッファでも切れている大型建物は
 *     隣のタイルの断片と合成して1棟に戻す(東・南の境界は自タイル、西・北は隣が担当)。
 *     building:part(hide_3d付き外形の内側の部品)は外形の高さ補完にだけ使う
 *     (Overpass経路と同じく外形を描く。部品の積層表示はH-2で扱う)。
 *   - 海: ocean面の辺(タイル境界上の辺を除く)を natural=coastline の線として渡す。MVTの
 *     リング向き(外周=画面座標で時計回り)は「陸が左・海が右」のOSM海岸線規約とそのまま一致する。
 * 【ID】合成ID = 1e15 + (x*16384+y)*1e6 + 連番。実OSMのIDと衝突せず、同じタイルからは毎回
 *   同じIDになる(processTileDataのseenOSMWaysによる重複排除・再取得がそのまま効く)。
 */
const VT_ON = (typeof location === 'undefined') || !/[?&]osm=overpass/.test(location.search);
const VT_Z = 14, VT_N = 16384, VT_E = 4096;   // z14 / 2^14 / 座標は全レイヤーextent 4096基準に正規化
const VT_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const VT_TPL_KEY = 'iseharaVtTpl', VT_TPL_TTL_MS = 6 * 3600 * 1000;
const VT_FETCH_TIMEOUT_MS = 30000; // スマホは描画・変換でメインスレッドが詰まり応答処理が遅れるので長め
const VT_LRU = 16, VT_LRU_BYTES = 6 * 1048576; // 変換済みタイルの保持上限(枚数/元データ量。東京駅級の密集地は1枚0.7MB→変換後数MB)
const VT_AUX_MAX = 64;        // 隣接タイルの継ぎ目情報(建物断片・橋/トンネル断片だけ。小さい)の保持数
const VT_BLDG_BUFFER = 64;    // OpenMapTiles(planetiler)のbuildingレイヤーのバッファ(4px=64/4096)
const VT_LAYERS = new Set(['transportation', 'building', 'water', 'waterway', 'landcover', 'landuse', 'poi']);
const vtStats = { batches: 0, tiles: 0, aux: 0, bytes: 0, fetchMs: 0, convMs: 0, fail: 0, retry: 0, fallback: 0, merged: 0, chains: 0, lastErr: '' };
let _vtDownUntil = 0, _vtFailStreak = 0;
// 失敗したタイルはまずベクタータイルで取り直し、同じタイルで3回続けて失敗した時だけOverpassへ回す
// (part8.js fetchOSMTileBatch)。Overpassは慢性的に混雑していて、すぐ切り替えるとかえって遅くなるため。
const _vtTileFails = new Map();
function vtUsable() { return VT_ON && Date.now() >= _vtDownUntil; }
function vtNoteFail(k) { const n = (_vtTileFails.get(k) || 0) + 1; _vtTileFails.set(k, n); if (_vtTileFails.size > 4000) _vtTileFails.clear(); return n; }
function vtNoteOk(k) { _vtTileFails.delete(k); }

// ---------------------------------------------------------------- 取得
let _vtTplP = null, _vtTplAt = 0;
async function _vtFetch(url, json) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), VT_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 204 || r.status === 404) return { status: r.status, data: null };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { status: r.status, data: json ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  } finally { clearTimeout(to); }
}
// タイルURLのテンプレート(版ごとにパスが変わるのでTileJSONから引く。localStorageに6時間保持)
function _vtTemplate(force) {
  if (_vtTplP && !force) return _vtTplP;
  const p = (async () => {
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(VT_TPL_KEY) || 'null');
        if (c && c.url && Date.now() - c.t < VT_TPL_TTL_MS) { _vtTplAt = c.t; return c.url; }
      } catch (e) {}
    }
    const r = await _vtFetch(VT_TILEJSON_URL, true);
    const url = r.data && r.data.tiles && r.data.tiles[0];
    if (!url) throw new Error('TileJSON: tiles missing');
    _vtTplAt = Date.now();
    try { localStorage.setItem(VT_TPL_KEY, JSON.stringify({ url, t: _vtTplAt })); } catch (e) {}
    return url;
  })();
  _vtTplP = p;
  p.catch(() => { if (_vtTplP === p) _vtTplP = null; });
  return p;
}

// ---------------------------------------------------------------- MVTデコード
let _vb = null, _vp = 0;
const _vtTD = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;
function _rv() { // varint(2^53まで)
  let b = _vb[_vp++];
  if (b < 0x80) return b;
  let r = b & 0x7f, m = 128;
  for (;;) { b = _vb[_vp++]; r += (b & 0x7f) * m; if (b < 0x80) return r; m *= 128; }
}
function _vtSkip(w) {
  if (w === 0) _rv(); else if (w === 1) _vp += 8; else if (w === 2) { const l = _rv(); _vp += l; } else if (w === 5) _vp += 4;
  else throw new Error('MVT: wire type ' + w);
}
function _vtStr(len) { const s = _vtTD.decode(_vb.subarray(_vp, _vp + len)); _vp += len; return s; }
function _vtValue(end) {
  let v = null;
  while (_vp < end) {
    const t = _rv(), f = t >> 3;
    if (f === 1) v = _vtStr(_rv());
    else if (f === 2) { v = new DataView(_vb.buffer, _vb.byteOffset + _vp, 4).getFloat32(0, true); _vp += 4; }
    else if (f === 3) { v = new DataView(_vb.buffer, _vb.byteOffset + _vp, 8).getFloat64(0, true); _vp += 8; }
    else if (f === 4 || f === 5) v = _rv();
    else if (f === 6) { const z = _rv(); v = (z % 2) ? -(z + 1) / 2 : z / 2; }
    else if (f === 7) v = !!_rv();
    else _vtSkip(t & 7);
  }
  return v;
}
// 図形: MoveToごとに1パート([x0,y0,x1,y1,...])。ClosePathは暗黙(リングは始点を繰り返さない)
function _vtGeom(end, s) {
  const parts = []; let x = 0, y = 0, cur = null;
  while (_vp < end) {
    const c = _rv(), id = c & 7, n = c >> 3;
    if (id !== 1 && id !== 2) continue;
    if (id === 1 || !cur) { cur = []; parts.push(cur); }
    for (let k = 0; k < n; k++) {
      const dx = _rv(), dy = _rv();
      x += (dx >>> 1) ^ -(dx & 1); y += (dy >>> 1) ^ -(dy & 1);
      cur.push(x * s, y * s);
    }
  }
  return parts;
}
// → { レイヤー名: [{ type(1点/2線/3面), props, parts }] }(wantのレイヤーだけ)
const _VT_AUX_LAYERS = new Set(['transportation', 'waterway', 'building']);
function _vtDecode(buf, want) {
  want = want || VT_LAYERS;
  _vb = buf; _vp = 0;
  const layers = {};
  try {
    while (_vp < buf.length) {
      const t = _rv();
      if ((t >> 3) !== 3 || (t & 7) !== 2) { _vtSkip(t & 7); continue; }
      const len = _rv(), end = _vp + len; // 長さのvarintを読んでから足す(同じ式の中で読むと読む前の位置を足してしまう)
      let name = '', extent = 4096;
      const keys = [], vals = [], fr = [];
      while (_vp < end) {
        const t2 = _rv(), f = t2 >> 3;
        if (f === 1) name = _vtStr(_rv());
        else if (f === 2) { const l = _rv(); fr.push(_vp, _vp + l); _vp += l; }
        else if (f === 3) keys.push(_vtStr(_rv()));
        else if (f === 4) { const l = _rv(); vals.push(_vtValue(_vp + l)); }
        else if (f === 5) extent = _rv();
        else _vtSkip(t2 & 7);
      }
      if (want.has(name)) {
        const s = VT_E / extent, feats = [];
        for (let i = 0; i < fr.length; i += 2) {
          _vp = fr[i];
          const fe = fr[i + 1], props = {};
          let type = 0, parts = null;
          while (_vp < fe) {
            const t3 = _rv(), f = t3 >> 3;
            if (f === 2) { const l = _rv(), te = _vp + l; while (_vp < te) { const k = _rv(), v = _rv(); props[keys[k]] = vals[v]; } }
            else if (f === 3) type = _rv();
            else if (f === 4) { const l = _rv(); parts = _vtGeom(_vp + l, s); }
            else _vtSkip(t3 & 7); // id(1)は使わない(建物等はタイル側で統合されIDが無い)
          }
          if (parts && parts.length) feats.push({ type, props, parts });
        }
        layers[name] = feats;
      }
      _vp = end;
    }
  } finally { _vb = null; }
  return layers;
}

// ---------------------------------------------------------------- 幾何
// 座標系: タイル内ローカル(0..4096、バッファ部は範囲外)/全球グローバル(=x*4096+ローカル)
function _vtLL(gx, gy) {
  const k = VT_N * VT_E;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / k))) * 180 / Math.PI, lon: gx / k * 360 - 180 };
}
function _vtLon2X(lon) { return Math.floor((lon + 180) / 360 * VT_N); }
function _vtLat2Y(lat) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * VT_N); }
// 面積(測量士の公式)。MVTの外周リングは正、穴は負
function _vtArea(r) {
  let a = 0;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a / 2;
}
function _vtPolys(parts) { // → [[外周, 穴, 穴...], ...]
  const polys = []; let cur = null;
  for (const r of parts) {
    if (r.length < 6) continue;
    const a = _vtArea(r);
    if (a > 0) { cur = [r]; polys.push(cur); } else if (a < 0 && cur) cur.push(r);
  }
  return polys;
}
function _vtPip(x, y, r) {
  let c = false;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const yi = r[i + 1], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < (r[j] - r[i]) * (y - yi) / (yj - yi) + r[i]) c = !c;
  }
  return c;
}
function _vtSnap(v) { return (v > -1e-7 && v < 1e-7) ? 0 : (v > VT_E - 1e-7 && v < VT_E + 1e-7) ? VT_E : v; }
// 線分をタイル本体[0,4096]²でクリップ(スラブ法)。→ [ax,ay,bx,by] / null。境界上の座標は厳密に0/4096へ寄せる
// (隣のタイルが計算する同じ点とグローバル座標で一致させるため)
function _vtClipSeg(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  if (dx === 0) { if (x0 < 0 || x0 > VT_E) return null; }
  else {
    let a = -x0 / dx, b = (VT_E - x0) / dx;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return null;
  }
  if (dy === 0) { if (y0 < 0 || y0 > VT_E) return null; }
  else {
    let a = -y0 / dy, b = (VT_E - y0) / dy;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return null;
  }
  if (t0 === t1 && (dx !== 0 || dy !== 0)) return null; // 角で接するだけ
  return [_vtSnap(x0 + dx * t0), _vtSnap(y0 + dy * t0), _vtSnap(x0 + dx * t1), _vtSnap(y0 + dy * t1)];
}
function _vtClipLine(p) { // 折れ線 → タイル本体に収まる折れ線の配列
  const out = []; let cur = null;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const s = _vtClipSeg(p[i], p[i + 1], p[i + 2], p[i + 3]);
    if (!s) { if (cur) { out.push(cur); cur = null; } continue; }
    if (cur && cur[cur.length - 2] === s[0] && cur[cur.length - 1] === s[1]) cur.push(s[2], s[3]);
    else { if (cur) out.push(cur); cur = s; }
  }
  if (cur) out.push(cur);
  return out;
}
function _vtClipRing(r) { // Sutherland–Hodgman(向きは保存される)
  let pts = r;
  for (let e = 0; e < 4; e++) {
    const n = pts.length;
    if (n < 6) return null;
    const o = [], onX = e < 2, hiSide = (e & 1) === 1, lim = hiSide ? VT_E : 0;
    const ins = (x, y) => { const v = onX ? x : y; return hiSide ? v <= VT_E : v >= 0; };
    let px = pts[n - 2], py = pts[n - 1], pin = ins(px, py);
    for (let i = 0; i < n; i += 2) {
      const cx = pts[i], cy = pts[i + 1], cin = ins(cx, cy);
      if (cin !== pin) {
        if (onX) o.push(lim, py + (cy - py) * ((lim - px) / (cx - px)));
        else o.push(px + (cx - px) * ((lim - py) / (cy - py)), lim);
      }
      if (cin) o.push(cx, cy);
      px = cx; py = cy; pin = cin;
    }
    pts = o;
  }
  return pts.length >= 6 ? pts : null;
}
function _vtG(T, r) { // ローカル → グローバル
  const g = new Array(r.length);
  for (let i = 0; i < r.length; i += 2) { g[i] = T.gx0 + r[i]; g[i + 1] = T.gy0 + r[i + 1]; }
  return g;
}
function _vtWay(id, g, closed, tags) { // グローバル座標列 → Overpass形式のway
  const geom = new Array(g.length / 2);
  let a = 90, b = 180, c = -90, d = -180;
  for (let i = 0, k = 0; i < g.length; i += 2, k++) {
    const p = _vtLL(g[i], g[i + 1]);
    geom[k] = p;
    if (p.lat < a) a = p.lat; if (p.lat > c) c = p.lat; if (p.lon < b) b = p.lon; if (p.lon > d) d = p.lon;
  }
  if (closed && geom.length) { const f = geom[0], l = geom[geom.length - 1]; if (f.lat !== l.lat || f.lon !== l.lon) geom.push(f); }
  return { type: 'way', id, tags, geometry: geom, bounds: { minlat: a, minlon: b, maxlat: c, maxlon: d } };
}
function _vtCtx(x, y) {
  const latC = _vtLL(x * VT_E + VT_E / 2, y * VT_E + VT_E / 2).lat;
  const base = 1e15 + (x * VT_N + y) * 1e6;
  let seq = 0;
  return {
    x, y, gx0: x * VT_E, gy0: y * VT_E, clip: [],
    mpu: 40075016.686 * Math.cos(latC * Math.PI / 180) / (VT_N * VT_E), // 1ローカル単位のメートル
    id: () => base + (seq++), mid: (k) => base + 900000 + k,
  };
}

// ---------------------------------------------------------------- タグ変換(Overpass経路の取得範囲に揃える)
const _VT_LINKABLE = { motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 1 };
function _vtRoadTags(p) {
  const c = p.class;
  if (!c || c.endsWith('_construction') || p.indoor === 1 || p.indoor === true) return null;
  let t;
  if (c === 'rail') { if (p.subclass !== 'rail') return null; t = { railway: 'rail' }; }
  else if (c === 'path') t = { highway: p.subclass || 'path' };
  else if (c === 'minor') t = { highway: 'residential' }; // unclassified/residential/living_street/road の統合クラス
  else if (_VT_LINKABLE[c]) t = { highway: p.ramp ? c + '_link' : c };
  else if (c === 'service' || c === 'track' || c === 'raceway' || c === 'busway' || c === 'bus_guideway') t = { highway: c };
  else return null; // transit(地下鉄・路面電車)・ferry・aerialway等はOverpass経路でも取得していない
  if (p.brunnel === 'bridge') t.bridge = 'yes'; else if (p.brunnel === 'tunnel') t.tunnel = 'yes'; else if (p.brunnel === 'ford') t.ford = 'yes';
  if (p.layer) t.layer = String(p.layer);
  if (p.oneway === 1) t.oneway = 'yes'; else if (p.oneway === -1) t.oneway = '-1';
  if (p.surface === 'paved' || p.surface === 'unpaved') t.surface = p.surface;
  if (p.service) t.service = p.service;
  return t;
}
function _vtWaterwayTags(p) {
  const c = p.class;
  if (c !== 'river' && c !== 'stream' && c !== 'canal') return null; // ditch/drainは取得対象外(Overpass経路と同じ)
  const t = { waterway: c };
  if (p.brunnel === 'tunnel') t.tunnel = 'culvert'; else if (p.brunnel === 'bridge') t.bridge = 'aqueduct';
  if (p.intermittent === 1) t.intermittent = 'yes';
  return t;
}
function _vtWaterTags(p) {
  const c = p.class;
  if (c === 'ocean' || c === 'swimming_pool' || p.brunnel === 'tunnel') return null; // 海は海岸線として別処理
  const t = { natural: 'water' };
  if (c === 'river' || c === 'lake' || c === 'pond') t.water = c;
  if (p.intermittent === 1) t.intermittent = 'yes';
  return t;
}
const _VT_LANDCOVER = {
  farmland: ['landuse', 'farmland'], orchard: ['landuse', 'orchard'], meadow: ['landuse', 'meadow'],
  allotments: ['landuse', 'allotments'], forest: ['landuse', 'forest'], wood: ['natural', 'wood'],
  park: ['leisure', 'park'], garden: ['leisure', 'garden'],
};
const _VT_LANDUSE = {
  residential: ['landuse', 'residential'], commercial: ['landuse', 'commercial'], industrial: ['landuse', 'industrial'],
  retail: ['landuse', 'retail'], school: ['amenity', 'school'], university: ['amenity', 'university'],
  college: ['amenity', 'college'], hospital: ['amenity', 'hospital'], playground: ['leisure', 'playground'],
};
function _vtLandcoverTags(p) { const m = _VT_LANDCOVER[p.subclass]; return m ? { [m[0]]: m[1] } : null; }
function _vtLanduseTags(p) { const m = _VT_LANDUSE[p.class]; return m ? { [m[0]]: m[1] } : null; }
// POI → 建物へ付けるタグ。[優先度, タグ, タグは小さな建物だけ(店構え等), 大きな建物でも建物名にしてよい]
// 大型ビルは中のテナント(コンビニ等)の名前を建物名にしない(近くの場所表示が「ファミリーマート」になるのを防ぐ)。
// ※ベクタータイルの建物レイヤーには建物自体の名前が無いので、名前はPOIからしか得られない。
const _VT_SHOP_CLS = new Set(['shop', 'grocery', 'alcohol_shop', 'bakery', 'butcher', 'clothing_store', 'florist',
  'furniture', 'garden_centre', 'gift', 'hairdresser', 'jewelry', 'laundry', 'mobile_phone', 'music', 'optician',
  'pet', 'shoe', 'car', 'bicycle', 'books', 'stationery', 'toys', 'electronics', 'hardware', 'convenience', 'supermarket']);
const _VT_FOOD_CLS = new Set(['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'ice_cream', 'pharmacy']);
const _VT_NAME_CLS = new Set(['lodging', 'museum', 'library', 'theatre', 'cinema', 'stadium', 'town_hall', 'castle']); // art_galleryは屋外の銅像等(artwork)も含むので除外
function _vtPoiRole(p) {
  const c = p.class, s = p.subclass;
  if (c === 'place_of_worship') return [5, { amenity: 'place_of_worship', religion: s }, true, false]; // subclass=宗教(shinto/buddhist...)
  if (c === 'school' && (s === 'school' || s === 'university' || s === 'college')) return [4, { amenity: s }, false, true];
  if (c === 'college' || c === 'university') return [4, { amenity: c }, false, true];
  if (c === 'hospital' && s === 'hospital') return [4, { amenity: 'hospital' }, false, true];
  if (c === 'town_hall' && s === 'townhall') return [3, { amenity: 'townhall' }, false, true];
  if (c === 'police' || c === 'fire_station') return [3, { amenity: c }, false, true];
  if (s === 'mall' || s === 'department_store') return [3, { shop: s }, true, true];
  if (_VT_NAME_CLS.has(c)) return [3, null, false, true];
  if (_VT_SHOP_CLS.has(c)) return [2, { shop: s || c }, true, false];
  if (_VT_FOOD_CLS.has(c)) return [2, { amenity: s || c, shop: 'yes' }, true, false];
  return [1, null, false, false];
}
// render_height(=OpenMapTilesの高さ。height、無ければ階数×3.66の切り上げ、どちらも無ければ5)を
// ゲームのタグへ戻す。階数由来の値は building:levels に復元し、ゲーム側の「1階=3m」の慣習と窓の段数に合わせる。
function _vtHeightTags(t, h) {
  if (!(h > 0) || h === 5) return 0; // 5は「高さ情報なし」の既定値
  for (let L = 1; L <= 300; L++) {
    const v = Math.ceil(L * 3.66);
    if (v === h) { t['building:levels'] = String(L); return L; }
    if (v > h) break;
  }
  t['building:height'] = String(h);
  return Math.max(1, Math.round(h / 3));
}

// ---------------------------------------------------------------- レイヤー変換
function _vtEnd(T, lx, ly) { // 線の端点。タイル境界上なら隣のタイルのキーを持つ(=継ぎ目)
  let nb = null;
  if (lx === 0) nb = (T.x - 1) + '/' + T.y; else if (lx === VT_E) nb = (T.x + 1) + '/' + T.y;
  else if (ly === 0) nb = T.x + '/' + (T.y - 1); else if (ly === VT_E) nb = T.x + '/' + (T.y + 1);
  return { gx: T.gx0 + lx, gy: T.gy0 + ly, nb };
}
function _vtLines(T, feats, mapFn, out, pieces) {
  for (const f of feats) {
    if (f.type !== 2) continue;
    const tags = mapFn(f.props);
    if (!tags) continue;
    const tn = !!(tags.tunnel && tags.tunnel !== 'no'), br = tags.bridge === 'yes' && !!tags.highway;
    const road = tags.highway || (tags.railway ? 'rail' : 'ww:' + tags.waterway);
    if (!out && !tn && !br) continue; // 隣接タイルの継ぎ目情報だけ欲しい時(_vtLoadAux)
    for (const part of f.parts) for (const s of _vtClipLine(part)) {
      const el = _vtWay(T.id(), _vtG(T, s), false, Object.assign({}, tags));
      if (out) out.push(el);
      if (tn || br) {
        const n = s.length;
        let len = 0;
        for (let i = 2; i < n; i += 2) len += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
        pieces.push({ el, kind: br ? 'b' : 't', road, len: len * T.mpu, ends: [_vtEnd(T, s[0], s[1]), _vtEnd(T, s[n - 2], s[n - 1])] });
      }
    }
  }
}
function _vtAreas(T, feats, mapFn, out, holes) {
  for (const f of feats) {
    if (f.type !== 3) continue;
    const tags = mapFn(f.props);
    if (!tags) continue;
    for (const poly of _vtPolys(f.parts)) {
      // 穴あき(=OSMではrelation)の土地利用はOverpass経路でも取得していなかったので出さない
      if (poly.length > 1 && !holes) continue;
      const o = _vtClipRing(poly[0]);
      if (!o || Math.abs(_vtArea(o)) < 16) continue;
      const ow = _vtWay(T.id(), _vtG(T, o), true, Object.assign({}, tags));
      const members = [];
      for (let k = 1; k < poly.length; k++) {
        const h = _vtClipRing(poly[k]);
        if (h && Math.abs(_vtArea(h)) >= 16) members.push({ type: 'way', role: 'inner', geometry: _vtWay(0, _vtG(T, h), true, null).geometry });
      }
      if (!members.length) { out.push(ow); continue; }
      members.unshift({ type: 'way', role: 'outer', geometry: ow.geometry });
      out.push({ type: 'relation', id: ow.id, tags: ow.tags, members, bounds: ow.bounds }); // part4.js processWaterRelation
    }
  }
}
function _vtCoast(T, feats, out) {
  const emit = (pts) => { if (pts.length >= 4) out.push(_vtWay(T.id(), _vtG(T, pts), false, { natural: 'coastline' })); };
  for (const f of feats) {
    if (f.type !== 3 || f.props.class !== 'ocean') continue;
    for (const r of f.parts) {
      const n = r.length / 2;
      if (n < 3) continue;
      const segs = new Array(n);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const s = _vtClipSeg(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]);
        // タイル本体の境界線上に乗る辺はタイルの切り取りで生じた辺で、海岸線ではない
        const onEdge = s && ((s[0] === s[2] && (s[0] === 0 || s[0] === VT_E)) || (s[1] === s[3] && (s[1] === 0 || s[1] === VT_E)));
        segs[i] = (s && !onEdge) ? s : null;
      }
      const joined = (a, b) => a && b && a[2] === b[0] && a[3] === b[1];
      let st = -1;
      for (let i = 0; i < n; i++) if (segs[i] && !joined(segs[(i + n - 1) % n], segs[i])) { st = i; break; }
      if (st < 0) { // 全辺が連続 = タイル内で閉じた海岸線(島)
        if (!segs[0]) continue;
        const pts = [];
        for (let i = 0; i < n; i++) pts.push(segs[i][0], segs[i][1]);
        pts.push(segs[0][0], segs[0][1]);
        emit(pts);
        continue;
      }
      let cur = null;
      for (let k = 0; k < n; k++) {
        const s = segs[(st + k) % n];
        if (!s) { if (cur) { emit(cur); cur = null; } continue; }
        if (cur && cur[cur.length - 2] === s[0] && cur[cur.length - 1] === s[1]) cur.push(s[2], s[3]);
        else { if (cur) emit(cur); cur = s.slice(); }
      }
      if (cur) emit(cur);
    }
  }
}
function _vtPois(T, feats, out) { // 駅ノードを出し、建物への付与用の格子索引を返す
  const grid = new Map();
  for (const f of feats) {
    if (f.type !== 1) continue;
    const p = f.props;
    // 地下鉄駅はsubclass=subway(Overpass経路の railway=station + station=subway に相当)
    const isSt = p.class === 'railway' && (p.subclass === 'station' || p.subclass === 'halt' || p.subclass === 'subway');
    // 建物への付与に使えないPOI(名前も役割も無い)は索引に入れない(密集地で数千件ある)
    const useful = isSt || !!p.name || _vtPoiRole(p)[0] > 1;
    for (const part of f.parts) for (let i = 0; i + 1 < part.length; i += 2) {
      const x = part[i], y = part[i + 1];
      if (useful && x >= -VT_BLDG_BUFFER && x <= VT_E + VT_BLDG_BUFFER && y >= -VT_BLDG_BUFFER && y <= VT_E + VT_BLDG_BUFFER) {
        const k = Math.floor(x / 256) + ',' + Math.floor(y / 256); // POIはバッファが広いので建物の範囲だけ
        let a = grid.get(k);
        if (!a) grid.set(k, a = []);
        a.push({ x, y, p });
      }
      if (isSt && x >= 0 && x < VT_E && y >= 0 && y < VT_E) { // バッファ部の重複はタイル本体の側だけが出す
        const ll = _vtLL(T.gx0 + x, T.gy0 + y), tags = { railway: p.subclass === 'halt' ? 'halt' : 'station' };
        if (p.name) tags.name = p.name;
        if (p['name:ja']) tags['name:ja'] = p['name:ja'];
        out.push({ type: 'node', id: T.id(), lat: ll.lat, lon: ll.lon, tags, bounds: { minlat: ll.lat, minlon: ll.lon, maxlat: ll.lat, maxlon: ll.lon } });
      }
    }
  }
  return grid;
}
// 建物のタグ。駅舎(駅のPOIを含む建物)は false = 描かない(Overpass経路でも building=train_station や
// railway=station の建物は描かず、駅はaddStationのランドマークが担当している。part8.js参照)。
function _vtBldgTags(q, grid) {
  const t = { building: 'yes' };
  const lv = _vtHeightTags(t, q.p.render_height || 0);
  // 【2026-11-10・H-2】下端の高さ(building:partの min_height / min_level)。render_min_heightは
  // min_level×3.66の切り捨てなので、階数由来なら「1階=3m」に換算し直す(上端を building:levels×3 で
  // 描くのと揃えないと、低層部の屋上と高層部の下端の間に隙間ができる)。
  const mh = q.p.render_min_height || 0;
  if (mh > 0 && (q.p.render_height || 0) > mh + 1) {
    let m = mh;
    for (let L = 1; L <= 300; L++) { const v = Math.floor(L * 3.66); if (v === mh) { m = L * 3; break; } if (v > mh) break; }
    t.min_height = String(m);
  }
  const col = q.p.colour;
  if (typeof col === 'string' && /^#[0-9a-f]{6}$/i.test(col)) t['building:colour'] = col;
  if (!grid || !grid.size) return t;
  const small = q.areaM2 < 1500 && (!lv || lv <= 3);
  let best = null, bp = 0, br = Infinity, named = null, nr = Infinity;
  const cx0 = Math.floor(q.x0 / 256), cx1 = Math.floor(q.x1 / 256), cy0 = Math.floor(q.y0 / 256), cy1 = Math.floor(q.y1 / 256);
  for (let gx = cx0; gx <= cx1; gx++) for (let gy = cy0; gy <= cy1; gy++) {
    const a = grid.get(gx + ',' + gy);
    if (!a) continue;
    for (const o of a) {
      if (o.x < q.x0 || o.x > q.x1 || o.y < q.y0 || o.y > q.y1 || !_vtPip(o.x, o.y, q.r)) continue;
      const p = o.p;
      if (p.class === 'railway' && (p.subclass === 'station' || p.subclass === 'halt')) return false;
      const [pr, tg, smallOnly, nameAlways] = _vtPoiRole(p), rk = p.rank || 99;
      const own = !!tg && (!smallOnly || small); // 店構え・社寺の見た目は小さな建物だけ(大型ビル1階のコンビニや屋上の社でビル全体が変わらないように)
      if ((own || nameAlways) && (pr > bp || (pr === bp && rk < br))) { bp = pr; br = rk; best = { o, tg: own ? tg : null }; }
      if (p.name && rk < nr) { nr = rk; named = o; }
    }
  }
  if (best && best.tg) Object.assign(t, best.tg);
  const nm = (best && best.o.p.name) ? best.o : (small ? named : null);
  if (nm) { t.name = nm.p.name; if (nm.p['name:ja']) t['name:ja'] = nm.p['name:ja']; }
  return t;
}
function _vtBuildings(T, feats, grid, out) {
  let over = 0;
  for (const f of feats) for (const r of f.parts) for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (-x > over) over = -x; if (x - VT_E > over) over = x - VT_E;
    if (-y > over) over = -y; if (y - VT_E > over) over = y - VT_E;
  }
  // バッファ端(ここで切り取られた)とみなす閾値。端に届く建物が無いタイルでは切り取りも無い
  const lim = over >= VT_BLDG_BUFFER ? over - 0.5 : Infinity;
  const recs = [];
  for (const f of feats) {
    if (f.type !== 3) continue;
    for (const poly of _vtPolys(f.parts)) {
      const r = poly[0], n = r.length / 2;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sx = 0, sy = 0;
      for (let i = 0; i < r.length; i += 2) {
        const x = r[i], y = r[i + 1];
        sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const area = _vtArea(r);
      recs.push({ r, holes: poly.length > 1 ? poly.slice(1) : null, p: f.props, x0, y0, x1, y1, cx: sx / n, cy: sy / n,
        area, areaM2: area * T.mpu * T.mpu, skip: false, tags: null, kids: null, inside: null, useParts: false });
    }
  }
  // 外形と部品: ベクタータイルでは building:part も建物と同列で入っていて区別する属性が無い
  // (hide_3dはtype=buildingリレーションの外形にしか付かない)。重心が自分より大きい建物の内側
  // (中庭の穴は除く)にあれば部品とみなし、
  //  - 部品が外形の半分以上を覆う(またはhide_3d) → 部品をそれぞれの高さで描き、外形は描かない(段々の外観)
  //  - そうでない → 外形だけ描く(Overpass経路と同じ。内側の部品・重複は描かない)
  // 部品は地面から立てて描くので、庇・渡り廊下・屋根だけの部品(min_heightが高さの半分以上)は描かない。
  const G = new Map(), CELL = 256;
  recs.forEach((q, i) => {
    for (let gx = Math.floor(q.x0 / CELL); gx <= Math.floor(q.x1 / CELL); gx++) for (let gy = Math.floor(q.y0 / CELL); gy <= Math.floor(q.y1 / CELL); gy++) {
      const k = gx + ',' + gy;
      let a = G.get(k);
      if (!a) G.set(k, a = []);
      a.push(i);
    }
  });
  for (const q of recs) {
    const a = G.get(Math.floor(q.cx / CELL) + ',' + Math.floor(q.cy / CELL));
    if (!a) continue;
    let box = null;
    for (const j of a) {
      const o = recs[j];
      // 部品は外形の外接矩形にほぼ収まる(誤差2単位まで)。収まらない組み合わせは点の内外判定をせずに捨てる
      if (o === q || o.area <= q.area * 1.05 || q.x0 < o.x0 - 2 || q.x1 > o.x1 + 2 || q.y0 < o.y0 - 2 || q.y1 > o.y1 + 2) continue;
      if (!_vtPip(q.cx, q.cy, o.r) || (o.holes && o.holes.some(h => _vtPip(q.cx, q.cy, h)))) continue;
      if (!box || o.area > box.area) box = o;
    }
    if (box) { q.inside = box; (box.kids || (box.kids = [])).push(q); }
  }
  for (const o of recs) {
    if (!o.kids || o.inside) continue;
    let cov = 0;
    for (const k of o.kids) cov += k.area;
    // 高さの分かる部品が無ければ部品に分けても意味が無い(ゲーム側の推定高さで凸凹になるだけ)
    const known = o.kids.some(k => k.p.render_height > 0 && k.p.render_height !== 5);
    o.useParts = known && (!!o.p.hide_3d || cov >= 0.5 * o.area);
    if (!o.useParts) { for (const k of o.kids) k.skip = true; continue; }
    let drawn = 0;
    for (const k of o.kids) {
      const h = k.p.render_height || 0, mh = k.p.render_min_height || 0;
      if (mh > 0 && h - mh < 0.5 * h) k.skip = true; else drawn++;
    }
    if (drawn) o.skip = true; // 描ける部品が1つも無ければ外形を描く
  }
  const emit = (q, r) => {
    if (!out) return;
    if (q.tags === null) q.tags = _vtBldgTags(q, grid);
    if (q.tags) out.push(_vtWay(T.id(), _vtG(T, r), true, q.tags));
  };
  const inT = (q) => q.cx >= 0 && q.cx < VT_E && q.cy >= 0 && q.cy < VT_E;
  for (const q of recs) {
    if (q.skip) continue;
    const sides = (q.x0 < 0 ? 1 : 0) | (q.x1 > VT_E ? 2 : 0) | (q.y0 < 0 ? 4 : 0) | (q.y1 > VT_E ? 8 : 0);
    if (!sides) { emit(q, q.r); continue; }
    const clipped = q.x0 <= -lim || q.x1 >= VT_E + lim || q.y0 <= -lim || q.y1 >= VT_E + lim;
    if (sides !== 1 && sides !== 2 && sides !== 4 && sides !== 8) { // 角をまたぐ(稀): 本体矩形で切った部分を出す
      if (!clipped) { if (inT(q)) emit(q, q.r); }
      else { const pr = _vtClipRing(q.r); if (pr && Math.abs(_vtArea(pr)) > 4) emit(q, pr); }
      continue;
    }
    // 1辺だけまたぐ: 境界線との交点の範囲を記録し、隣のタイルの記録と突き合わせる(_vtFullOf)
    const vert = sides <= 2, bl = (sides === 2 || sides === 8) ? VT_E : 0, r = q.r;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
      const a = vert ? r[j] : r[j + 1], b = vert ? r[i] : r[i + 1];
      if ((a < bl) !== (b < bl)) {
        const t = (bl - a) / (b - a), o = vert ? r[j + 1] + (r[i + 1] - r[j + 1]) * t : r[j] + (r[i] - r[j]) * t;
        if (o < lo) lo = o; if (o > hi) hi = o;
      }
    }
    if (!(hi > lo)) { if (inT(q)) emit(q, q.r); continue; }
    const off = vert ? T.gy0 : T.gx0;
    const rec = { side: sides, lo: lo + off, hi: hi + off, clipped, q, portion: null };
    if (clipped) {
      const pr = _vtClipRing(q.r);
      rec.portion = (pr && Math.abs(_vtArea(pr)) > 4) ? _vtG(T, pr) : null;
      if (out) q.tags = _vtBldgTags(q, grid);
    } else if (inT(q)) emit(q, q.r); // 丸ごと見えている建物は重心ルール
    T.clip.push(rec);
  }
}
// 境界線(vert=縦線x=line / 横線y=line)で接する2つの断片リングを1つの外周にする。
// 各断片を「境界上の頂点列の終わり → 反対側を一周 → 境界上の頂点列の始まり」に回して連結する。
function _vtMerge(a, b, vert, line) {
  const path = (r) => {
    const n = r.length / 2, on = (i) => Math.abs((vert ? r[2 * i] : r[2 * i + 1]) - line) < 1e-6;
    let s = -1, runs = 0;
    for (let i = 0; i < n; i++) if (on(i) && !on((i + 1) % n)) { runs++; if (s < 0) s = i; }
    if (runs !== 1) return r.slice(); // 凹形で境界と何度も交わる(稀): 頂点を全部残す(外接矩形は正しい)
    const o = [r[2 * s], r[2 * s + 1]];
    for (let k = 1; k < n; k++) { const i = (s + k) % n; o.push(r[2 * i], r[2 * i + 1]); if (on(i)) break; }
    return o;
  };
  const m = path(a).concat(path(b)), o = [];
  for (let i = 0; i < m.length; i += 2) {
    if (o.length && Math.abs(o[o.length - 2] - m[i]) < 0.5 && Math.abs(o[o.length - 1] - m[i + 1]) < 0.5) continue;
    o.push(m[i], m[i + 1]);
  }
  return o;
}

// ---------------------------------------------------------------- タイル単位のキャッシュ
async function _vtGetData(x, y) {
  const tpl = await _vtTemplate(false);
  const u = (t) => t.replace('{z}', VT_Z).replace('{x}', x).replace('{y}', y);
  let res = await _vtFetch(u(tpl));
  if (res.status === 404 && Date.now() - _vtTplAt > 10 * 60 * 1000) { // 版の切替でURLが失効した可能性
    const t2 = await _vtTemplate(true);
    if (t2 !== tpl) res = await _vtFetch(u(t2));
  }
  return res;
}
async function _vtLoadBase(x, y) {
  const t0 = performance.now();
  const res = await _vtGetData(x, y);
  const t1 = performance.now();
  const T = _vtCtx(x, y), els = [], pieces = [];
  if (res.data) {
    const L = _vtDecode(res.data);
    _vtLines(T, L.transportation || [], _vtRoadTags, els, pieces);
    _vtLines(T, L.waterway || [], _vtWaterwayTags, els, pieces);
    _vtAreas(T, L.water || [], _vtWaterTags, els, true);
    _vtCoast(T, L.water || [], els);
    _vtAreas(T, L.landcover || [], _vtLandcoverTags, els, false);
    _vtAreas(T, L.landuse || [], _vtLanduseTags, els, false);
    const grid = _vtPois(T, L.poi || [], els);
    _vtBuildings(T, L.building || [], grid, els);
    vtStats.bytes += res.data.length;
  }
  vtStats.tiles++; vtStats.fetchMs += t1 - t0; vtStats.convMs += performance.now() - t1;
  return { T, els, pieces, bytes: res.data ? res.data.length : 0 };
}
// 隣接タイルの継ぎ目情報(境界をまたぐ建物の記録・橋/トンネル断片)だけを作る軽量版。
// 本体のLRUへ入れないので、継ぎ目の確認のために変換済みタイルが押し出されることがない。
async function _vtLoadAux(x, y) {
  const res = await _vtGetData(x, y);
  const T = _vtCtx(x, y), pieces = [];
  if (res.data) {
    const L = _vtDecode(res.data, _VT_AUX_LAYERS);
    _vtLines(T, L.transportation || [], _vtRoadTags, null, pieces); // 要素のIDは本体変換と同じ順序で振られる
    _vtLines(T, L.waterway || [], _vtWaterwayTags, null, pieces);
    _vtBuildings(T, L.building || [], null, null);
  }
  vtStats.aux++;
  return { clip: T.clip, pieces };
}
const _vtAux = new Map();
function _vtAuxOf(x, y) {
  const k = x + '/' + y, e = _vtTiles.get(k);
  if (e) return e.baseP.then(b => ({ clip: b.T.clip, pieces: b.pieces })); // 変換済みならそれを使う
  let p = _vtAux.get(k);
  if (!p) {
    p = _vtLoadAux(x, y);
    _vtAux.set(k, p);
    p.catch(() => { if (_vtAux.get(k) === p) _vtAux.delete(k); });
    while (_vtAux.size > VT_AUX_MAX) _vtAux.delete(_vtAux.keys().next().value);
  }
  return p;
}
// バッファでも切れている大型建物のうち、東・南の境界をまたぐものを隣のタイルの断片と合成して出す
async function _vtFullOf(ent, x, y) {
  const b = await ent.baseP;
  const own = b.T.clip.filter(r => r.clipped && (r.side === 2 || r.side === 8));
  if (!own.length) return b;
  const nbs = {};
  if (own.some(r => r.side === 2)) nbs[2] = _vtAuxOf(x + 1, y).catch(() => null);
  if (own.some(r => r.side === 8)) nbs[8] = _vtAuxOf(x, y + 1).catch(() => null);
  const extra = [];
  let k = 0;
  for (const rec of own) {
    const nb = await nbs[rec.side], want = rec.side === 2 ? 1 : 4;
    let partner = null, best = 0;
    if (nb) for (const o of nb.clip) {
      if (o.side !== want) continue;
      const ov = Math.min(rec.hi, o.hi) - Math.max(rec.lo, o.lo);
      if (ov > best && ov > 0.5 * Math.min(rec.hi - rec.lo, o.hi - o.lo)) { best = ov; partner = o; }
    }
    if (partner && !partner.clipped) continue; // 隣では丸ごと見えている → 隣が重心ルールで出す
    let ring = rec.portion;
    if (partner && partner.portion) {
      ring = ring ? _vtMerge(ring, partner.portion, rec.side === 2, rec.side === 2 ? b.T.gx0 + VT_E : b.T.gy0 + VT_E) : partner.portion;
      vtStats.merged++;
    }
    if (ring && ring.length >= 6 && rec.q.tags) extra.push(_vtWay(b.T.mid(k++), ring, true, rec.q.tags));
  }
  return extra.length ? { T: b.T, els: b.els.concat(extra), pieces: b.pieces } : b;
}
const _vtTiles = new Map(); // 'x/y' → { baseP, fullP, bytes }(LRU。枚数と元データ量の両方で上限)
let _vtLruBytes = 0;
function _vtEvict() {
  while (_vtTiles.size > VT_LRU || (_vtLruBytes > VT_LRU_BYTES && _vtTiles.size > 4)) {
    const k = _vtTiles.keys().next().value, e = _vtTiles.get(k);
    _vtTiles.delete(k);
    _vtLruBytes -= e.bytes;
    e.bytes = 0;
  }
}
function _vtEntry(x, y) {
  const k = x + '/' + y;
  let e = _vtTiles.get(k);
  if (e) { _vtTiles.delete(k); _vtTiles.set(k, e); return e; }
  e = { baseP: null, fullP: null, bytes: 0 };
  e.baseP = _vtLoadBase(x, y).then(b => {
    if (_vtTiles.get(k) === e) { e.bytes = b.bytes; _vtLruBytes += b.bytes; _vtEvict(); }
    return b;
  });
  e.baseP.catch(() => { if (_vtTiles.get(k) === e) { _vtTiles.delete(k); _vtLruBytes -= e.bytes; } });
  _vtTiles.set(k, e);
  _vtEvict();
  return e;
}
function _vtBase(x, y) { return _vtEntry(x, y).baseP; }
function _vtFull(x, y) { const e = _vtEntry(x, y); return e.fullP || (e.fullP = _vtFullOf(e, x, y)); }

// ---------------------------------------------------------------- 橋・トンネルの継ぎ目
// タイル境界で切れた断片同士を境界上の端点で繋ぎ、橋は全体の形(vtBridgeChain)、トンネルは
// 全長(vtTunnelLen)を出力要素の複製に添える。継ぎ目の向こうのタイルがバッチに無ければ取りに行く。
async function _vtChains(out, union) {
  const idx = new Map();
  out.forEach((el, i) => idx.set(el.id, i));
  let pcs = [];
  for (const f of union.values()) pcs = pcs.concat(f.pieces);
  const need = new Set();
  for (const p of pcs) if (idx.has(p.el.id)) for (const e of p.ends) if (e.nb && !union.has(e.nb)) need.add(e.nb);
  if (!pcs.some(p => idx.has(p.el.id) && (p.ends[0].nb || p.ends[1].nb))) return;
  const more = await Promise.all([...need].map(k => {
    const [x, y] = k.split('/').map(Number);
    return _vtAuxOf(x, y).then(a => a.pieces, () => []);
  }));
  for (const a of more) pcs = pcs.concat(a);
  const grid = new Map(), key = (x, y) => x + ',' + y;
  pcs.forEach((p, pi) => p.ends.forEach((e, ei) => {
    if (!e.nb) return;
    const k = key(Math.round(e.gx / 2), Math.round(e.gy / 2));
    let a = grid.get(k);
    if (!a) grid.set(k, a = []);
    a.push(pi, ei);
  }));
  const link = pcs.map(() => [null, null]);
  pcs.forEach((p, pi) => p.ends.forEach((e, ei) => {
    if (!e.nb || link[pi][ei]) return;
    const cx = Math.round(e.gx / 2), cy = Math.round(e.gy / 2);
    let bd = 4.5, bj = -1, be = -1; // 2単位(約1m)程度まで(両側で別々に計算した交点の誤差)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = grid.get(key(cx + dx, cy + dy));
      if (!a) continue;
      for (let m = 0; m < a.length; m += 2) {
        const pj = a[m], ej = a[m + 1], q = pcs[pj];
        if (pj === pi || q.kind !== p.kind || q.road !== p.road || link[pj][ej]) continue;
        const f = q.ends[ej], d = (f.gx - e.gx) ** 2 + (f.gy - e.gy) ** 2;
        if (d < bd) { bd = d; bj = pj; be = ej; }
      }
    }
    if (bj >= 0) { link[pi][ei] = [bj, be]; link[bj][be] = [pi, ei]; }
  }));
  const done = new Uint8Array(pcs.length);
  for (let s = 0; s < pcs.length; s++) {
    if (done[s]) continue;
    const comp = [], st = [s];
    done[s] = 1;
    while (st.length) {
      const i = st.pop();
      comp.push(i);
      for (const l of link[i]) if (l && !done[l[0]]) { done[l[0]] = 1; st.push(l[0]); }
    }
    if (comp.length < 2 || !comp.some(i => idx.has(pcs[i].el.id))) continue;
    vtStats.chains++;
    if (pcs[s].kind === 't') {
      let total = 0;
      for (const i of comp) total += pcs[i].len;
      for (const i of comp) {
        const el = pcs[i].el, oi = idx.get(el.id);
        if (oi !== undefined) out[oi] = Object.assign({}, el, { vtTunnelLen: total });
      }
      continue;
    }
    let i = comp.find(c => !link[c][0] || !link[c][1]);
    if (i === undefined) continue; // 環状(異常データ)
    let ein = link[i][0] ? 1 : 0; // 未接続側の端から入る
    const chain = [], parts = [], vis = new Set();
    while (!vis.has(i)) {
      vis.add(i);
      const g = pcs[i].el.geometry, og = ein === 0 ? g : g.slice().reverse();
      parts.push([i, chain.length, og]);
      for (const p of og) chain.push(p);
      const nx = link[i][1 - ein];
      if (!nx) break;
      i = nx[0]; ein = nx[1];
    }
    for (const [pi, off, og] of parts) {
      const el = pcs[pi].el, oi = idx.get(el.id);
      if (oi !== undefined) out[oi] = Object.assign({}, el, { geometry: og, vtBridgeChain: { geometry: chain, offset: off } });
    }
  }
}

// ---------------------------------------------------------------- 公開API
// bboxes: fetchOSMTileBatchの "minLat,minLon,maxLat,maxLon" 文字列の配列。kind: 'road'|'building'|undefined
// → { elements } (Overpass応答と同じ形) / null(失敗。呼び出し元はOverpass経路へフォールバックする)
async function vtLoadBatch(bboxes, kind) {
  if (!VT_ON || Date.now() < _vtDownUntil) return null;
  vtStats.batches++;
  try {
    const boxes = bboxes.map(s => String(s).split(',').map(Number));
    const keys = new Map();
    for (const b of boxes) {
      const x0 = _vtLon2X(b[1]), x1 = _vtLon2X(b[3]), y0 = _vtLat2Y(b[2]), y1 = _vtLat2Y(b[0]);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.set(x + '/' + y, [x, y]);
    }
    const union = new Map();
    await Promise.all([...keys].map(async ([k, [x, y]]) => { union.set(k, await _vtFull(x, y)); }));
    const out = [], seen = new Set();
    for (const f of union.values()) for (const el of f.els) {
      if (seen.has(el.id)) continue;
      const isB = !!(el.tags && el.tags.building);
      if ((kind === 'road' && isB) || (kind === 'building' && !isB)) continue;
      const d = el.bounds;
      if (!boxes.some(b => d.maxlat >= b[0] && d.minlat <= b[2] && d.maxlon >= b[1] && d.minlon <= b[3])) continue;
      seen.add(el.id);
      out.push(el);
    }
    await _vtChains(out, union);
    _vtFailStreak = 0;
    _vtCredit();
    return { elements: out };
  } catch (e) {
    vtStats.fail++;
    vtStats.lastErr = String((e && (e.name === 'AbortError' ? 'timeout' : e.message)) || e).slice(0, 60);
    if (++_vtFailStreak >= 8) { // 配信元の障害とみなす(単発の失敗はタイル単位の取り直しで吸収する)
      _vtDownUntil = Date.now() + 60 * 1000;
      _vtFailStreak = 0;
      console.warn('[vt] 8回連続で失敗したため1分間Overpassのみで取得します');
    }
    console.warn('[vt] ベクタータイル取得失敗 → Overpassへフォールバック', e);
    return null;
  }
}
// 出典表記(OSMのODbLとOpenFreeMapの利用条件)。明治/江戸モードは既存の出典表記(part1.js)を使う
let _vtCreditDone = false;
function _vtCredit() {
  if (_vtCreditDone) return;
  _vtCreditDone = true;
  try {
    if (typeof USES_MEIJI_LANDUSE !== 'undefined' && USES_MEIJI_LANDUSE) return;
    const cr = document.getElementById('credit');
    if (!cr || cr.style.display === 'block') return;
    cr.textContent = '© OpenStreetMap contributors · OpenFreeMap © OpenMapTiles';
    cr.style.display = 'block';
  } catch (e) {}
}
function vtStatsText() { // 性能HUD(js/core/perf-hud.js)用
  if (!VT_ON) return 'vt off (Overpass)';
  const s = vtStats, n = s.tiles || 1;
  return `vt ${s.tiles}枚(+隣${s.aux}) ${(s.bytes / 1048576).toFixed(1)}MB 取得${(s.fetchMs / n).toFixed(0)}ms 変換${(s.convMs / n).toFixed(0)}ms` +
    `  失敗${s.fail} 再試行${s.retry} Overpass${s.fallback} 合成${s.merged} 継ぎ目${s.chains}` + (s.lastErr ? `\nvt最後のエラー: ${s.lastErr}` : '');
}
