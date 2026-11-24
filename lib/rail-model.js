'use strict';
/**
 * 铁路时刻模型：把 railway-panorama 发布的紧凑数据解码成「某一时刻的列车位置」。
 * 数据格式参考 linkboyx/railway-panorama 的 data/ 发布文件与 model.js 思路，
 * 这里按本站需要重新实现（只保留位置推算相关部分），未复制其项目代码。
 * 时刻一律按北京时间（UTC+8）理解。
 */

const DAY = 86400000;
const TZ = 8 * 3600000;
const RAD = Math.PI / 180;
const EARTH_R = 6371008.8;

const haversine = (lon1, lat1, lon2, lat2) => {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
};

const bearing = (lon1, lat1, lon2, lat2) => {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
};

const dayNumOf = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
};
const cst = (ms) => {
  const local = ms + TZ;
  const day = Math.floor(local / DAY);
  return { day, minutes: (local - day * DAY) / 60000 };
};

// 压缩径路：前 3 项是 (起点站下标, 终点站下标, 首边编号)，后面是差值编码
function decodePath(p) {
  if (p[0] === -1) return p;
  const out = [p[0], p[1], p[2]];
  let prev = Math.abs(p[2]);
  for (let i = 3; i < p.length; i++) {
    const v = p[i];
    const neg = v & 1, z = v >>> 1;
    const d = z & 1 ? -(z + 1) / 2 : z / 2;
    prev += d;
    out.push(neg ? -prev : prev);
  }
  return out;
}

function seek(cum, off) {
  let lo = 0, hi = cum.length - 1;
  if (off <= 0) return 0;
  if (off >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= off) lo = m; else hi = m; }
  return lo;
}

function pointAt(E, off) {
  const n = E.lons.length;
  if (off <= 0) return [E.lons[0], E.lats[0]];
  if (off >= E.cum[n - 1]) return [E.lons[n - 1], E.lats[n - 1]];
  const i = seek(E.cum, off), j = Math.min(i + 1, n - 1);
  const s = E.cum[j] - E.cum[i], f = s > 0 ? (off - E.cum[i]) / s : 0;
  return [E.lons[i] + f * (E.lons[j] - E.lons[i]), E.lats[i] + f * (E.lats[j] - E.lats[i])];
}

const ACCEL_MIN = { G: 4, C: 3, D: 3.5, Z: 3, T: 3, K: 2.5 };

class RailModel {
  constructor({ meta, network, stations, trains, paths }) {
    this.meta = meta;
    this.dates = meta.dates || [];
    this.dayNums = this.dates.map(dayNumOf);
    this.dayIndex = new Map(this.dayNums.map((d, i) => [d, i]));

    // 路网边：等比例坐标 + 逐点累计里程
    const q = network.q;
    this.edges = network.edges.map((row) => {
      const n = (row.length - 3) / 2;
      const lons = new Float64Array(n), lats = new Float64Array(n), cum = new Float64Array(n);
      let x = 0, y = 0;
      for (let k = 0; k < n; k++) {
        x += row[3 + 2 * k]; y += row[4 + 2 * k];
        lons[k] = x / q; lats[k] = y / q;
        if (k) cum[k] = cum[k - 1] + haversine(lons[k - 1], lats[k - 1], lons[k], lats[k]);
      }
      return { cls: row[0], name: row[1], traffic: row[2], lons, lats, cum, len: cum[n - 1] };
    });
    this.lineNames = network.names || [];

    // 车站：x/y 存的是 1e5 倍经纬度
    const SF = Object.fromEntries(stations.fields.map((f, i) => [f, i]));
    this.stations = stations.rows.map((r) => ({
      name: r[SF.name], py: r[SF.py], city: r[SF.city], rank: r[SF.rank],
      lon: r[SF.x] == null ? null : r[SF.x] / 1e5,
      lat: r[SF.y] == null ? null : r[SF.y] / 1e5,
    }));

    // 车次：每站 5 个数字 (车站下标, 到达分, 出发分, 里程×10m, 径路引用)
    const TF = Object.fromEntries(trains.fields.map((f, i) => [f, i]));
    this.trains = trains.rows.map((r, ti) => {
      const flat = r[TF.stops] || [], n = Math.floor(flat.length / 5);
      const st = new Int32Array(n), arr = new Int32Array(n), dep = new Int32Array(n);
      const dist = new Float64Array(n), seg = new Int32Array(n);
      for (let k = 0; k < n; k++) {
        st[k] = flat[5 * k]; arr[k] = flat[5 * k + 1]; dep[k] = flat[5 * k + 2];
        dist[k] = flat[5 * k + 3] < 0 ? -1 : flat[5 * k + 3] * 10;
        seg[k] = flat[5 * k + 4];
      }
      const anchors = [];
      for (let k = 0; k < n; k++) if (seg[k] !== 0) anchors.push(k);
      if (anchors.length) {
        let last = -1;
        for (let k = n - 1; k >= 0; k--) if (dist[k] >= 0) { last = k; break; }
        if (last > anchors[anchors.length - 1]) anchors.push(last); else anchors.length = 0;
      }
      return {
        ti, no: r[TF.no], code: r[TF.code], cls: r[TF.cls], days: r[TF.days] || [],
        n, st, arr, dep, dist, seg, anchors, drawable: anchors.length >= 2,
        t0: anchors.length ? dep[anchors[0]] : dep[0],
        t1: anchors.length ? arr[anchors[anchors.length - 1]] : arr[n - 1],
      };
    });
    this.byDay = this.dayNums.map(() => []);
    this.trains.forEach((t, ti) => t.days.forEach((d) => { if (this.byDay[d]) this.byDay[d].push(ti); }));
    this.maxSpan = Math.min(6, Math.ceil(this.trains.reduce((m, t) => Math.max(m, t.t1), 0) / 1440));

    this.segs = (paths.enc === 'delta1' ? paths.segs.map(decodePath) : paths.segs) || [];
    this.segCache = new Map();
  }

  mapDay(dayNum) {
    const exact = this.dayIndex.get(dayNum);
    if (exact !== undefined) return { idx: exact };
    const wd = new Date(dayNum * DAY).getUTCDay();
    let best = -1, score = Infinity;
    this.dayNums.forEach((d, i) => {
      const s = Math.abs(d - dayNum) + (new Date(d * DAY).getUTCDay() === wd ? 0 : 10000);
      if (s < score) { score = s; best = i; }
    });
    return { idx: best };
  }

  activeRuns(ms) {
    const { day, minutes } = cst(ms);
    const out = [];
    for (let k = 0; k <= this.maxSpan; k++) {
      const m = this.mapDay(day - k);
      if (m.idx < 0) continue;
      const rel = minutes + k * 1440;
      for (const ti of this.byDay[m.idx]) {
        const t = this.trains[ti];
        if (t.drawable && rel >= t.t0 && rel <= t.t1) out.push({ t, rel, day: day - k });
      }
    }
    return out;
  }

  polyline(ref) {
    const key = Math.abs(ref) - 1;
    let pl = this.segCache.get(key);
    if (pl) return pl;
    const p = this.segs[key] || [-1, 0, 0];
    const lons = [], lats = [];
    const push = (x, y) => {
      const n = lons.length;
      if (n && Math.abs(lons[n - 1] - x) < 1e-9 && Math.abs(lats[n - 1] - y) < 1e-9) return;
      lons.push(x); lats.push(y);
    };
    if (p[0] === -1) {
      const a = this.stations[p[1]], b = this.stations[p[2]];
      if (a && b) { push(a.lon, a.lat); push(b.lon, b.lat); }
    } else {
      const piece = (e, from, to) => {
        if (!e) return;
        const [x0, y0] = pointAt(e, from); push(x0, y0);
        if (to > from) { for (let k = 0; k < e.cum.length; k++) if (e.cum[k] > from && e.cum[k] < to) push(e.lons[k], e.lats[k]); }
        else { for (let k = e.cum.length - 1; k >= 0; k--) if (e.cum[k] < from && e.cum[k] > to) push(e.lons[k], e.lats[k]); }
        const [x1, y1] = pointAt(e, to); push(x1, y1);
      };
      const es = p.slice(2);
      if (es.length === 1) piece(this.edges[Math.abs(es[0]) - 1], p[0], p[1]);
      else es.forEach((se, i) => {
        const e = this.edges[Math.abs(se) - 1];
        if (i === 0) piece(e, p[0], se > 0 ? e.len : 0);
        else if (i === es.length - 1) piece(e, se > 0 ? 0 : e.len, p[1]);
        else piece(e, se > 0 ? 0 : e.len, se > 0 ? e.len : 0);
      });
    }
    const cum = new Float64Array(lons.length);
    for (let k = 1; k < lons.length; k++) cum[k] = cum[k - 1] + haversine(lons[k - 1], lats[k - 1], lons[k], lats[k]);
    pl = { lons: Float64Array.from(lons), lats: Float64Array.from(lats), cum, len: cum[cum.length - 1] || 0 };
    this.segCache.set(key, pl);
    return pl;
  }

  locate(t, d) {
    const A = t.anchors;
    let k = 0;
    while (k < A.length - 2 && t.dist[A[k + 1]] <= d) k++;
    const ref = t.seg[A[k]], pl = this.polyline(ref);
    const segStart = t.dist[A[k]], segEnd = t.dist[A[k + 1]];
    const span = segEnd - segStart;
    let off = span > 0 ? ((d - segStart) / span) * pl.len : 0;
    off = Math.max(0, Math.min(pl.len, off));
    if (ref < 0) off = pl.len - off;
    const i = seek(pl.cum, off), j = Math.min(i + 1, pl.lons.length - 1);
    const s = pl.cum[j] - pl.cum[i], f = s > 0 ? (off - pl.cum[i]) / s : 0;
    let b = j > i ? bearing(pl.lons[i], pl.lats[i], pl.lons[j], pl.lats[j]) : 0;
    if (ref < 0) b = (b + 180) % 360;
    return {
      lon: pl.lons[i] + f * (pl.lons[j] - pl.lons[i]),
      lat: pl.lats[i] + f * (pl.lats[j] - pl.lats[i]),
      bearing: b,
    };
  }

  state(t, rel) {
    if (!t.drawable || rel < t.t0 || rel > t.t1) return null;
    const { arr, dep, dist } = t;
    let lo = 0, hi = t.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= rel) lo = m; else hi = m - 1; }
    const i = arr[lo] > rel ? 0 : lo;
    let j = i, d = dist[i], moving = false, speed = 0;
    if (rel > dep[i] && i !== t.n - 1) {
      j = i + 1;
      while (j < t.n - 1 && dist[j] < 0) j++;
      let a = i; while (a > 0 && dist[a] < 0) a--;
      const T = arr[j] - dep[i], D = dist[j] - dist[a];
      const f = T > 0 ? (rel - dep[i]) / T : 1;
      const acc = Math.min(0.3, (ACCEL_MIN[t.cls] || 2) / Math.max(T, 1));
      const vmax = 1 / (1 - acc);
      let s, v;
      if (f < acc) { s = (0.5 * vmax * f * f) / acc; v = (vmax * f) / acc; }
      else if (f <= 1 - acc) { s = 0.5 * vmax * acc + vmax * (f - acc); v = vmax; }
      else { s = 1 - (0.5 * vmax * (1 - f) ** 2) / acc; v = (vmax * (1 - f)) / acc; }
      d = dist[a] + s * D;
      moving = true;
      speed = T > 0 ? (v * D) / 1000 / (T / 60) : 0;
    }
    if (d < 0) return null;
    return { ...this.locate(t, d), moving, i, j, speed, d };
  }

  stops(t, dayNum) {
    const base = dayNum * DAY - TZ;
    const out = [];
    for (let k = 0; k < t.n; k++) {
      out.push({
        name: (this.stations[t.st[k]] || {}).name || '',
        arr: t.arr[k] < 0 ? null : base + t.arr[k] * 60000,
        dep: t.dep[k] < 0 ? null : base + t.dep[k] * 60000,
      });
    }
    return out;
  }

  // 线网图层：只取高等级、有一定车流的边，抽稀后输出 GeoJSON
  lineGeoJSON({ traffic = 30, maxCls = 2, step = 4 } = {}) {
    const features = [];
    for (const e of this.edges) {
      if (e.cls > maxCls || e.traffic < traffic) continue;
      const n = e.lons.length, c = [];
      for (let i = 0; i < n; i += step) c.push([+e.lons[i].toFixed(4), +e.lats[i].toFixed(4)]);
      if ((n - 1) % step !== 0) c.push([+e.lons[n - 1].toFixed(4), +e.lats[n - 1].toFixed(4)]);
      if (c.length > 1) features.push({ type: 'Feature', properties: { cls: e.cls, name: e.name }, geometry: { type: 'LineString', coordinates: c } });
    }
    return { type: 'FeatureCollection', features };
  }
}

module.exports = { RailModel, DAY, TZ, haversine, bearing, dayNumOf, cst, pointAt };
