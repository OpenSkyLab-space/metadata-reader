/* ================================================================ UI (page only; the parser above is OSLMeta) */
const M = globalThis.OSLMeta;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let L = /^(cs|sk)\b/i.test(navigator.language || "") ? "cs" : "en";  // browser language, unless ?lang= or a stored choice says otherwise
try { const v = localStorage.getItem("osl-lang"); if (v === "en" || v === "cs") L = v; } catch (e) { /* storage blocked */ }
// an explicit ?lang=en|cs in the link wins (links from the English Metadata pages open the English version)
try { const q = new URLSearchParams(location.search).get("lang"); if (q === "en" || q === "cs") L = q; } catch (e) { /* no URL API */ }
function t(k, ...a) {
  let s = T[L][k]; if (s == null) s = T.cs[k]; if (s == null) return k;
  if (typeof s === "function") return s(...a);
  return a.length ? s.replace(/\{(\d)\}/g, (m, i) => a[+i] == null ? "" : a[+i]) : s;
}
const NF = {};
function fmt(v, d, grp) {
  if (v == null || typeof v !== "number" || !isFinite(v)) return "–";
  d = d == null ? 2 : d; const key = L + d + (grp === false ? "n" : "g");
  const f = NF[key] || (NF[key] = new Intl.NumberFormat(L === "cs" ? "cs-CZ" : "en-GB", { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: grp !== false }));
  return f.format(v).replace(/^-/, "−");
}
function fmtA(v, sig) { /* automatic decimals for a few significant digits */
  if (v == null || !isFinite(v)) return "–"; const a = Math.abs(v); sig = sig || 4;
  if (a === 0) return "0"; const d = Math.max(0, Math.min(8, sig - 1 - Math.floor(Math.log10(a))));
  return fmt(Number(v.toFixed(d)), d);
}
const dec = s => { const x = String(s).replace(/(^|[\s(;,=])-(?=\d)/g, "$1−"); return L === "cs" ? (/\d\.\d/.test(x) ? x.replace(/(\d), (?=[−+]?\d)/g, "$1; ") : x).replace(/(^|[^\d.,vV])(\d+)\.(\d+)(?![\d.])/g, "$1$2,$3") : x; };
function fmtExp(tm) { if (!tm) return "–"; if (tm < 0.25001) return "1/" + fmt(Math.round(1 / tm), 0, false) + " s"; return fmt(tm, tm < 10 ? 1 : 0) + " s"; }
function fmtTime(iso, ms) { /* ISO 8601 -> readable, decimal comma in cs */
  if (!iso) return "–"; const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?$/.exec(iso);
  if (!m) return esc(iso); let f = m[3] || ""; if (f === ".000" && !ms) f = "";
  return m[1] + " " + m[2] + (f ? (L === "cs" ? "," : ".") + f.slice(1) : "") + (m[4] ? (m[4] === "Z" ? " UTC" : " " + m[4]) : "");
}
function fmtBytes(n) { if (n == null) return "–"; return n < 1024 ? fmt(n, 0) + " B" : n < 1048576 ? fmt(n / 1024, 1) + " kB" : n < 1073741824 ? fmt(n / 1048576, 1) + " MB" : fmt(n / 1073741824, 2) + " GB"; }
const hex8 = n => n == null ? "" : "0x" + Math.floor(n).toString(16).padStart(n > 0xffffffff ? 10 : 8, "0");
function dmsTxt(v, pos, neg) { const a = Math.abs(v); let d = Math.floor(a), m = Math.floor((a - d) * 60), s = (a - d - m / 60) * 3600; if (s >= 59.995) { s = 0; m++; } if (m >= 60) { m = 0; d++; } return d + "° " + m + "′ " + fmt(s, 2) + "″ " + (v < 0 ? neg : pos); }
const src = s => s ? '<span class="src">' + esc(Array.isArray(s) ? s.filter(Boolean).join(", ") : s) + "</span>" : "";
const chip = (cls, icon, txt) => '<span class="chip ' + cls + '"><i aria-hidden="true">' + icon + "</i>" + esc(txt) + "</span>";
const ST_ICON = { file: "✓", derived: "ƒ", log: "⇄", missing: "!", na: "–", notapp: "·" };
const stChip = s => chip("s-" + s, ST_ICON[s], t("st_" + s));
// derived values that rest on an assumption (flat ground at take-off height, nadir view, one image for a batch, a guess from tags) are shown as estimates
// a position from the log interpolated to the exposure time (nInterp) is an estimate as well
const EST_NOTE = /^(nAgl|nDist|nGsd|nGeo|nOneImage|nGnssMode|nSensorType|nWx|nInterp)$/, isEst = r => (r.st === "derived" || r.st === "log") && EST_NOTE.test(r.note || "");
const stChipR = r => isEst(r) ? chip("s-derived", "≈", t("st_estimate")) : stChip(r.st);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------------------------------------------------------------- state */
const st = { tab: "ov", cur: -1, files: [], raw: false, q: "", profile: "C", oslF: "all", H: null, priv: false, open: {}, bsel: -1 };
let uid = 0;
const tagIndex = r => { const ix = new Map(); for (const g of r.groups) for (const tg of g.tags) { if (!ix.has(tg.name)) ix.set(tg.name, []); ix.get(tg.name).push({ g: g.id, t: tg }); } return ix; };
function tv(e, name, re) { if (!e.ix) e.ix = tagIndex(e.res); const a = e.ix.get(name); if (!a) return undefined; for (const x of a) if (!re || re.test(x.g)) return x.t.value; return undefined; }
const num = v => { if (Array.isArray(v)) v = v[0]; if (typeof v === "number") return v; const m = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(String(v == null ? "" : v)); return m ? parseFloat(m[0]) : NaN; };
const cur = () => st.files[st.cur] && st.files[st.cur].res ? st.files[st.cur] : null;

/* ---------------------------------------------------------------- loading */
const b64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
let lastList = 0;
async function addEntries(list, user) {
  if (user) { for (const f of st.files.filter(f => f.sample)) dropEntry(f); st.files = st.files.filter(f => !f.sample); }
  const first = st.files.length;
  for (const it of list) st.files.push({ id: ++uid, name: it.name, size: it.bytes ? it.bytes.length : it.blob.size, sample: !user, label: it.label || "", bytes: it.bytes || null, blob: it.blob || null, res: null, busy: true, readAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
  st.cur = Math.min(first, st.files.length - 1); renderFiles();
  for (let k = first; k < st.files.length; k++) {
    const e = st.files[k];
    try { e.res = await M.parse(e.bytes || e.blob, e.name, {}); } catch (err) { e.res = null; e.err = String(err && err.message || err); }
    e.busy = false; e.ix = null;
    if (k === st.cur) renderAll(); else if (Date.now() - lastList > 300 || k === st.files.length - 1) { lastList = Date.now(); renderFiles();
      const pg = $("#loadProg"); if (pg && st.files.length - first > 20) { const done = k - first + 1, tot = st.files.length - first; pg.hidden = false; pg.textContent = (done < tot ? t("loadProg", done, tot) : t("loadDone", tot)) + (st.skipped ? " " + t("dirSkipped", st.skipped) : ""); } }   // the list is redrawn at most ~3× a second while hundreds of files load
    shaOf(e);
  }
  renderAll();
}
// a dropped or chosen folder: every file below it (Chrome, Edge, Firefox, Safari: webkitGetAsEntry)
async function filesFromDrop(dt) {
  const items = dt && dt.items ? Array.from(dt.items).map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean) : [];
  if (!items.some(e => e.isDirectory)) return null;
  const out = [], walk = async e => { if (e.isFile) { out.push(await new Promise((ok, no) => e.file(ok, no))); return; }
    const r = e.createReader(); for (;;) { const batch = await new Promise((ok, no) => r.readEntries(ok, no)); if (!batch.length) break; for (const x of batch) await walk(x); } };
  for (const e of items) { try { await walk(e); } catch (x) { /* unreadable entry */ } }
  return out;
}
async function readUserFiles(fl, fromDir) {
  const list = [], logs = []; let skipped = 0;
  for (const f of Array.from(fl || [])) {
    if (fromDir && /^\./.test(f.name)) { skipped++; continue; }   // hidden files in a folder (.DS_Store and the like)
    if (!/\.(jpe?g|tiff?|dng|png|webp|gif|heic|heif|avif)$/i.test(f.name)) { let kind = null; try { kind = OSLFlight.sniff(f.name, new Uint8Array(await f.slice(0, 65536).arrayBuffer())); } catch (e) { kind = null; } if (kind || OSLFlight.LOGNAME.test(f.name)) { logs.push({ name: f.name, src: f }); continue; }
      if (fromDir) { skipped++; continue; } }   // from a folder, files that are neither images nor logs (reports, PDFs, settings) are left out
    // the File itself is kept, not its bytes: the parser reads byte ranges, so hundreds of 20–40 MB images do not fill the tab's memory
    list.push({ name: f.name, blob: f });
  }
  st.skipped = skipped; const pg = $("#loadProg"); if (pg) { pg.hidden = !skipped; pg.textContent = skipped ? t("dirSkipped", skipped) : ""; }
  if (logs.length) { if (st.files.some(f => f.sample)) { for (const f of st.files.filter(f => f.sample)) dropEntry(f); st.files = st.files.filter(f => !f.sample); st.cur = st.files.length ? 0 : -1; } if (!list.length) setTab("flt"); addLogs(logs); }
  if (list.length) { st.tab = list.length > 1 ? st.tab : st.tab; await addEntries(list, true); if (list.length > 1 && st.tab === "ov") { /* keep overview */ } }
}
function dropEntry(e) { if (e.thumbUrl) { try { URL.revokeObjectURL(e.thumbUrl); } catch (x) { /* ignore */ } } }
// SHA-256 one file at a time: a File is read whole only for the hash and released right after
let shaQ = Promise.resolve();
function shaOf(e) { shaQ = shaQ.then(() => shaOne(e)); return shaQ; }
async function shaOne(e) {
  if (e.sha || !(e.bytes || e.blob) || !(globalThis.crypto && crypto.subtle)) return;
  try { const h = await crypto.subtle.digest("SHA-256", e.bytes || await e.blob.arrayBuffer()); e.sha = hex(h); if (e === cur() && (st.tab === "osl" || st.tab === "ov")) { if (st.tab === "osl") renderOSL(); else { const el = $("#shaOut"); if (el) el.textContent = e.sha.slice(0, 16) + "…"; } } } catch (x) { /* not available */ }
}
function loadSample(k) {
  if (k === "flight") { for (const f of st.files.filter(f => f.sample)) dropEntry(f); st.files = st.files.filter(f => !f.sample); st.cur = -1; addEntries(Object.keys(FLIGHT).map(n => ({ name: n, bytes: b64(FLIGHT[n]), label: t("smpFlight") })), false).then(() => { setTab("batch"); }); return; }
  const s = SAMPLES[k]; if (!s) return;
  if (st.files.some(f => f.sample && f.name === s.name)) { st.cur = st.files.findIndex(f => f.sample && f.name === s.name); renderAll(); return; }
  addEntries([{ name: s.name, bytes: b64(s.data), label: t("smp_" + k) }], false);
}

/* ---------------------------------------------------------------- thumbnails */
function thumbFor(e) {
  if (e.thumb !== undefined) return e.thumb;
  const r = e.res; e.thumb = null; if (!r) return null;
  const bytes = e.bytes, blob = e.blob, size = bytes ? bytes.length : blob ? blob.size : 0;
  const pv = (r.previews || []).find(p => /ThumbnailImage|PreviewImage|JpgFromRaw/.test(p.kind));
  try {
    // object URLs point at the File (or a slice of it); nothing is copied into memory
    if (pv && size && pv.offset + pv.length <= size) { e.thumbUrl = URL.createObjectURL(bytes ? new Blob([bytes.subarray(pv.offset, pv.offset + pv.length)], { type: "image/jpeg" }) : blob.slice(pv.offset, pv.offset + pv.length, "image/jpeg")); e.thumb = { url: e.thumbUrl, cap: pv.kind }; }
    else if (size && /^(JPEG|PNG|WEBP|GIF)$/.test(r.file.type)) { e.thumbUrl = URL.createObjectURL(bytes ? new Blob([bytes], { type: r.file.mime }) : blob); e.thumb = { url: e.thumbUrl, cap: "file" }; }
    else if (size && size <= 64 * 1048576 && r.raster && r.raster.compression === 1 && !r.raster.tiled) e.thumb = { raster: true, cap: "raster" };
  } catch (x) { e.thumb = null; }
  return e.thumb;
}
function drawRaster(cv, e, bArg) {
  const R = e.res.raster, b = bArg || e.bytes, W = R.width, H = R.height;
  const bps = [].concat(R.bitsPerSample || 8)[0], spp = R.samplesPerPixel || 1, fmtS = [].concat(R.sampleFormat || 1)[0], le = R.littleEndian, by = bps / 8;
  if (!W || !H || ![8, 16, 32].includes(bps) || (R.planar === 2 && spp > 1)) return false;
  const rps = R.rowsPerStrip || H, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sc = Math.max(1, Math.ceil(Math.max(W, H) / 480)), w = Math.ceil(W / sc), h = Math.ceil(H / sc), nc = spp >= 3 ? 3 : 1;
  const nd = num(tv(e, "GDALNoData", /^EXIF:IFD0$/));
  const val = (x, y, c) => {
    const s = Math.floor(y / rps), so = R.offsets[s]; if (so == null) return NaN;
    const o = so + (((y % rps) * W + x) * spp + c) * by; if (o + by > b.length) return NaN;
    if (bps === 8) return b[o]; if (bps === 16) return fmtS === 2 ? dv.getInt16(o, le) : dv.getUint16(o, le);
    return fmtS === 3 ? dv.getFloat32(o, le) : fmtS === 2 ? dv.getInt32(o, le) : dv.getUint32(o, le);
  };
  const vals = new Float32Array(w * h * nc); const smp = [[], [], []];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < nc; c++) { const v = val(x * sc, y * sc, c); vals[(y * w + x) * nc + c] = v; if (isFinite(v) && v !== nd && ((x + y) % 3 === 0)) smp[c].push(v); }
  const lo = [], hi = [];
  for (let c = 0; c < nc; c++) { const a = smp[c].sort((p, q) => p - q); lo[c] = a.length ? a[Math.floor(a.length * 0.02)] : 0; hi[c] = a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.98))] : 1; if (hi[c] <= lo[c]) hi[c] = lo[c] + 1; }
  cv.width = w; cv.height = h; const cx = cv.getContext("2d"), im = cx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) { const c = nc === 3 ? k : 0, v = vals[i * nc + c]; im.data[i * 4 + k] = isFinite(v) && v !== nd ? Math.max(0, Math.min(255, (v - lo[c]) / (hi[c] - lo[c]) * 255)) : 0; im.data[i * 4 + 3] = 255; }
  cx.putImageData(im, 0, 0); return true;
}

/* ---------------------------------------------------------------- canvas helpers */
function cvx(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(3, window.devicePixelRatio || 1), w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, w, h); return { c, w, h };
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p; }
const RTK_ST = { fixed: ["ok", "●"], ppk: ["ok", "◎"], float: ["warn", "▲"], int: ["warn", "▼"], single: ["bad", "■"], rtk: ["info", "◆"], none: ["bad", "✕"], other: ["na", "?"] };
function marker(c, x, y, s, r, col) {
  c.fillStyle = col; c.strokeStyle = cssv("--panel"); c.lineWidth = 2; c.beginPath();
  if (s === "float") { c.moveTo(x, y - r * 1.2); c.lineTo(x + r * 1.1, y + r * .8); c.lineTo(x - r * 1.1, y + r * .8); c.closePath(); }
  else if (s === "int") { c.moveTo(x, y + r * 1.2); c.lineTo(x + r * 1.1, y - r * .8); c.lineTo(x - r * 1.1, y - r * .8); c.closePath(); }
  else if (s === "single" || s === "none") c.rect(x - r, y - r, 2 * r, 2 * r);
  else c.arc(x, y, r, 0, 2 * Math.PI);
  c.stroke(); c.fill();
}
const ENU = (lat0, lon0) => (lat, lon) => [(lon - lon0) * Math.PI / 180 * 6378137 * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * Math.PI / 180 * 6378137];
function footprintPoly(S, x, y) {
  if (!S.footprint) return null; const yaw = (S.gimbal && S.gimbal.yaw != null ? S.gimbal.yaw : S.flight && S.flight.yaw != null ? S.flight.yaw : 0) * Math.PI / 180;
  const a = [Math.sin(yaw), Math.cos(yaw)], q = [Math.cos(yaw), -Math.sin(yaw)], fw = S.footprint[0] / 2, fh = S.footprint[1] / 2;
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([i, j]) => [x + q[0] * fw * i + a[0] * fh * j, y + q[1] * fw * i + a[1] * fh * j]);
}
function drawScale(c, x, y, ppm, maxPx, fg) {
  const m = niceStep(maxPx / ppm), px = m * ppm;
  c.strokeStyle = fg; c.lineWidth = 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + px, y); c.moveTo(x, y - 4); c.lineTo(x, y + 2); c.moveTo(x + px, y - 4); c.lineTo(x + px, y + 2); c.stroke();
  c.fillStyle = fg; c.font = "11px " + cssv("--f-mono"); c.textAlign = "left"; c.textBaseline = "bottom"; c.fillText(fmt(m, 0) + " m", x, y - 4);
}
function drawNorth(c, x, y, fg) { c.fillStyle = fg; c.beginPath(); c.moveTo(x, y - 12); c.lineTo(x + 6, y + 4); c.lineTo(x, y); c.lineTo(x - 6, y + 4); c.closePath(); c.fill(); c.font = "700 11px " + cssv("--f-body"); c.textAlign = "center"; c.textBaseline = "top"; c.fillText(t("north"), x, y + 6); }
function drawLocator() {
  const cv = $("#locCv"), e = cur(); if (!cv || !e) return; const S = e.res.summary; if (S.lat == null) return;
  const { c, w, h } = cvx(cv), fg = cssv("--fg"), mu = cssv("--muted"), gr = cssv("--grid"), ac = cssv("--accent");
  c.fillStyle = cssv("--plot-bg"); c.fillRect(0, 0, w, h);
  const fpp = footprintPoly(S, 0, 0), ext = fpp ? Math.max(...fpp.map(p => Math.hypot(p[0], p[1]))) * 1.35 : 120;
  const ppm = Math.min(w, h) / 2 / ext, X = x => w / 2 + x * ppm, Y = y => h / 2 - y * ppm;
  /* graticule */
  const dLat = ext / 111320, dLon = ext / (111320 * Math.cos(S.lat * Math.PI / 180));
  const nlines = w < 300 ? 2 : 3, stLat = niceStep(dLat * 2 / nlines), stLon = niceStep(dLon * 2 / nlines * (w / h));
  const dg = Math.max(0, -Math.floor(Math.log10(stLat))), dgo = Math.max(0, -Math.floor(Math.log10(stLon)));
  c.strokeStyle = gr; c.lineWidth = 1; c.fillStyle = mu; c.font = "10px " + cssv("--f-mono");
  const en = ENU(S.lat, S.lon);
  for (let la = Math.ceil((S.lat - dLat * 1.5) / stLat) * stLat; la < S.lat + dLat * 1.5; la += stLat) { const yy = Y(en(la, S.lon)[1]); if (yy < 12 || yy > h - 4) continue; c.beginPath(); c.moveTo(0, yy); c.lineTo(w, yy); c.stroke(); if (yy < h - 40) { c.textAlign = "left"; c.textBaseline = "bottom"; c.fillText(fmt(la, dg, false) + "°", 3, yy - 1); } }
  let lastR = -1e9;
  for (let lo = Math.ceil((S.lon - dLon * 3) / stLon) * stLon; lo < S.lon + dLon * 3; lo += stLon) { const xx = X(en(S.lat, lo)[0]); if (xx < 40 || xx > w - 40) continue; c.beginPath(); c.moveTo(xx, 0); c.lineTo(xx, h); c.stroke(); const lb = fmt(lo, dgo, false) + "°", lw = c.measureText(lb).width; if (xx - lw / 2 > lastR + 8) { c.textAlign = "center"; c.textBaseline = "bottom"; c.fillText(lb, xx, h - 2); lastR = xx + lw / 2; } }
  /* footprint */
  if (fpp) { c.fillStyle = cssv("--accent-soft"); c.strokeStyle = ac; c.lineWidth = 1.5; c.beginPath(); fpp.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.closePath(); c.globalAlpha = .55; c.fill(); c.globalAlpha = 1; c.stroke(); }
  /* heading */
  const yaw = S.gimbal && S.gimbal.yaw != null ? S.gimbal.yaw : S.flight && S.flight.yaw != null ? S.flight.yaw : null;
  if (yaw != null) { const a = yaw * Math.PI / 180, L2 = Math.min(w, h) * .22; c.strokeStyle = fg; c.lineWidth = 2; c.beginPath(); c.moveTo(w / 2, h / 2); c.lineTo(w / 2 + Math.sin(a) * L2, h / 2 - Math.cos(a) * L2); c.stroke(); }
  /* sun */
  if (S.sun) { const a = S.sun.azimuth * Math.PI / 180, R2 = Math.min(w, h) / 2 - 16, sx = w / 2 + Math.sin(a) * R2, sy = h / 2 - Math.cos(a) * R2; c.strokeStyle = cssv("--warn"); c.fillStyle = cssv("--warn"); c.lineWidth = 1.5; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(w / 2, h / 2); c.lineTo(sx, sy); c.stroke(); c.setLineDash([]); c.beginPath(); c.arc(sx, sy, 6, 0, 2 * Math.PI); c.fill(); c.fillStyle = fg; c.font = "11px " + cssv("--f-body"); c.textAlign = "center"; const up = sy - h / 2 < 0 ? sy > 26 : sy > h - 40; c.textBaseline = up ? "bottom" : "top"; c.fillText(t("sunShort"), Math.max(16, Math.min(w - 16, sx)), sy + (up ? -9 : 9)); }
  marker(c, w / 2, h / 2, "fixed", 6, ac);
  drawNorth(c, w - 18, 20, fg); drawScale(c, 10, h - 18, ppm, w * .3, fg);
}
function batchFiles() { return st.files.filter(f => f.res && !f.busy); }
function drawTrack() {
  const cv = $("#trkCv"); if (!cv) return; const F = batchFiles().filter(f => f.res.summary.lat != null); const { c, w, h } = cvx(cv);
  c.fillStyle = cssv("--plot-bg"); c.fillRect(0, 0, w, h); if (!F.length) return;
  const lat0 = F.reduce((a, f) => a + f.res.summary.lat, 0) / F.length, lon0 = F.reduce((a, f) => a + f.res.summary.lon, 0) / F.length, en = ENU(lat0, lon0);
  const P = F.map(f => { const S = f.res.summary, p = en(S.lat, S.lon); return { f, S, x: p[0], y: p[1], fp: footprintPoly(S, p[0], p[1]) }; });
  let xs = [], ys = []; for (const p of P) { xs.push(p.x); ys.push(p.y); if (p.fp) for (const q of p.fp) { xs.push(q[0]); ys.push(q[1]); } }
  const pad = 26, x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), sp = Math.max(x1 - x0, y1 - y0, 20);
  const ppm = Math.min((w - 2 * pad) / Math.max(x1 - x0, 20), (h - 2 * pad - 14) / Math.max(y1 - y0, 20)), cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;
  const X = x => w / 2 + (x - cxm) * ppm, Y = y => (h - 14) / 2 - (y - cym) * ppm;
  void sp;
  c.lineWidth = 1; c.strokeStyle = cssv("--accent"); c.fillStyle = cssv("--accent-soft");
  for (const p of P) if (p.fp) { c.beginPath(); p.fp.forEach((q, i) => i ? c.lineTo(X(q[0]), Y(q[1])) : c.moveTo(X(q[0]), Y(q[1]))); c.closePath(); c.globalAlpha = .18; c.fill(); c.globalAlpha = .5; c.stroke(); c.globalAlpha = 1; }
  const order = P.slice().sort((a, b) => (a.S.utcMs || timeMs(a.S) || 0) - (b.S.utcMs || timeMs(b.S) || 0));
  c.strokeStyle = cssv("--muted"); c.lineWidth = 1.5; c.beginPath(); order.forEach((p, i) => i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y))); c.stroke();
  c.font = "600 10px " + cssv("--f-mono"); c.textBaseline = "bottom"; c.textAlign = "left";
  order.forEach((p, i) => { const s = p.S.rtk && p.S.rtk.state || "other", col = cssv("--" + (RTK_ST[s] || RTK_ST.other)[0]); const sel = p.f === cur(); marker(c, X(p.x), Y(p.y), s, sel ? 7 : 5, col); if (sel) { c.strokeStyle = cssv("--fg"); c.lineWidth = 1.5; c.beginPath(); c.arc(X(p.x), Y(p.y), 10, 0, 2 * Math.PI); c.stroke(); } c.fillStyle = cssv("--fg"); c.fillText(String(i + 1), X(p.x) + 6, Y(p.y) - 4); });
  drawNorth(c, w - 16, 18, cssv("--fg")); drawScale(c, 10, h - 6, ppm, w * .3, cssv("--fg"));
}
const timeMs = S => S.utcMs != null ? S.utcMs : S.localTime ? Date.parse(S.localTime + "Z") : null;
function drawAlt() {
  const cv = $("#altCv"); if (!cv) return; const { c, w, h } = cvx(cv), fg = cssv("--fg"), mu = cssv("--muted"), gr = cssv("--grid");
  c.fillStyle = cssv("--plot-bg"); c.fillRect(0, 0, w, h);
  const F = batchFiles().map(f => ({ f, S: f.res.summary })).filter(p => timeMs(p.S) != null).sort((a, b) => timeMs(a.S) - timeMs(b.S));
  const useRel = F.some(p => p.S.altRel != null), key = useRel ? "altRel" : "altGPS";
  const P = F.filter(p => p.S[key] != null); if (P.length < 1) { c.fillStyle = mu; c.font = "13px " + cssv("--f-body"); c.textAlign = "center"; c.fillText(t("noAlt"), w / 2, h / 2); return; }
  const t0 = timeMs(P[0].S), tt = P.map(p => (timeMs(p.S) - t0) / 1000), aa = P.map(p => p.S[key]);
  let a0 = Math.min(...aa), a1 = Math.max(...aa); if (a1 - a0 < 4) { const m = (a0 + a1) / 2; a0 = m - 2; a1 = m + 2; } const pa = (a1 - a0) * .15; a0 -= pa; a1 += pa;
  const T1 = Math.max(1, Math.max(...tt)), l = 46, r = 12, tp = 22, bt = 30, X = s => l + 10 + s / T1 * (w - l - r - 20), Y = a => tp + (a1 - a) / (a1 - a0) * (h - tp - bt);
  c.font = "10px " + cssv("--f-mono"); c.fillStyle = mu; c.strokeStyle = gr; c.lineWidth = 1;
  const sa = niceStep((a1 - a0) / 4); for (let a = Math.ceil(a0 / sa) * sa; a <= a1; a += sa) { c.beginPath(); c.moveTo(l, Y(a)); c.lineTo(w - r, Y(a)); c.stroke(); c.textAlign = "right"; c.textBaseline = "middle"; c.fillText(fmt(a, sa < 1 ? 1 : 0), l - 4, Y(a)); }
  const ss = niceStep(T1 / (w < 300 ? 3 : 5)); for (let s = 0; s <= T1 + 1e-9; s += ss) { c.textAlign = "center"; c.textBaseline = "top"; c.fillText(fmt(s, 0), X(s), h - bt + 4); }
  c.textAlign = "left"; c.textBaseline = "top"; c.fillStyle = mu; c.font = "11px " + cssv("--f-body"); c.fillText(t(useRel ? "altAxisRel" : "altAxisGps"), l, 4); c.textAlign = "right"; c.textBaseline = "bottom"; c.fillText(t("tAxis"), w - r, h - 2);
  c.strokeStyle = cssv("--accent"); c.lineWidth = 2; c.beginPath(); P.forEach((p, i) => i ? c.lineTo(X(tt[i]), Y(aa[i])) : c.moveTo(X(tt[i]), Y(aa[i]))); c.stroke();
  P.forEach((p, i) => { const s = p.S.rtk && p.S.rtk.state || "other"; marker(c, X(tt[i]), Y(aa[i]), s, p.f === cur() ? 6 : 4, cssv("--" + (RTK_ST[s] || RTK_ST.other)[0])); });
  void fg;
}

/* ---------------------------------------------------------------- rendering: shell */
function applyStatic() {
  document.documentElement.lang = L;
  document.querySelectorAll("[data-i]").forEach(el => { el.innerHTML = t(el.dataset.i); });
  document.querySelectorAll("[data-ia]").forEach(el => el.setAttribute("aria-label", t(el.dataset.ia)));
  if ($("#lang-cs")) { $("#lang-cs").setAttribute("aria-pressed", L === "cs"); $("#lang-en").setAttribute("aria-pressed", L === "en"); }
  const sm = $("#samples"); if (sm) sm.innerHTML = Object.keys(SAMPLES).map(k => '<button data-smp="' + k + '" title="' + esc(t("smpT_" + k)) + '">' + esc(t("smp_" + k)) + "</button>").join("") + '<button data-smp="flight" title="' + esc(t("smpT_flight")) + '">' + esc(t("smpFlight")) + "</button>";
  renderTasksFooter();
}
function renderTasksFooter() {
  if ($("#tasks")) $("#tasks").innerHTML = T[L].tasks.map((x, i) => '<article class="task"><h3>' + (i + 1) + " · " + esc(x[0]) + "</h3><p>" + x[1] + "</p></article>").join("");
  $("#foot").innerHTML = t("footer");
}
function setTab(k) { st.tab = k; ["ov", "tags", "osl", "batch", "flt"].forEach(x => { $("#t-" + x).setAttribute("aria-pressed", x === k); $("#p-" + x).hidden = x !== k; }); renderTab(); }
function renderAll() { renderFiles(); renderWarn(); renderPriv(); renderSteps(); renderTab(); }
// the three steps: images, flight log (optional), OpenSkyLab check; each shows where it stands
function renderSteps() {
  const F = batchFiles(), FS = flightState(), busy = st.files.some(f => f.busy) || (st.logs || []).some(l => l.busy), set = (k, txt, state) => { const el = $("#s-" + k); if (el) { el.textContent = txt; el.parentNode.parentNode.dataset.state = state; } };
  set("ov", F.length ? t("stepImgN", F.length) : t("stepImg0"), F.length ? "done" : "todo");
  const m = FS.F ? FS.F.matches.filter(x => x.log).length : 0;
  set("flt", FS.logs.length ? t("stepLogN", FS.logs.length, m, F.length) : t("stepLog0"), FS.logs.length ? (F.length && !m ? "warn" : "done") : "opt");
  const e = cur(); if (!e || busy) { set("osl", e ? t("reading") : t("stepOsl0"), "todo"); return; }
  const lv = LVL[st.profile], rows = oslEval(e).filter(r => lv.includes(r.level) && r.st !== "notapp"), have = rows.filter(r => r.st === "file" || r.st === "derived" || r.st === "log").length;
  set("osl", t("stepOslN", have, rows.length, t("prof_" + st.profile)), "done");
}
/* ---------------------------------------------------------------- flight quality report (one self-contained page to print or save as PDF) */
function reportHTML() {
  const F = batchFiles(), FS = flightState(), G = FS.G, e = cur(), lv = LVL[st.profile];
  const SC = { ok: ["#1b7f3b", "✓"], info: ["#2a62b8", "i"], warn: ["#b26b00", "!"], bad: ["#b3261e", "✕"] };
  const item = (state, title, det, why) => '<li><span class="st" style="color:' + SC[state][0] + ';border-color:' + SC[state][0] + '">' + SC[state][1] + "</span><div><b>" + esc(title) + "</b>" + (det ? '<div class="det">' + esc(dec(det)) + "</div>" : "") + (why ? '<div class="why">' + esc(why) + "</div>" : "") + "</div></li>";
  const why = k => (T[L].expl || {})[k] || (T.en.expl || {})[k] || "";
  const sec = (h, intro, items) => items.length ? "<h2>" + esc(h) + "</h2>" + (intro ? '<p class="note">' + esc(intro) + "</p>" : "") + "<ul>" + items.join("") + "</ul>" : "";
  const fl = FS.F ? FS.F.checks.map(c => item(c.state, fltT("fltC", c.key), fltVal(c.det), why(c.key))) : [];
  const bt = F.length >= 2 ? batchChecks(F).map(c => item(c.ok ? "ok" : "warn", t(c.key), c.det, why(c.key))) : [];
  const gm = G && G.checks ? G.checks.map(c => item(c.state, t(c.key), c.det, why(c.key))) : [];
  let osl = "";
  if (e) { const rows = oslEval(e).filter(r => lv.includes(r.level) && r.st !== "notapp"), have = rows.filter(r => /^(file|derived|log)$/.test(r.st)).length, miss = rows.filter(r => r.st === "missing" && r.level === "C");
    osl = "<h2>" + esc(t("repOslH")) + '</h2><p>' + esc(t("repOsl", t("prof_" + st.profile), have, rows.length, e.name)) + "</p>" + (miss.length ? '<p class="note">' + esc(t("repMissC")) + "</p><ul class=\"plain\">" + miss.map(r => "<li><code>" + esc(r.block + "." + r.field) + "</code> · " + esc(T[L].src[SRC_KEY[r.source]] || r.source) + "</li>").join("") + "</ul>" : ""); }
  const all = [].concat(FS.F ? FS.F.checks.map(c => c.state) : [], F.length >= 2 ? batchChecks(F).map(c => c.ok ? "ok" : "warn") : [], G && G.checks ? G.checks.map(c => c.state) : []), cnt = {}; for (const x of all) cnt[x] = (cnt[x] || 0) + 1;
  const models = [...new Set(F.map(f => [f.res.summary.make, f.res.summary.model].filter(Boolean).join(" ")).filter(Boolean))].join(", ");
  const head = '<dl><dt>' + esc(t("repImages")) + "</dt><dd>" + F.length + (models ? " · " + esc(models) : "") + "</dd><dt>" + esc(t("repLogs")) + "</dt><dd>" + (FS.logs.length ? FS.logs.map(l => esc(l.name) + " (" + esc(fltT("fltK", l.kind)) + ")").join("<br>") : esc(t("repNoLogs"))) + "</dd>" + (FS.F && FS.F.startMs != null ? "<dt>" + esc(t("repSpan")) + "</dt><dd>" + esc(fltTime(FS.F.startMs) + " – " + fltTime(FS.F.endMs)) + " UTC</dd>" : "") + "<dt>" + esc(t("repSum")) + "</dt><dd>" + ["ok", "info", "warn", "bad"].filter(k => cnt[k]).map(k => '<span style="color:' + SC[k][0] + '">' + SC[k][1] + " " + cnt[k] + "</span>").join(" · ") + "</dd></dl>";
  const css = "body{font:14px/1.45 system-ui,sans-serif;color:#1d1d1f;max-width:820px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:12px 0}dt{color:#555}dd{margin:0}ul{list-style:none;padding:0;margin:0}li{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #eee;break-inside:avoid}.st{flex:0 0 22px;height:22px;border:1.5px solid;border-radius:50%;text-align:center;font:700 13px/20px monospace}.det{font:12px/1.4 monospace;color:#333;overflow-wrap:anywhere}.why{font-size:12.5px;color:#555;margin-top:2px}.note,.foot{color:#555;font-size:12.5px}ul.plain li{display:list-item;border:0;padding:1px 0}code{font-size:12px}@media print{body{margin:0}a{color:inherit}}";
  return "<!doctype html><html lang=\"" + L + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + esc(t("repTitle")) + "</title><style>" + css + "</style></head><body><h1>" + esc(t("repTitle")) + '</h1><p class="note">' + esc(t("repGen", new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC", M.version, OSLFlight.VERSION)) + "</p>" + head +
    sec(t("repFltH"), FS.logs.length ? "" : t("repNoLogs"), fl) + sec(t("repGeoH"), G && G.checks && G.checks.length ? t(G.source === "log" ? "geoNoteLog" : "geoNoteImg") + (G.orient === "assumed" ? " " + t("geoAssumed") : "") : "", gm) + sec(t("repBatchH"), "", bt) + osl +
    '<p class="foot">' + esc(t("repFoot")) + "</p></body></html>\n";
}
function renderTab() { if (st.tab === "ov") renderOv(); else if (st.tab === "tags") renderTags(); else if (st.tab === "osl") renderOSL(); else if (st.tab === "flt") renderFlight(); else renderBatch(); }
function renderFiles() {
  const ul = $("#flist");
  if (!st.files.length) { ul.innerHTML = (st.logs && st.logs.length ? "" : '<li class="note">' + esc(t("noFiles")) + "</li>") + logListItems(); return; }
  ul.innerHTML = st.files.map((f, i) => {
    const r = f.res, n = r ? r.groups.reduce((a, g) => a + g.tags.length, 0) : 0;
    const sub = f.busy ? t("reading") : r ? r.file.type + " · " + fmtBytes(f.size) + " · " + t("nTags", fmt(n, 0)) + (f.sample ? " · " + t("synthetic") : "") : t("failed");
    return '<li><button class="fsel" data-f="' + i + '" aria-pressed="' + (i === st.cur) + '"><b>' + esc(f.name) + "</b><span>" + esc(sub) + '</span></button><button class="frm" data-rm="' + i + '" aria-label="' + esc(t("remove", f.name)) + '" title="' + esc(t("remove", f.name)) + '">×</button></li>';
  }).join("") + logListItems();
}
function renderWarn() {
  const e = cur(), box = $("#warnBox"); if (!e) { box.innerHTML = ""; return; }
  const W = e.res.warnings || []; if (!W.length) { box.innerHTML = '<p class="note small">' + esc(t("noWarn")) + "</p>"; return; }
  box.innerHTML = '<h2 style="margin-bottom:6px">' + esc(t("warnH", W.length)) + '</h2><ul class="warns">' + W.slice(0, 40).map(w => '<li class="' + (/^(parse|input|unknown-format|bad-tiff|derive)$/.test(w.code) ? "err" : "") + '">' + esc(T[L].warn[w.code] || T.cs.warn[w.code] || w.code) + "<small>" + esc(w.code + (w.text ? ": " + w.text : "") + (w.offset != null ? " @ " + hex8(w.offset) : "")) + "</small></li>").join("") + (W.length > 40 ? "<li>… " + (W.length - 40) + "</li>" : "") + "</ul>";
}

/* ---------------------------------------------------------------- privacy list */
function privItems(e) {
  const r = e.res, S = r.summary, out = [], all = [];
  for (const g of r.groups) for (const tg of g.tags) all.push([g.id, tg]);
  const find = re => all.filter(([g, tg]) => re.test(tg.name) && !/^(Composite|Derived|File)$/.test(g));
  const show = a => a.slice(0, 4).map(([g, tg]) => g + ":" + tg.name + (tg.binary ? "" : " = " + String(tg.display).slice(0, 60))).join("; ");
  if (S.lat != null) { const srcs = new Set(find(/^(GPSLatitude|Latitude|GPSCoordinates)$/).map(x => x[0])); out.push(["pGps", fmt(S.lat, 6, false) + ", " + fmt(S.lon, 6, false) + (srcs.size > 1 ? " · " + t("pGpsMulti", srcs.size) : "")]); }
  const ser = find(/Serial|UniqueID|CaptureUUID|CaptureId|FlightId|FlightUUID|DocumentID|InstanceID|UUID/i); if (ser.length) out.push(["pSerial", show(ser)]);
  const who = find(/^(Artist|OwnerName|By-line|Creator|Copyright|CopyrightNotice|XPAuthor|Contact|Credit|Rights|CreatorContactInfo.*|Writer-Editor|Photographer|CameraOwnerName)$/); if (who.length) out.push(["pWho", show(who)]);
  if (S.localTime || S.utc) out.push(["pTime", S.utc ? fmtTime(S.utc) : fmtTime(S.localTime)]);
  if (S.make || S.model || S.software) out.push(["pDevice", [S.make, S.model, S.software].filter(Boolean).join(" · ")]);
  const pv = (r.previews || []); if (pv.length) out.push(["pThumb", pv.map(p => p.kind + " (" + fmtBytes(p.length) + ")").join(", ")]);
  if (S.makerNote) out.push(["pMaker", S.makerNote.vendor + " · " + fmtBytes(S.makerNote.length)]);
  const hist = find(/^(History.*|DerivedFrom.*|OriginalDocumentID|CreatorTool|ProcessingSoftware|HostComputer)$/); if (hist.length) out.push(["pHist", show(hist)]);
  const txt = find(/^(ImageDescription|UserComment|Comment|XPComment|Caption-Abstract|Description|Title|ObjectName|Keywords|Subject|Headline|City|Sub-location|Province-State|Country.*|Location)$/); if (txt.length) out.push(["pText", show(txt)]);
  const C2 = S.c2pa;
  if (C2 && C2.manifests && C2.manifests.length) {
    const m = C2.manifests[C2.active] || C2.manifests[C2.manifests.length - 1], sg = m.signature;
    const gen = (m.genInfo || []).map(g => [g.name, g.version].filter(Boolean).join(" ")).filter(Boolean).join(", ") || m.generator;
    out.push(["pC2pa", [gen, sg && sg.signer ? [sg.signer.CN, sg.signer.O].filter(Boolean).join(", ") : null, m.actions.length ? m.actions.map(a => a.action).join(", ") : null, m.ingredients.length ? t("kC2Ingr") + ": " + m.ingredients.length : null, C2.count > 1 ? t("c2Store", C2.count) : null].filter(Boolean).join(" · ")]);
  }
  if (r.info && r.info.trailer) out.push(["pTrailer", fmtBytes(r.info.trailer.length) + " · " + r.info.trailer.note]);
  return out;
}
function renderPriv() {
  const box = $("#privBox"), btn = $("#privBtn"); btn.setAttribute("aria-expanded", st.priv); box.hidden = !st.priv; if (!st.priv) return;
  const e = cur(); if (!e) { box.innerHTML = '<p class="note">' + esc(t("noFile")) + "</p>"; return; }
  const it = privItems(e);
  box.innerHTML = '<p class="note small">' + esc(t("privIntro")) + '</p><ul class="privlist">' + (it.length ? it.map(([k, v]) => '<li><span aria-hidden="true">!</span><span><b>' + esc(t(k)) + "</b></span><small>" + esc(k === "pC2pa" ? v : dec(v)) + "</small></li>").join("") : "<li>" + esc(t("privNone")) + "</li>") + '</ul><p class="note small">' + t("privHow") + "</p>";
}

/* ---------------------------------------------------------------- tab: overview */
function kv(rows) { return '<dl class="kv">' + rows.filter(Boolean).map(r => "<dt>" + esc(r[0]) + "</dt><dd>" + r[1] + "</dd>").join("") + "</dl>"; }
function renderOv() {
  const P = $("#p-ov"), e = cur();
  if (!e) { P.innerHTML = '<div class="empty">' + esc(st.files.length ? t("reading") : t("noFile")) + "</div>"; return; }
  const r = e.res, S = r.summary, n = r.groups.reduce((a, g) => a + g.tags.length, 0);
  const th = thumbFor(e);
  let thumb = '<div class="ph">' + esc(t("noThumb")) + "</div>";
  if (th && th.url) thumb = '<img alt="' + esc(t("thumbAlt", e.name)) + '" src="' + th.url + '"><span class="cap">' + esc(th.cap === "file" ? t("capFile") : th.cap) + "</span>";
  else if (th && th.raster) thumb = '<canvas id="rasCv" role="img" aria-label="' + esc(t("thumbAlt", e.name)) + '"></canvas><span class="cap">' + esc(t("capStretch")) + "</span>";
  const jq = S.jpegQuality;
  const ident = kv([
    [t("kType"), esc(r.file.type) + " · " + fmtBytes(r.file.size) + (r.file.byteOrder ? " · " + esc(r.file.byteOrder === "II" ? t("boII") : t("boMM")) : "")],
    S.make || S.model ? [t("kCamera"), esc([S.make, S.model].filter(Boolean).join(" "))] : null,
    S.droneModel ? [t("kDrone"), esc(S.droneModel)] : null,
    S.serial ? [t("kSerial"), esc(S.serial) + " " + src(S.serialSrc)] : null,
    S.software ? [t("kSoftware"), esc(S.software)] : null,
    S.sensorType ? [t("kSensorType"), esc(t("stype_" + S.sensorType))] : null,
    S.width ? [t("kSize"), fmt(S.width, 0) + " × " + fmt(S.height, 0) + " px" + (S.sensorPxW && S.sensorPxW !== S.width ? " · " + t("kSensorPx", fmt(S.sensorPxW, 0) + " × " + fmt(S.sensorPxH, 0)) : "") + (S.bitDepth ? " · " + S.bitDepth + " bit" : "")] : null,
    jq ? [t("kJpegQ"), "≈ " + jq.quality + (jq.spread > .15 ? " " + esc(t("jqRough")) : "") + " " + src(t("jqSrc"))] : null,
    [t("kTags"), esc(t("nTagsGroups", fmt(n, 0), r.groups.length))],
    e.bytes || e.blob ? [t("kSha"), '<span class="mono small" id="shaOut">' + (e.sha ? e.sha.slice(0, 16) + "…" : "…") + "</span>"] : null
  ]);
  const head = '<div class="ovhead"><div class="thumb">' + thumb + '</div><div><h3 class="sub" style="overflow-wrap:anywhere">' + esc(e.name) + (e.sample ? ' <span class="chip s-na"><i>i</i>' + esc(t("synthetic")) + "</span>" : "") + "</h3>" + ident + "</div></div>";
  P.innerHTML = head + '<div class="cards">' + (S.geo ? cardGeoTiff(e) : "") + cardTime(e) + cardPos(e) + cardGeo(e) + cardExp(e) + cardGnss(e) + cardRad(e) + (S.geo ? "" : cardGeoTiff(e)) + cardC2pa(e) + "</div>" + byteMap(e);
  if (th && th.raster) { const cv = $("#rasCv"), fail = () => { if (cv.isConnected) cv.outerHTML = '<div class="ph">' + esc(t("noThumb")) + "</div>"; };
    // an uncompressed raster is read whole only while it is drawn, then released
    if (e.bytes) { try { if (!drawRaster(cv, e)) fail(); } catch (x) { fail(); } }
    else if (e.blob) e.blob.arrayBuffer().then(ab => { if (!cv.isConnected) return; try { if (!drawRaster(cv, e, new Uint8Array(ab))) fail(); } catch (x) { fail(); } }, fail); }
  const img = P.querySelector(".thumb img"); if (img) img.onerror = () => { img.parentNode.innerHTML = '<div class="ph">' + esc(t("noThumbDecode")) + "</div>"; };
  drawLocator(); updGsd();
}
const c2Date = s => { const m = /^(\d{4}):(\d\d):(\d\d)/.exec(s || ""); return m ? m[1] + "-" + m[2] + "-" + m[3] : esc(s || "–"); };
function cardC2pa(e) {
  const C = e.res.summary.c2pa; if (!C || !C.manifests || !C.manifests.length) return "";
  const m = C.manifests[C.active] || C.manifests[C.manifests.length - 1], sg = m.signature;
  const terms = Array.from(new Set(m.actions.filter(a => a.dst).map(a => a.term || a.dst))), ai = !!m.ai;
  const chips = (!sg ? chip("s-missing", "!", t("c2Unsigned")) : sg.unreadable ? chip("s-missing", "!", t("c2Unread")) : chip("s-na", "i", t("c2Signed"))) + (ai ? " " + chip("s-bad", "!", t("c2AI")) : "");
  const who = o => o ? [o.CN, o.O].filter(Boolean).map(esc).join(" · ") : "";
  const gen = (m.genInfo || []).map(g => esc([g.name, g.version].filter(Boolean).join(" "))).filter(Boolean).join(", ") || esc(m.generator || "");
  const acts = m.actions.slice(0, 8).map(a => "<li>" + (T[L].c2act[a.action] ? "<b>" + esc(T[L].c2act[a.action]) + "</b> " : "") + '<span class="mono small">' + esc(a.action) + "</span>" + (a.agent ? '<br><span class="small">' + esc(a.agent) + (a.when ? " · " + fmtTime(a.when) : "") + "</span>" : a.when ? '<br><span class="small">' + fmtTime(a.when) + "</span>" : "") + (a.description ? '<br><span class="small">' + esc(a.description.slice(0, 160)) + "</span>" : "") + "</li>").join("") + (m.actions.length > 8 ? "<li>… " + (m.actions.length - 8) + "</li>" : "");
  const dst = terms.map(x => "<b>" + esc(T[L].c2dst[x] || t("c2dstUnknown")) + '</b> <span class="mono small">' + esc(x) + "</span>").join("<br>");
  const ingr = m.ingredients.slice(0, 6).map(g => esc(g.title || g.format || "–") + ' <span class="small">(' + esc(T[L].c2rel[g.relationship] || g.relationship || "–") + ")</span>").join("<br>");
  const rows = [
    sg && sg.signer ? [t("kC2Signer"), who(sg.signer) + " " + src("COSE x5chain")] : null,
    sg && sg.issuer ? [t("kC2Issuer"), who(sg.issuer)] : null,
    sg && (sg.notBefore || sg.notAfter) ? [t("kC2Valid"), c2Date(sg.notBefore) + " – " + c2Date(sg.notAfter)] : null,
    gen ? [t("kC2Gen"), gen + " " + src("claim_generator_info")] : null,
    m.title ? [t("kC2Title"), esc(m.title)] : null,
    [t("kC2Manifest"), '<span class="mono small">' + esc(m.label) + '</span><br><span class="small">' + esc(t("c2Store", C.count)) + " · " + esc(t("c2Where", c2Cs(C.where))) + "</span>"],
    m.actions.length ? [t("kC2Actions"), '<ul class="c2l">' + acts + "</ul>"] : null,
    dst ? [t("kC2Source"), dst] : null,
    m.ingredients.length ? [t("kC2Ingr"), ingr] : null,
    m.hashes.length ? [t("kC2Hash"), esc(m.hashes.join(", ")) + '<br><span class="small">' + esc(t("c2HashNote")) + "</span>"] : null,
    sg && !sg.unreadable ? [t("kC2Tst"), esc(sg.tst ? t("c2Yes") : t("c2No"))] : null,
    m.other && m.other.length ? [t("kC2Other"), '<span class="mono small">' + esc(m.other.slice(0, 6).join(", ")) + "</span>"] : null
  ];
  const notes = (!sg ? '<p class="callout w">' + esc(t("c2NoSigNote")) + "</p>" : '<p class="callout">' + esc(t("c2NotVerified")) + "</p>") + (ai ? '<p class="callout w">' + esc(t("c2AiNote")) + "</p>" : "");
  return '<article class="card wide"><h3>' + esc(t("cC2pa")) + '</h3><p class="c2chips">' + chips + "</p>" + kv(rows) + notes +
    '<div class="links"><a href="https://contentcredentials.org/verify" target="_blank" rel="noopener noreferrer">' + esc(t("c2Verify")) + '</a></div><p class="note small">' + esc(t("c2VerifyNote")) + "</p></article>";
}
function cardTime(e) {
  const S = e.res.summary, dls = num(tv(e, "SolarElevation", /^XMP:DLS$/)), dlsA = num(tv(e, "SolarAzimuth", /^XMP:DLS$/));
  const rows = [
    [t("kLocal"), S.localTime ? fmtTime(S.localTime) : "–"],
    [t("kUtc"), S.utc ? fmtTime(S.utc) + " " + src(S.utcSrc) : '<span class="chip s-missing"><i>!</i>' + esc(t("utcUnknown")) + "</span>"],
    S.tz != null ? [t("kTz"), (S.tz < 0 ? "−" : "+") + String(Math.floor(Math.abs(S.tz) / 60)).padStart(2, "0") + ":" + String(Math.abs(S.tz) % 60).padStart(2, "0") + " " + src(S.tzSrc)] : null,
    S.sun ? [t("kSun"), t("sunVal", fmt(S.sun.elevation, 1), fmt(S.sun.azimuth, 1)) + " " + src("NOAA")] : null,
    isFinite(dls) ? [t("kSunDls"), t("sunVal", fmt(dls * 180 / Math.PI, 1), fmt(dlsA * 180 / Math.PI, 1)) + " " + src("XMP:DLS (rad)")] : null
  ];
  let note = "";
  if (!S.utc && S.localTime) note = '<p class="callout w">' + esc(t("noTzNote")) + "</p>";
  else if (S.utcSrc && /MicaSense/.test(S.utcSrc)) note = '<p class="callout">' + esc(t("micaUtcNote")) + "</p>";
  else if (S.tzSrc && /GPS/.test(S.tzSrc)) note = '<p class="callout">' + esc(t("tzFromGps")) + "</p>";
  else if (S.utcSrc && /QuickTime/.test(S.utcSrc)) note = '<p class="callout w">' + esc(t("qtUtcNote")) + "</p>";
  if (!S.localTime && !S.utc) return '<article class="card"><h3>' + esc(t("cTime")) + '</h3><p class="note">' + esc(t("noTime")) + "</p></article>";
  return '<article class="card"><h3>' + esc(t("cTime")) + "</h3>" + kv(rows) + note + "</article>";
}
function altRef(r) { return r === 1 ? t("ref1") : r === 2 ? t("ref2") : r === 3 ? t("ref3") : t("ref0"); }
function cardPos(e) {
  const S = e.res.summary;
  if (S.lat == null) return '<article class="card"><h3>' + esc(t("cPos")) + '</h3><p class="note">' + esc(t("noPos")) + "</p>" + (S.geo ? '<p class="note">' + esc(t("noPosGeo")) + "</p>" : "") + "</article>";
  const mapy = "https://mapy.cz/zakladni?x=" + S.lon.toFixed(6) + "&y=" + S.lat.toFixed(6) + "&z=17", osm = "https://www.openstreetmap.org/?mlat=" + S.lat.toFixed(6) + "&mlon=" + S.lon.toFixed(6) + "#map=17/" + S.lat.toFixed(6) + "/" + S.lon.toFixed(6);
  const vcs = tv(e, "VertCS", /^XMP:Camera$/);
  const rows = [
    [t("kLatLon"), '<span class="mono">' + fmt(S.lat, 6, false) + "°, " + fmt(S.lon, 6, false) + "°</span><br><span class=\"small\">" + dmsTxt(S.lat, t("dN"), t("dS")) + ", " + dmsTxt(S.lon, t("dE"), t("dW")) + "</span> " + src(S.posSrc)],
    S.altGPS != null ? [t("kAltGps"), fmt(S.altGPS, 2) + " m · " + esc(altRef(S.altGPSRef)) + " " + src("EXIF:GPS:GPSAltitude(Ref)")] : null,
    S.altAbs != null ? [t("kAltAbs"), fmt(S.altAbs, 2) + " m " + src("XMP:drone-dji:AbsoluteAltitude")] : null,
    S.altRel != null ? [t("kAltRel"), fmt(S.altRel, 2) + " m " + src("XMP:drone-dji:RelativeAltitude")] : null,
    S.altitudeType ? [t("kAltType"), esc(S.altitudeType) + " " + src("XMP:drone-dji:AltitudeType")] : null,
    S.mapDatum ? [t("kDatum"), esc(S.mapDatum)] : null,
    vcs ? [t("kVertCS"), esc(vcs) + " " + src("XMP:Camera:VertCS")] : null
  ];
  const diff = S.altGPS != null && S.altAbs != null && Math.abs(S.altGPS - S.altAbs) > 0.5 ? '<p class="callout w">' + esc(t("altDiff", fmt(S.altGPS - S.altAbs, 1))) + "</p>" : "";
  return '<article class="card tall"><h3>' + esc(t("cPos")) + '</h3><div class="loc"><canvas id="locCv" role="img" aria-label="' + esc(t("locAria")) + '"></canvas></div>' + kv(rows) + diff +
    '<div class="links"><a href="' + esc(mapy) + '" target="_blank" rel="noopener noreferrer">' + esc(t("openMapy")) + '</a><a href="' + esc(osm) + '" target="_blank" rel="noopener noreferrer">' + esc(t("openOsm")) + '</a></div><p class="note small">' + esc(t("locNote")) + "</p></article>";
}
function scaleRow(label, val, pos, lo, hi) { return '<div class="exprow"><span>' + esc(label) + '</span><div class="scale" aria-hidden="true"><div class="bar"></div>' + (pos == null ? "" : '<div class="mk" style="left:' + (Math.max(0, Math.min(1, pos)) * 100).toFixed(1) + '%"></div>') + '<span class="lo">' + lo + '</span><span class="hi">' + hi + "</span></div><b>" + val + "</b></div>"; }
function cardExp(e) {
  const S = e.res.summary; if (!S.exposureTime && !S.fnumber && !S.iso) return "";
  const lg = (v, a, b) => v ? (Math.log(v) - Math.log(a)) / (Math.log(b) - Math.log(a)) : null;
  const pr = S.exposureProgram != null ? (T[L].prog[S.exposureProgram] || String(S.exposureProgram)) : null, md = S.exposureMode != null ? (T[L].emode[S.exposureMode] || String(S.exposureMode)) : null;
  return '<article class="card"><h3>' + esc(t("cExp")) + (S.lv != null ? '<span class="small mono">LV ' + fmt(S.lv, 1) + "</span>" : "") + "</h3>" +
    scaleRow(t("kShutter"), fmtExp(S.exposureTime), lg(S.exposureTime, 1 / 8000, 30), "1/8000", "30 s") +
    scaleRow(t("kAperture"), S.fnumber ? "f/" + fmt(S.fnumber, 1) : "–", lg(S.fnumber, 1, 32), "f/1", "f/32") +
    scaleRow("ISO", S.iso ? fmt(S.iso, 0) : "–", lg(S.iso, 25, 25600), "25", "25600") +
    kv([pr ? [t("kProgram"), esc(pr)] : null, md ? [t("kMode"), esc(md)] : null, S.exposureBias != null ? [t("kBias"), fmt(S.exposureBias, 1) + " EV"] : null,
      S.exposureTimeDJI != null ? [t("kExpDji"), fmtExp(S.exposureTimeDJI) + " " + src("XMP:drone-dji:ExposureTime (µs)")] : null]) +
    '<p class="note small">' + esc(t("expNote")) + "</p></article>";
}
function cardGeo(e) {
  const S = e.res.summary; if (!S.focal && !S.pixelPitch) return "";
  if (st.H == null || st.Hfile !== e.id) { st.H = S.altRel != null && S.altRel > 1 ? Math.round(S.altRel) : 100; st.Hfile = e.id; }
  const rows = [
    S.focal ? [t("kFocal"), fmt(S.focal, 2) + " mm" + (S.focal35 ? " · " + t("k35", fmt(S.focal35, 0)) : "") + (S.crop ? " · crop " + fmt(S.crop, 2) : "")] : null,
    S.pixelPitch ? [t("kPitch"), fmt(S.pixelPitch, 3) + " µm " + src(t("pitchM_" + (/FocalPlane/.test(S.pixelPitchNote) ? "fp" : /Calibrated/.test(S.pixelPitchNote) ? "cf" : "35")))] : [t("kPitch"), esc(t("noPitch"))],
    S.sensorW ? [t("kSensor"), fmt(S.sensorW, 2) + " × " + fmt(S.sensorH, 2) + " mm"] : null,
    S.hfov ? [t("kFov"), fmt(S.hfov, 1) + "° × " + fmt(S.vfov, 1) + "°"] : null
  ];
  let gsd = "";
  if (S.pixelPitch && S.focal) {
    gsd = '<div class="ctl"><label for="hsl"><span>' + esc(t("kH")) + '</span><output id="hout" for="hsl"></output></label><input type="range" id="hsl" min="5" max="300" step="1" value="' + st.H + '">' +
      '<div class="seg">' + (S.altRel != null ? '<button class="btn small" data-h="' + Math.round(S.altRel) + '">RelativeAltitude ' + fmt(S.altRel, 1) + " m</button>" : "") + [50, 100, 120].map(v => '<button class="btn small" data-h="' + v + '">' + v + " m</button>").join("") + "</div></div>" +
      '<div class="big" id="gsdOut"></div><div id="gsdKv"></div><div class="formula" id="gsdF"></div><p class="note small">' + esc(t("gsdAssume")) + "</p>";
  }
  return '<article class="card"><h3>' + esc(t("cGeo")) + "</h3>" + kv(rows) + gsd + "</article>";
}
function updGsd() {
  const e = cur(), o = $("#gsdOut"); if (!e || !o) return; const S = e.res.summary, H = st.H, p = S.pixelPitch, f = S.focal;
  const g = p * 1e-6 * H / (f * 1e-3), fw = g * S.sensorPxW, fh = g * S.sensorPxH;
  $("#hout").textContent = fmt(H, 0) + " m"; const sl = $("#hsl"); if (sl && +sl.value !== H) sl.value = H;
  o.innerHTML = fmt(g * 100, 2) + " <small>" + esc(t("gsdUnit")) + "</small>";
  const blur = S.groundSpeed != null && S.exposureTime ? S.groundSpeed * S.exposureTime / g : null;
  $("#gsdKv").innerHTML = kv([[t("kFoot"), fmt(fw, 1) + " × " + fmt(fh, 1) + " m"], blur != null ? [t("kBlur"), fmt(blur, 2) + " px " + src(t("blurSrc", fmt(S.groundSpeed, 1), fmtExp(S.exposureTime))) + (blur > 1 ? " " + chip("s-missing", "!", t("blurHi")) : "")] : null]);
  $("#gsdF").textContent = "GSD = p · H / f = " + fmt(p, 3) + " µm · " + fmt(H, 0) + " m / " + fmt(f, 2) + " mm = " + fmt(g * 100, 2) + " cm";
  drawLocatorWithH();
}
function drawLocatorWithH() { const e = cur(); if (!e) return; const S = e.res.summary; if (S.pixelPitch && S.focal && S.sensorPxW) { const g = S.pixelPitch * 1e-6 * st.H / (S.focal * 1e-3); S.footprint = [g * S.sensorPxW, g * S.sensorPxH]; } drawLocator(); }
function cardGnss(e) {
  const S = e.res.summary, k = S.rtk || {}; if (!k.state && k.sx == null && k.hpe == null) return "";
  const s = k.state, ic = s ? RTK_ST[s] || RTK_ST.other : null;
  const head = s ? '<span class="chip s-' + ({ ok: "file", warn: "missing", bad: "bad", info: "derived", na: "na" })[ic[0]] + '"><i aria-hidden="true">' + ic[1] + "</i>" + esc(t("rtk_" + s)) + "</span>" : "";
  const cm = v => v == null ? "–" : fmt(v * 100, v < 0.1 ? 1 : 0);
  return '<article class="card"><h3>' + esc(t("cGnss")) + head + "</h3>" + kv([
    k.flag != null ? ["RtkFlag", String(k.flag) + " " + src("XMP:drone-dji:RtkFlag")] : null,
    k.gpsStatus ? ["GpsStatus", esc(k.gpsStatus)] : null,
    k.sx != null ? [t("kSigma"), cm(k.sx) + " / " + cm(k.sy) + " / " + cm(k.sz) + " cm " + src(k.sigmaSrc === "XMP:Camera" ? "XMP:Camera:GPSXYAccuracy, GPSZAccuracy" : "XMP:drone-dji:RtkStdLon, RtkStdLat, RtkStdHgt")] : null,
    k.diffAge != null ? [t("kDiffAge"), fmt(k.diffAge, 1) + " " + src("XMP:drone-dji:RtkDiffAge")] : null,
    k.hpe != null ? ["GPSHPositioningError", fmt(k.hpe, 2) + " m"] : null
  ]) + (s ? '<p class="callout' + (s === "fixed" ? "" : " w") + '">' + esc(t("rtkMean_" + s)) + "</p>" : "") + "</article>";
}
function cardRad(e) {
  const S = e.res.summary;
  if (S.thermal) {
    const p = S.thermal.parts || {}, bd = S.thermal.band, k = S.thermal.kind || "";
    const note = k === "ThermoTIFF" ? "thermalNoteTt" : /^temperature TIFF/.test(k) ? "thermalNoteConv" : /^thermal TIFF, 16-bit/.test(k) ? (bd && bd.wrap ? "thermalNoteWrap" : "thermalNote16") : "thermalNote";
    return '<article class="card"><h3>' + esc(t("cThermal")) + "</h3>" + kv([[t("kKind"), esc(S.thermal.kind)], bd ? [t("kValues"), esc(dec(String(+bd.min.toFixed(3)) + " … " + String(+bd.max.toFixed(3)) + (bd.mean != null ? " (" + t("kMean") + " " + (+bd.mean.toFixed(3)) + ")" : "")) + (bd.kind === "float32" ? "" : " (" + bd.kind + ")"))] : null, p.app3 ? ["APP3 ThermalData", fmtBytes(p.app3)] : null, p.app4 ? ["APP4 ThermalParams", fmtBytes(p.app4)] : null, p.app5 ? ["APP5 ThermalCalibration", fmtBytes(p.app5)] : null, p.flir ? ["APP1 FLIR", String(p.flir)] : null]) +
      '<p class="callout' + (note === "thermalNoteTt" ? "" : " w") + '">' + t(note) + "</p></article>";
  }
  if (!S.band && !S.irradiance) return "";
  const b = S.band || {}, ir = S.irradiance;
  return '<article class="card"><h3>' + esc(t("cRad")) + "</h3>" + kv([
    b.name ? [t("kBand"), esc(b.name) + " " + src(b.src)] : null,
    b.wl ? [t("kWl"), fmt(b.wl, 0) + " nm" + (b.fwhm ? " · FWHM " + fmt(b.fwhm, 0) + " nm" : b.halfWidth ? " · ± " + fmt(b.halfWidth, 0) + " nm" : "") + " " + src(b.wlSrc)] : null,
    ir ? [t("kIrr"), fmtA(ir.value, 5) + " " + (ir.unit ? "µW·cm⁻²·nm⁻¹" : esc(t("unitUnknown"))) + (ir.raw !== ir.value ? " (" + esc(t("irrRaw", fmtA(ir.raw, 5))) + ")" : "") + " " + src(ir.src)] : null,
    S.sensorGain ? [t("kGain"), fmtA(S.sensorGain.value, 4) + " " + src(S.sensorGain.src)] : null,
    S.sensorGainAdj != null ? ["SensorGainAdjustment", fmtA(S.sensorGainAdj, 6)] : null,
    S.blackLevel != null ? [t("kBlack"), esc(dec(Array.isArray(S.blackLevel) ? S.blackLevel.join(" ") : S.blackLevel)) + " DN"] : null,
    S.vignetting ? [t("kVig"), '<span class="small mono">' + esc(dec(String(Array.isArray(S.vignetting) ? S.vignetting.join(", ") : S.vignetting)).slice(0, 80)) + "</span>"] : null,
    S.dlsAttitude ? [t("kDlsAtt"), fmt(S.dlsAttitude.roll, 1) + "° / " + fmt(S.dlsAttitude.pitch, 1) + "° / " + fmt(S.dlsAttitude.yaw, 1) + "° " + src(S.dlsAttitude.src)] : null
  ]) + (ir && !ir.unit ? '<p class="callout w">' + esc(t("irrDjiNote")) + "</p>" : ir ? '<p class="callout">' + esc(t("irrMsNote")) + "</p>" : "") + "</article>";
}
function cardGeoTiff(e) {
  const S = e.res.summary, g = S.geo; if (!g) return "";
  const u = g.model === 2 ? "°" : " m";
  return '<article class="card"><h3>GeoTIFF</h3>' + kv([
    g.epsg ? [t("kCrs"), "EPSG:" + g.epsg + (g.epsgName ? " · " + esc(g.epsgName) : "")] : [t("kCrs"), esc(t("crsUnknown"))],
    g.vertical ? [t("kVcrs"), "EPSG:" + g.vertical] : null,
    g.pixelSize ? [t("kPix"), trimZ(fmtA(g.pixelSize[0], 4)) + " × " + trimZ(fmtA(g.pixelSize[1], 4)) + u] : null,
    g.ul ? [t("kUl"), '<span class="mono small">' + fmt(g.ul[0], g.model === 2 ? 6 : 2, false) + (L === "cs" ? "; " : ", ") + fmt(g.ul[1], g.model === 2 ? 6 : 2, false) + "</span>"] : null,
    g.extent ? [t("kExtent"), '<span class="mono small">' + g.extent.map(x => fmt(x, g.model === 2 ? 6 : 2, false)).join("; ") + "</span>"] : null,
    g.nodata != null ? ["NoData", esc(dec(g.nodata))] : null, g.rotated ? [t("kRot"), esc(t("yes"))] : null
  ]) + '<p class="note small">' + esc(t("geoNote")) + "</p></article>";
}
const KIND = { exif: "k1", xmp: "k2", icc: "k3", preview: "k4", thumb: "k4", mpf: "k4", thermal: "k5", image: "k6", iptc: "k7", text: "k7", jfif: "k7", maker: "k1", trailer: "k8", c2pa: "kc", header: "k0", other: "k9", gap: "k0" };
const KGRP = { exif: "exif", maker: "exif", xmp: "xmp", icc: "icc", preview: "preview", thumb: "preview", mpf: "preview", thermal: "thermal", image: "image", iptc: "text", text: "text", jfif: "text", trailer: "trailer", c2pa: "c2pa", header: "header", other: "header", gap: "header" };
function byteMapSegs(r) {
  const size = r.file.size, S = r.structure.slice().sort((a, b) => a.offset - b.offset || a.depth - b.depth || b.length - a.length), out = []; let end = 0;
  for (const s of S) {
    if (s.offset < end || s.offset >= size || !(s.length > 0)) continue;
    if (s.offset > end) out.push({ segment: "", kind: "gap", offset: end, length: s.offset - end });
    const len = Math.min(s.length, size - s.offset); out.push(Object.assign({}, s, { length: len })); end = s.offset + len;
  }
  if (end < size) out.push({ segment: "", kind: "gap", offset: end, length: size - end });
  /* merge runs of small header/gap pieces */
  const m = []; for (const s of out) { const p = m[m.length - 1]; if (p && (KGRP[p.kind] === "header") && KGRP[s.kind] === "header" && (s.length < size * .01 || p.length < size * .01)) { p.length = s.offset + s.length - p.offset; p.segment = p.segment && s.segment ? p.segment + ", " + s.segment : (p.segment || s.segment); p.kind = "header"; } else m.push(Object.assign({}, s)); }
  return m.slice(0, 400);
}
const plCs = (n, a, b, c) => n === 1 ? a : n >= 2 && n <= 4 ? b : c;
function c2Cs(x) { /* Czech wording of the parser's C2PA/JUMBF names, notes and locations */
  if (L !== "cs" || !x) return x;
  return String(x).replace(/C2PA manifest store/g, "úložiště manifestů C2PA").replace(/C2PA update manifest/g, "aktualizační manifest C2PA").replace(/C2PA manifest \(active\)/g, "manifest C2PA (aktivní)").replace(/C2PA manifest/g, "manifest C2PA")
    .replace(/C2PA assertion store/g, "úložiště tvrzení C2PA").replace(/C2PA claim signature/g, "podpis nároku C2PA").replace(/C2PA claim/g, "nárok C2PA").replace(/C2PA credential store/g, "úložiště pověření C2PA")
    .replace(/^(\d+) manifests?$/, (m, n) => n + " " + plCs(+n, "manifest", "manifesty", "manifestů")).replace(/^(\d+) assertions?$/, "$1 tvrzení").replace(/^box instance (\d+), sequence (\d+)/, "box $1, pořadí $2")
    .replace(/^purpose /, "účel ").replace(/JUMBF box (\d+), (\d+) segments?/, (m, b, n) => "box JUMBF " + b + ", " + n + " " + plCs(+n, "segment", "segmenty", "segmentů")).replace(/^PNG caBX chunk$/, "blok PNG caBX")
    .replace(/^TIFF tag /, "značka TIFF ").replace(/^WebP C2PA chunk$/, "blok WebP C2PA").replace(/^ISO BMFF uuid box \(purpose manifest\)$/, "box uuid ISO BMFF (účel manifest)")
    .replace(/^the last manifest in the store$/, "poslední manifest v úložišti").replace(/^hashes are not recomputed by this reader$/, "čtečka hashe nepřepočítává").replace(/^IPTC Digital Source Type vocabulary, /, "slovník IPTC Digital Source Type, ")
    .replace(/^type (\S+) /, "typ $1 ").replace(/ (\d+) bytes\b/g, " $1 bajtů").replace(/, content /, ", obsah ").replace(/, private box /, ", soukromý box ").replace(/, level (\d+)/, ", úroveň $1").replace(/, salted$/, ", se solí");
}
function segCs(x) { /* Czech labels for the parser's structure names and notes (identifiers such as APP1 or IFD0 stay as they are) */
  if (L !== "cs" || !x) return x;
  if (/C2PA|JUMBF|^\d+ (manifests?|assertions?)$|^box instance|^purpose /.test(x)) return c2Cs(x);
  return String(x).replace(/^(\d+) entries$/, (m, n) => n + " " + plCs(+n, "položka", "položky", "položek")).replace(/^not decoded$/, "nedekódováno").replace(/^decoded$/, "dekódováno")
    .replace(/^(\d+) strips$/, (m, n) => n + " " + plCs(+n, "pás", "pásy", "pásů")).replace(/^(\d+) tiles$/, (m, n) => n + " " + plCs(+n, "dlaždice", "dlaždice", "dlaždic")).replace(/^(\d+) extents$/, (m, n) => n + " " + plCs(+n, "úsek", "úseky", "úseků"))
    .replace(/^image data \(entropy-coded\)$/, "obrazová data (entropicky kódovaná)").replace(/^image data \((.*)\)$/, "obrazová data ($1)").replace(/^trailer after EOI$/, "data za EOI").replace(/^data after IEND$/, "data za IEND")
    .replace(/^embedded JPEG$/, "vložený JPEG").replace(/^primary image item /, "hlavní obrazová položka ").replace(/^MPF image (\d+) \(preview\)$/, "obraz MPF $1 (náhled)").replace(/^MPF image /, "obraz MPF ").replace(/^PNG signature$/, "podpis PNG").replace(/^RIFF header$/, "hlavička RIFF").replace(/^TIFF header$/, "hlavička TIFF");
}
function byteMap(e) {
  const r = e.res, segs = byteMapSegs(r), tot = {};
  for (const s of segs) tot[KGRP[s.kind] || "header"] = (tot[KGRP[s.kind] || "header"] || 0) + s.length;
  const bar = segs.map(s => { const lab = (segCs(s.segment) || t("bm_" + (KGRP[s.kind] || "header"))) + " · " + fmtBytes(s.length) + " @ " + hex8(s.offset); return '<span class="bseg" style="flex:' + Math.max(s.length, 1) + ' 1 0;background:var(--' + (KIND[s.kind] || "k9") + ')" title="' + esc(lab) + '"></span>'; }).join("");
  const order = ["exif", "xmp", "icc", "preview", "thermal", "image", "text", "c2pa", "trailer", "header"];
  const leg = order.filter(k => tot[k]).map(k => '<span><span class="sw" style="background:var(--' + ({ exif: "k1", xmp: "k2", icc: "k3", preview: "k4", thermal: "k5", image: "k6", text: "k7", c2pa: "kc", trailer: "k8", header: "k0" })[k] + ')"></span>' + esc(t("bm_" + k)) + " " + fmtBytes(tot[k]) + " (" + fmt(tot[k] / r.file.size * 100, tot[k] / r.file.size < .1 ? 1 : 0) + " %)</span>").join("");
  const rows = r.structure.slice(0, 1500).map(s => "<tr><td class=\"off\">" + hex8(s.offset) + '</td><td class="n">' + fmt(s.length, 0) + '</td><td style="padding-left:' + (8 + s.depth * 16) + 'px"><span class="sw" style="background:var(--' + (KIND[s.kind] || "k9") + ')"></span>' + esc(segCs(s.segment)) + "</td><td>" + esc(dec(segCs(s.note))) + "</td></tr>").join("");
  const trail = r.info && r.info.trailer ? '<p class="callout w">' + esc(t("trailerNote", fmtBytes(r.info.trailer.length), r.info.trailer.note)) + "</p>" : "";
  return '<div class="card" style="margin-top:12px"><h3>' + esc(t("cBytes")) + '<span class="small mono">' + fmtBytes(r.file.size) + '</span></h3><div class="bmap" role="img" aria-label="' + esc(t("bmAria")) + '">' + bar + '</div><div class="legend">' + leg + "</div>" + trail +
    '<details><summary class="small">' + esc(t("bmAll", r.structure.length)) + '</summary><div class="tw"><table><thead><tr><th>' + esc(t("thOffset")) + "</th><th>" + esc(t("thLen")) + "</th><th>" + esc(t("thSeg")) + "</th><th>" + esc(t("thNote")) + "</th></tr></thead><tbody>" + rows + "</tbody></table></div></details></div>";
}

/* ---------------------------------------------------------------- tab: all tags */
const GRP_NOTE = g => { const k = g.replace(/^(XMP|QuickTime|MPF|C2PA):.*$/, "$1:*"); return T[L].grp[g] || T[L].grp[k] || ""; };
function dispTag(gid, tg) {
  if (st.raw) { if (tg.binary) return "(binary, " + tg.binary.length + " bytes)"; const v = tg.value; if (v == null) return tg.display; return Array.isArray(v) ? v.map(x => typeof x === "number" ? String(x) : JSON.stringify(x)).join(" ") : typeof v === "string" ? v : String(v); }
  if (gid === "Derived" && T[L].der[tg.name]) { try { return T[L].der[tg.name](tg.value, tg); } catch (x) { /* fall through */ } }
  const numeric = typeof tg.value === "number" || (Array.isArray(tg.value) && tg.value.every(x => typeof x === "number")) || gid === "Composite" || (typeof tg.value === "string" && /^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(tg.value.trim()));
  return numeric ? dec(tg.display) : tg.display;
}
function renderTags() {
  const P = $("#p-tags"), e = cur(); if (!e) { P.innerHTML = '<div class="empty">' + esc(t("noFile")) + "</div>"; return; }
  if (!$("#q")) {
    P.innerHTML = '<div class="toolbar"><label class="sr" for="q">' + esc(t("search")) + '</label><input type="search" id="q" placeholder="' + esc(t("searchPh")) + '"><div class="seg" role="group" aria-label="' + esc(t("viewMode")) + '"><button id="m-f" aria-pressed="true">' + esc(t("formatted")) + '</button><button id="m-r" aria-pressed="false">' + esc(t("rawV")) + '</button></div></div>' +
      '<div class="toolbar"><button class="btn small" id="g-open">' + esc(t("openAll")) + '</button><button class="btn small" id="g-close">' + esc(t("closeAll")) + '</button><button class="btn small" id="x-json">' + esc(t("expJson")) + '</button><button class="btn small" id="x-csv">' + esc(t("expCsv")) + '</button><span class="count" id="tcount"></span></div><div id="tgroups"></div><p class="note small" id="tagsNote"></p>';
    $("#q").value = st.q;
  }
  $("#m-f").setAttribute("aria-pressed", !st.raw); $("#m-r").setAttribute("aria-pressed", st.raw);
  renderGroups();
}
function tagRows(gid, tags) {
  return tags.map(tg => {
    const v = dispTag(gid, tg), from = tg.from && tg.from.length ? '<span class="from">← ' + esc(tg.from.join(", ")) + "</span>" : "", nt = (gid === "Derived" || gid === "Composite") ? (T[L].derNote[tg.name] || (L === "en" ? tg.note : "") || "") : (tg.note ? (L === "en" ? tg.note : /^(C2PA|JUMBF)/.test(gid) ? c2Cs(tg.note) : tg.note.replace(/^first (\d+) of (\d+) values$/, "prvních $1 z $2 hodnot").replace(/^vendor: /, "výrobce: ")) : "");
    return '<tr><td class="nm">' + esc(tg.name) + '<span class="idm">' + esc(tg.id) + (tg.type ? " · " + esc(tg.type + (tg.count > 1 ? " ×" + tg.count : "")) : "") + '</span></td><td class="v">' + esc(String(v).slice(0, 2000)) + (String(v).length > 2000 ? "…" : "") + from + (nt ? '<span class="fn">' + esc(nt) + "</span>" : "") + '</td><td class="id">' + esc(tg.id).replace(/:/g, ":<wbr>") + '</td><td class="n">' + esc((tg.type || "") + (tg.count > 1 ? " ×" + tg.count : "")) + '</td><td class="off">' + (tg.offset != null ? hex8(tg.offset) : "") + "</td></tr>";
  }).join("");
}
function renderGroups() {
  const e = cur(), box = $("#tgroups"); if (!e || !box) return;
  const q = st.q.trim().toLowerCase(); let nT = 0, nM = 0;
  const html = e.res.groups.map(g => {
    nT += g.tags.length;
    const tags = q ? g.tags.filter(tg => (g.id + " " + tg.name + " " + tg.id + " " + tg.display + " " + (tg.binary ? "" : tg.value)).toLowerCase().includes(q)) : g.tags;
    nM += tags.length; if (q && !tags.length) return "";
    const open = q ? true : st.open[g.id] != null ? st.open[g.id] : /^(File|EXIF:IFD0|EXIF:ExifIFD|EXIF:GPS|XMP:drone-dji|XMP:Camera|Composite|Derived|GeoTIFF|C2PA)$/.test(g.id);
    const gn = GRP_NOTE(g.id);
    return '<details class="grp" data-g="' + esc(g.id) + '"' + (open ? " open" : "") + "><summary>" + esc(g.id) + " <small>" + esc(t("nTags", tags.length + (q ? "/" + g.tags.length : ""))) + (gn ? " · " + esc(gn) : "") + (g.ns ? " · " + esc(g.ns) : "") + "</small></summary>" +
      (open ? '<div class="tw"><table class="tt"><colgroup><col class="c-nm"><col class="c-v"><col class="c-id"><col class="c-n"><col class="c-off"></colgroup><thead><tr><th>' + esc(t("thTag")) + "</th><th>" + esc(t("thValue")) + '</th><th class="id">ID</th><th class="n">' + esc(t("thType")) + '</th><th class="off">' + esc(t("thOffset")) + "</th></tr></thead><tbody>" + tagRows(g.id, tags) + "</tbody></table></div>" : "") + "</details>";
  }).join("");
  box.innerHTML = html || '<div class="empty">' + esc(t("noMatch")) + "</div>";
  $("#tcount").textContent = q ? t("matchCount", fmt(nM, 0), fmt(nT, 0)) : t("nTagsGroups", fmt(nT, 0), e.res.groups.length);
  $("#tagsNote").textContent = st.raw ? t("rawNote") : t("fmtNote");
}

/* ---------------------------------------------------------------- tab: OpenSkyLab check */
const SRC_KEY = { "Manual": "manual", "Repository": "repo", "Derived": "derived", "Flight log": "flightlog", "Field record": "field", "Calibration": "calib", "EXIF/XMP": "exif", "Calib. file": "calibfile", "Panel certificate": "panel", "Literature / measurement": "lit", "Specification": "spec", "Sensor log": "sensorlog", "Weather station": "weather", "Observation": "obs", "Processing log": "proclog" };
function batchStats() {
  const F = batchFiles(), S = F.map(f => f.res.summary), B = { n: F.length };
  const ut = S.map(s => s.utcMs).filter(x => x != null).sort((a, b) => a - b); if (ut.length) { B.t0 = new Date(ut[0]).toISOString(); B.t1 = new Date(ut[ut.length - 1]).toISOString(); }
  B.noUtc = S.filter(s => s.utcMs == null).length;
  const ll = S.filter(s => s.lat != null); if (ll.length) { B.bbox = [Math.min(...ll.map(s => s.lon)), Math.min(...ll.map(s => s.lat)), Math.max(...ll.map(s => s.lon)), Math.max(...ll.map(s => s.lat))]; B.centroid = [ll.reduce((a, s) => a + s.lat, 0) / ll.length, ll.reduce((a, s) => a + s.lon, 0) / ll.length]; }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null, med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  B.agl = mean(S.map(s => s.altRel).filter(x => x != null)); B.speed = mean(S.map(s => s.groundSpeed).filter(x => x != null)); B.gsd = mean(S.map(s => s.gsd).filter(x => x != null));
  B.gp = med(S.map(s => s.gimbal && s.gimbal.pitch).filter(x => x != null));
  const gpa = S.map(s => s.gimbal && s.gimbal.pitch).filter(x => x != null); if (gpa.length) { B.tiltMax = Math.max(...gpa.map(p => 90 - Math.abs(p))); B.oblique = B.tiltMax > 15; }
  const rs = new Set(S.map(s => s.rtk && s.rtk.state).filter(Boolean)); B.gnss = rs.has("fixed") || rs.has("int") || rs.has("float") || rs.has("rtk") ? "RTK" : rs.has("single") ? "single" : null;
  return B;
}
function dewarp(e) { const d = tv(e, "DewarpData", /^XMP:drone-dji$/); if (!d) return null; const m = /^(\d{4}-\d\d-\d\d);(.*)$/.exec(String(d).trim()); if (!m) return null; const a = m[2].split(",").map(Number); return { date: m[1], fx: a[0], fy: a[1], cx: a[2], cy: a[3], k1: a[4], k2: a[5], p1: a[6], p2: a[7], k3: a[8] }; }
function oslRules(e, B) {
  const r = e.res, S = r.summary, R = {}, ms = S.sensorType === "multispectral", th = S.sensorType === "thermal_LWIR", geo = !!S.geo;
  const F = (k, val, srcs, note) => { R[k] = { st: "file", val, src: srcs, note }; }, D = (k, val, srcs, note) => { R[k] = { st: "derived", val, src: srcs, note }; };
  const X = (k, srcs, note) => { R[k] = { st: "missing", val: "", src: srcs, note }; };
  if (S.droneModel) F("sensor.platform_model", S.droneModel, "XMP:drone-dji:DroneModel"); else X("sensor.platform_model", "", "nPlatform");
  if (S.software) F("sensor.firmware", S.software, "EXIF:IFD0:Software", "nFirmware");
  if (S.make || S.model) F("sensor.sensor_model", [S.make, S.model].filter(Boolean).join(" "), "EXIF:IFD0:Make, Model");
  if (S.serial) F("sensor.sensor_serial", S.serial, S.serialSrc);
  if (S.sensorType) D("sensor.sensor_type", S.sensorType, S.thermal ? ({ "DJI R-JPEG": "JPEG APP3–APP5 (DJI)", "FLIR radiometric JPEG": "JPEG APP1 FLIR (FFF)", ThermoTIFF: "EXIF:IFD0:Software, ImageDescription (ThermoTIFF)" })[S.thermal.kind] || S.thermal.kind : S.band ? S.band.src : "File:FileType, ColorComponents", "nSensorType");
  if (S.sensorPxW) F("sensor.image_size", [S.sensorPxW, S.sensorPxH], tv(e, "ExifImageWidth") != null ? "EXIF:ExifIFD:ExifImageWidth, ExifImageHeight" : "ImageWidth, ImageHeight");
  if (S.bitDepth) F("sensor.bit_depth", S.bitDepth, "BitsPerSample");
  if (S.hfov) D("sensor.field_of_view", [+S.hfov.toFixed(2), +S.vfov.toFixed(2)], "Derived:FieldOfView", "nFov");
  if (S.pixelPitch) D("sensor.pixel_pitch", +S.pixelPitch.toFixed(4), (S.pixelPitchSrc || []).join(", "), "nPitch");
  if (S.focal) F("sensor.nominal_focal_length", S.focal, "EXIF:ExifIFD:FocalLength");
  if (S.band) F("sensor.bands", [S.band.name], S.band.src); else if (S.sensorType === "RGB") D("sensor.bands", ["R", "G", "B"], "ColorComponents = 3", "nBandsRgb");
  const dw = dewarp(e);
  if (dw) D("sensor.calibration_date", dw.date, "XMP:drone-dji:DewarpData", "nDewarpDate");
  /* geometry */
  if (S.calibratedFocalPx) F("geometry.calibrated_focal_length", S.calibratedFocalPx, "XMP:drone-dji:CalibratedFocalLength", "nCfPx");
  else if (tv(e, "PerspectiveFocalLength", /^XMP:Camera$/) != null) F("geometry.calibrated_focal_length", num(tv(e, "PerspectiveFocalLength", /^XMP:Camera$/)), "XMP:Camera:PerspectiveFocalLength", "nCfMm");
  if (S.opticalCenter && S.opticalCenter[0] != null) F("geometry.calibrated_optical_centre", S.opticalCenter, "XMP:drone-dji:CalibratedOpticalCenterX, Y", "nPx");
  else if (tv(e, "PrincipalPoint", /^XMP:Camera$/) != null) F("geometry.calibrated_optical_centre", String(tv(e, "PrincipalPoint", /^XMP:Camera$/)).split(/[ ,]+/).map(Number), "XMP:Camera:PrincipalPoint", "nMm");
  const roc = [num(tv(e, "RelativeOpticalCenterX", /^XMP:drone-dji$/)), num(tv(e, "RelativeOpticalCenterY", /^XMP:drone-dji$/))]; if (isFinite(roc[0])) F("geometry.relative_optical_centre", roc, "XMP:drone-dji:RelativeOpticalCenterX, Y", "nRoc");
  const pd = tv(e, "PerspectiveDistortion", /^XMP:Camera$/), pda = pd != null ? String(pd).split(/[ ,]+/).map(Number) : null;
  if (dw) { D("geometry.radial_distortion", [dw.k1, dw.k2, dw.k3], "XMP:drone-dji:DewarpData", "nDewarp"); D("geometry.tangential_distortion", [dw.p1, dw.p2], "XMP:drone-dji:DewarpData", "nDewarp"); D("geometry.distortion_model", "Brown–Conrady", "XMP:drone-dji:DewarpData", "nBc"); }
  else if (pda && pda.length >= 5) { F("geometry.radial_distortion", pda.slice(0, 3), "XMP:Camera:PerspectiveDistortion"); F("geometry.tangential_distortion", pda.slice(3, 5), "XMP:Camera:PerspectiveDistortion"); D("geometry.distortion_model", "Brown–Conrady", "XMP:Camera:ModelType", "nBc"); }
  if (S.vignetting) F("geometry.vignetting_coefficients", String(S.vignetting).split(/[ ,]+/).filter(Boolean).map(Number), V2(e, "VignettingData", "VignettingPolynomial"));
  if (S.blackLevel != null) F("geometry.black_level", Array.isArray(S.blackLevel) ? S.blackLevel : num(S.blackLevel), V2(e, "BlackLevel", "BlackLevel"));
  /* multispectral */
  if (ms) {
    const b = S.band;
    F("multispectral.band_name", [b.name], b.src);
    if (b.wl) (b.wlSrc === "XMP:drone-dji:BandFreq" ? D : F)("multispectral.band_centre_wavelength", [b.wl], b.wlSrc, b.wlSrc === "XMP:drone-dji:BandFreq" ? "nBandFreq" : "");
    if (b.fwhm) F("multispectral.band_fwhm", [b.fwhm], "XMP:Camera:WavelengthFWHM"); else if (b.halfWidth) D("multispectral.band_fwhm", [2 * b.halfWidth], "XMP:drone-dji:BandFreq", "nFwhmDji");
    const drv = tv(e, "DarkRowValue", /^XMP:MicaSense$/); if (drv != null) F("multispectral.dark_current", [].concat(drv).map(Number), "XMP:MicaSense:DarkRowValue", "nDark");
    if (S.radiometricCal) F("multispectral.radiometric_gain", [].concat(S.radiometricCal).map(Number), "XMP:MicaSense:RadiometricCalibration", "nRadCal");
    if (S.sensorGain) (S.sensorGain.derived ? D : F)("multispectral.sensor_gain", S.sensorGain.value, S.sensorGain.src, S.sensorGain.derived ? "nGainMs" : "");
    if (S.sensorGainAdj != null) F("multispectral.sensor_gain_adjustment", S.sensorGainAdj, "XMP:drone-dji:SensorGainAdjustment");
    if (S.irradiance) (S.irradiance.unit && S.irradiance.raw !== S.irradiance.value ? D : F)("multispectral.dls_irradiance", +S.irradiance.value.toFixed(4), S.irradiance.src, S.irradiance.unit ? (S.irradiance.raw !== S.irradiance.value ? "nIrrConv" : "") : "nIrrUnit");
    if (S.dlsAttitude) (/rad/.test(S.dlsAttitude.src) ? D : F)("multispectral.dls_attitude", [S.dlsAttitude.roll, S.dlsAttitude.pitch, S.dlsAttitude.yaw].map(x => +x.toFixed(2)), S.dlsAttitude.src);
    const em = tv(e, "ExposureMode", /^EXIF:/); if (em != null && isFinite(+em)) F("multispectral.exposure_mode", +em === 1 ? "fixed" : "auto", "EXIF:ExifIFD:ExposureMode", "nExpMode");
  }
  if (th) {
    const T0 = S.thermal || {}, P0 = T0.params, TT = T0.thermotiff;
    if (S.sensorTemp != null) F("thermal.fpa_temperature", S.sensorTemp, "XMP:Camera:SensorTemperature", "nFpaXmp"); else X("thermal.fpa_temperature", "", /^DJI|^ThermoTIFF|^(temperature|thermal) TIFF/.test(T0.kind || "") ? "nFpaDji" : "nSdk");
    if (P0) {
      const p = {}; for (const [k, v] of Object.entries(P0)) if (k !== "src" && v != null) p[k] = v;
      F("thermal.capture_measurement_params", p, P0.src, "nCamSet");
      if (P0.emissivity != null) D("reference.emissivity_setting", P0.emissivity, P0.src, "nEmisCam");
    } else X("thermal.capture_measurement_params", "", TT ? "nTtCap" : /^(temperature|thermal) TIFF/.test(T0.kind || "") ? "nConvCap" : "nApp4");
    if (T0.encoding) D("thermal.image_encoding", T0.encoding, T0.encodingSrc, TT ? "nEncTt" : "nEnc");
    if (T0.planck) { const q = T0.planck; F("thermal.planck_constants", { R1: q.R1, B: q.B, F: q.F, O: q.O, R2: q.R2 }, q.src + ": PlanckR1, B, F, O, R2", "nPlanck"); }
    if (S.band && S.band.wl > 3000 && S.band.fwhm) D("thermal.spectral_range", [+((S.band.wl - S.band.fwhm / 2) / 1000).toFixed(2), +((S.band.wl + S.band.fwhm / 2) / 1000).toFixed(2)], "XMP:Camera:CentralWavelength, WavelengthFWHM", "nSpecRange");
    if (TT) {
      const p = {}; for (const [k, v] of Object.entries(TT.params)) if (v != null) p[k] = v;
      F("processing.thermal_settings", Object.assign({ method: "DJI Thermal SDK, raw values to temperature (degrees Celsius)" }, p, TT.source ? { source_image: TT.source } : {}), "EXIF:IFD0:ImageDescription", "nTtSet");
      F("processing.atmospheric_model", "DJI Thermal SDK built-in correction (method not published; inputs: object distance, relative humidity, ambient and reflected temperature)", "EXIF:IFD0:ImageDescription", "nTtAtm");
      F("processing.software", [{ name: "ThermoTIFF", version: TT.version || "" }, { name: "DJI Thermal SDK", version: TT.sdk_api ? "API " + TT.sdk_api : "" }], "EXIF:IFD0:Software, ImageDescription", "nTtSw");
    }
  }
  /* mission (from all loaded files) */
  const multi = B.n > 1 ? "nBatch" : "";
  if (B.t0) { D("mission.start_utc", B.t0, multi ? t("srcBatch", B.n) : S.utcSrc, multi); D("mission.end_utc", B.t1, multi ? t("srcBatch", B.n) : S.utcSrc, multi || "nOneImage"); }
  else if (S.localTime) { X("mission.start_utc", "", "nNoTz"); X("mission.end_utc", "", "nNoTz"); }
  if (B.centroid) D("mission.site_centroid", B.centroid.map(x => +x.toFixed(6)), B.n > 1 ? t("srcBatch", B.n) : S.posSrc, multi);
  if (B.agl != null) D("mission.nominal_agl", +B.agl.toFixed(1), "XMP:drone-dji:RelativeAltitude", "nAgl");
  if (B.speed != null) D("mission.nominal_ground_speed", +B.speed.toFixed(2), "FlightXSpeed, FlightYSpeed", multi || "nOneImage");
  if (B.gsd != null) D("mission.gsd_nominal", +(B.gsd * 100).toFixed(2), "Derived:GSD", "nGsd");
  if (B.gp != null) D("mission.gimbal_pitch_nominal", B.gp, "XMP:drone-dji:GimbalPitchDegree", multi || "nOneImage");
  if (B.n) D("mission.n_images", B.n, t("srcLoaded"), "nNImages");
  if (B.gnss) D("mission.gnss_mode", B.gnss, "XMP:drone-dji:RtkFlag", "nGnssMode");
  if (B.oblique != null) D("mission.oblique_images", B.oblique ? [true, +B.tiltMax.toFixed(1)] : false, "XMP:drone-dji:GimbalPitchDegree", multi ? "nOblique" : "nOneImage");
  /* environment */
  if (S.sun) { D("environment.solar_zenith", +(90 - S.sun.elevation).toFixed(2), "Derived:SunElevation (NOAA)", "nSun"); D("environment.solar_azimuth", +S.sun.azimuth.toFixed(2), "Derived:SunAzimuth (NOAA)", "nSun"); }
  if (S.lrf && S.lrf.measured) F("environment.sensor_target_distance", +S.lrf.distance.toFixed(3), "XMP:drone-dji:LRFTargetDistance", "nLrf");
  else if (S.altRel != null && S.gimbal && S.gimbal.pitch != null && S.gimbal.pitch < -80) D("environment.sensor_target_distance", S.altRel, "XMP:drone-dji:RelativeAltitude", S.lrf ? "nDistNoLrf" : "nDist");
  const amb = [["AmbientTemperature", "environment.air_temperature"], ["Humidity", "environment.relative_humidity"], ["Pressure", "environment.air_pressure"]];
  for (const [tg, k] of amb) { const v = tv(e, tg, /^EXIF:/); if (v != null) F(k, num(v), "EXIF:ExifIFD:" + tg, "nAmb"); }
  const W = wxFor(); if (W) { for (const [k, v] of Object.entries(W.vals)) if (v != null && !R["environment." + k]) D("environment." + k, v, k === "cloud_cover" ? W.src + ", in %" : W.src, "nWx"); if (!R["environment.weather_source"]) D("environment.weather_source", W.srcLong, W.src, "nWx"); }
  /* dataset */
  if (B.bbox) D("dataset.spatial_extent", B.bbox.map(x => +x.toFixed(6)), B.n > 1 ? t("srcBatch", B.n) : S.posSrc, "nBbox");
  if (B.t0) D("dataset.temporal_extent", B.t0 + "/" + B.t1, B.n > 1 ? t("srcBatch", B.n) : S.utcSrc, "nInterval");
  /* products (GeoTIFF) */
  if (geo) {
    const g = S.geo;
    if (g.epsg) { F("product.crs", "EPSG:" + g.epsg, g.epsg === tv(e, "ProjectedCSType", /^GeoTIFF$/) ? "GeoTIFF:ProjectedCSType" : "GeoTIFF:GeographicType"); F("processing.output_crs", "EPSG:" + g.epsg, "GeoTIFF"); }
    if (g.pixelSize && g.model === 1) D("product.gsd", +(g.pixelSize[0] * 100).toFixed(3), "EXIF:IFD0:PixelScale", "nProdGsd");
    if (g.extent) D("product.extent", g.extent.map(x => +x.toFixed(3)), "Derived:Extent");
    if (g.nodata != null) F("product.nodata", num(g.nodata), "EXIF:IFD0:GDALNoData");
    D("product.format", "GeoTIFF", "File:FileType, GeoTIFF keys");
    if (e.sha) D("product.checksum", "sha256:" + e.sha, t("srcSha"), "nSha");
    if (S.software) F("processing.software", [{ name: S.software, version: "" }], "EXIF:IFD0:Software", "nSoftware");
  }
  return R;
}
function V2(e, a, b) { return tv(e, a, /^XMP:drone-dji$/) != null ? "XMP:drone-dji:" + a : tv(e, b, /^XMP:Camera$/) != null ? "XMP:Camera:" + b : "EXIF:" + b; }
function oslEval(e) {
  const r = e.res, S = r.summary, B = batchStats(), R = oslRules(e, B), ms = S.sensorType === "multispectral", th = S.sensorType === "thermal_LWIR", geo = !!S.geo;
  const log = {}; for (const x of M.imageLog(r)) log[x.column] = x;
  return mergeFlight(e, OSL_STD.rows.map(row => {
    const [block, field, level, iso, stac, source, unit, , , module] = row, key = block + "." + field;
    let o = R[key];
    if (block === "image_log") {
      const x = log[field] || { value: "", status: "missing", source: "", note: "" };
      o = { st: x.status, val: x.value, src: x.source, note: x.note ? "il_" + x.note : "" };
      if (x.status === "missing" && x.note === "na") o.st = "notapp";
      if (x.status === "missing" && x.note === "manual") o.st = "missing";
    }
    if (!o) {
      if ((block === "multispectral" || module === "multispectral") && !ms) o = { st: "notapp", note: "nNotMs" };
      else if ((block === "thermal" || module === "thermal") && !th) o = { st: "notapp", note: "nNotTh" };
      else if (module === "environment" && !ms && !th) o = { st: "notapp", note: "nNotEnv" };
      else if (block === "product" && !geo) o = { st: "na", note: "nProduct" };
      else if ((source === "Manual" || source === "Repository") && /^(dataset|product|processing|reference)$/.test(block)) o = { st: "na", note: "nDataset" };
      else if (/^(reference|processing)$/.test(block)) o = { st: "na", note: block === "reference" ? "nRef" : "nProc" };
      else o = { st: "missing", note: "" };
    }
    return { block, field, level, iso, stac, source, unit, st: o.st, val: o.val, src: o.src, note: o.note };
  }));
}
// values from the flight logs and from the survey geometry; the image's own value is kept for comparison
const LOG_FIRST = /^mission\.(start_utc|end_utc|n_images|gnss_mode)$/;
function mergeFlight(e, rows) {
  const FS = flightState(), O = FS.O, G = FS.G, im = O.images[e.name], have = r => r.st === "file" || r.st === "derived";
  const geo = {}, gsrc = G && G.source === "log" ? t("srcGeoLog") : t("srcGeoImg", G ? G.n : 0);
  if (G && G.lines) {
    if (G.overlapForward != null) geo["mission.overlap_forward"] = Math.max(0, G.overlapForward);
    if (G.overlapSide != null) geo["mission.overlap_side"] = Math.max(0, G.overlapSide);
    if (G.pattern) geo["mission.flight_pattern"] = G.pattern;
    if (G.trigger) geo["mission.trigger_mode"] = G.trigger;
    if (G.speed != null) geo["mission.nominal_ground_speed"] = +G.speed.toFixed(2);
  }
  const S = e.res.summary, pg = (O.procGeom || []).filter(g => g.w === S.width && g.h === S.height), pgv = pg.length === 1 ? pg[0].vals : {};
  for (const r of rows) {
    const key = r.block + "." + r.field, x = r.block === "image_log" && im ? im.cols[r.field] : null, m = O.mission[key] || pgv[key];
    if (x) { r.img = have(r) ? r.val : null; r.imgSrc = r.img != null ? r.src : null; r.cmp = r.img != null ? OSLFlight.agree(r.field, r.val, x.val, im) : null;
      // heights: a difference is only judged when the image says its height is ellipsoidal; otherwise the number is shown, not a verdict
      if (r.cmp && r.field === "alt_ellipsoid_m" && r.note !== "ellipsoid-sensefly") { r.cmpDiff = +r.img - +x.val; r.cmp = "not_comparable"; }
      r.st = "log"; r.val = typeof x.val === "number" ? String(x.val) : x.val; r.src = x.src; r.note = x.note || ""; continue; }
    if (r.block === "image_log" && im && r.field === "alt_ellipsoid_m" && im.cols._hNote) r.logNote = im.cols._hNote;
    if (m && (!have(r) || LOG_FIRST.test(key))) { r.img = have(r) ? r.val : null; r.imgSrc = r.img != null ? r.src : null; r.cmp = r.img != null && key === "mission.gnss_mode" ? (String(r.img) === String(m.val) ? "same" : "differ") : null; r.st = "log"; r.val = m.val; r.src = m.src; r.note = m.note; if (m.log) r.log = m.log; continue; }
    if (geo[key] != null && !have(r) && !(m && m.note && /^nPlan/.test(m.note))) { r.st = "derived"; r.val = geo[key]; r.src = gsrc; r.note = "nGeo"; }
  }
  return rows;
}
// fields a flight log could still fill (used to invite a log when none is loaded)
const LOG_COLS = /^(timestamp_utc|lat_deg|lon_deg|alt_ellipsoid_m|rtk_flag|sigma_[xyz]_m)$/;
const logCould = r => r.st === "missing" && (r.source === "Flight log" || (r.block === "image_log" && LOG_COLS.test(r.field)));
const trimZ = s => s.replace(/([.,]\d*?)0+$/, "$1").replace(/[.,]$/, "");
function valTxt(v) { if (v == null || v === "") return ""; if (Array.isArray(v)) return v.map(x => typeof x === "number" ? trimZ(fmtA(x, 7)) : x && typeof x === "object" ? (x.name ? [x.order, x.name, x.version].filter(y => y != null && y !== "").join(" ") : JSON.stringify(x)) : String(x)).join("; "); if (typeof v === "object") return Object.entries(v).map(([k, x]) => k + ": " + (x && typeof x === "object" ? (Array.isArray(x) ? x.map(y => y && typeof y === "object" ? JSON.stringify(y) : y).join(", ") : "(" + Object.entries(x).map(([a, b]) => a + " " + (b && typeof b === "object" ? JSON.stringify(b) : b)).join(", ") + ")") : x)).join("; "); if (typeof v === "number") return trimZ(fmtA(v, 7)); return dec(String(v)); }
const LVL = { C: ["C"], Q: ["C", "Q"], F: ["C", "Q", "F", "O"] };
function renderOSL() {
  const P = $("#p-osl"), e = cur(); if (!e) { P.innerHTML = '<div class="empty">' + esc(t("noFile")) + "</div>"; return; }
  const rows = oslEval(e), lv = LVL[st.profile], vis = rows.filter(r => lv.includes(r.level));
  const cnt = { file: 0, derived: 0, log: 0, missing: 0, na: 0, notapp: 0 }; for (const r of vis) cnt[r.st]++;
  const tot = vis.length - cnt.notapp;
  const bar = ["file", "derived", "log", "missing", "na"].map(k => cnt[k] ? '<span style="flex:' + cnt[k] + ' 1 0;background:var(--' + ({ file: "ok", derived: "info", log: "accent", missing: "warn", na: "na" })[k] + ')" title="' + esc(t("st_" + k) + ": " + cnt[k]) + '"></span>' : "").join("");
  const filt = r => st.oslF === "all" ? true : st.oslF === "have" ? (r.st === "file" || r.st === "derived" || r.st === "log") : r.st === "missing";
  const where = r => r.st === "missing" ? (r.note && r.block === "image_log" ? "" : (T[L].src[SRC_KEY[r.source]] || r.source)) : r.st === "na" ? t(r.note || "nDataset") : "";
  const noteTxt = n => n ? (T[L].on[n] || T.cs.on[n] || "") : "";
  const isoTxt = (r, il) => il ? String(r.iso || "").replace(/^EXIF\/XMP:\s*/, "") : r.iso;
  const row = (r, il) => '<tr><td class="nm"><code>' + esc(r.field) + '</code> <span class="lv" title="' + esc(t("lv_" + r.level)) + '">' + r.level + '</span></td><td class="stc">' + stChipR(r) + '</td><td class="v">' + esc(valTxt(r.val)) + (r.src ? '<span class="from">← ' + esc(r.src) + "</span>" : "") + (r.img != null ? '<span class="from">' + esc(t("alsoImg")) + ": " + esc(valTxt(r.img)) + (r.imgSrc ? " ← " + esc(r.imgSrc) : "") + " " + cmpChip(r.cmp, r) + "</span>" : "") + (r.logNote ? '<span class="fn">' + esc(t("logHNote", r.logNote)) + "</span>" : "") + (where(r) ? '<span class="fn">' + esc(where(r)) + "</span>" : "") + (noteTxt(r.note) ? '<span class="fn">' + esc(noteTxt(r.note)) + "</span>" : "") + "</td>" +
    (il ? "" : '<td class="small mx" data-l="' + esc(t("thUnit")) + '">' + esc(r.unit || "—") + "</td>") + '<td class="small mx std"><span><b>STAC</b> ' + esc(r.stac || "—") + "</span><span><b>" + (il ? "EXIF/XMP" : "ISO 19115") + "</b> " + esc(isoTxt(r, il) || "—").replace(/\./g, ".<wbr>") + "</span></td></tr>";
  const head = il => '<colgroup><col class="c-f"><col class="c-s"><col class="c-v">' + (il ? "" : '<col class="c-u">') + '<col class="c-std"></colgroup><thead><tr><th>' + esc(il ? t("thColumn") : t("thField")) + " · " + esc(t("thLevel")) + "</th><th>" + esc(t("thStatus")) + "</th><th>" + esc(t("thValSrc")) + "</th>" + (il ? "" : "<th>" + esc(t("thUnit")) + "</th>") + "<th>STAC · " + (il ? "EXIF/XMP" : "ISO 19115") + "</th></tr></thead>";
  const il = vis.filter(r => r.block === "image_log" && filt(r));
  const blocks = ["dataset", "mission", "sensor", "geometry", "multispectral", "thermal", "environment", "reference", "processing", "product"];
  const bhtml = blocks.map(b => { const rs = vis.filter(r => r.block === b && filt(r)); if (!rs.length) return ""; const c2 = {}; for (const r of vis.filter(r => r.block === b)) c2[r.st] = (c2[r.st] || 0) + 1; return '<details class="grp blk"' + (st.open["osl:" + b] != null ? (st.open["osl:" + b] ? " open" : "") : (/^(sensor|geometry|mission|multispectral|thermal|environment)$/.test(b) ? " open" : "")) + ' data-o="osl:' + b + '"><summary>' + esc(b) + " <small>" + esc(T[L].blk[b] || "") + '</small><span class="minis">' + ["file", "derived", "log", "missing", "na", "notapp"].filter(k => c2[k]).map(k => '<span class="chip mini s-' + k + '" title="' + esc(t("st_" + k)) + '"><i aria-hidden="true">' + ST_ICON[k] + '</i><span class="sr">' + esc(t("st_" + k)) + ": </span>" + c2[k] + "</span>").join("") + '</span></summary><div class="tw"><table class="ot">' + head(false) + "<tbody>" + rs.map(r => row(r, false)).join("") + "</tbody></table></div></details>"; }).join("");
  const pname = t("prof_" + st.profile);
  P.innerHTML = '<div class="toolbar"><div class="tg"><span class="tl" aria-hidden="true">' + esc(t("profL")) + '</span><div class="seg" role="group" aria-label="' + esc(t("profAria")) + '">' + ["C", "Q", "F"].map(k => '<button data-prof="' + k + '" aria-pressed="' + (st.profile === k) + '">' + esc(t("prof_" + k)) + "</button>").join("") + '</div></div><div class="tg"><span class="tl" aria-hidden="true">' + esc(t("showL")) + '</span><div class="seg" role="group" aria-label="' + esc(t("filtAria")) + '">' + ["all", "have", "miss"].map(k => '<button data-of="' + k + '" aria-pressed="' + (st.oslF === k) + '">' + esc(t("of_" + k)) + "</button>").join("") + "</div></div></div>" +
    '<p class="sumtxt">' + t("sumTxt", pname, cnt.file + cnt.derived + cnt.log, tot, cnt.file, cnt.derived, cnt.missing, cnt.na, cnt.log) + '</p><div class="sumbar" role="img" aria-label="' + esc(t("sumAria")) + '">' + bar + '</div><div class="legend">' + ["file", "derived", "log", "missing", "na", "notapp"].filter(k => k !== "log" || cnt.log).map(k => stChip(k) + " " + cnt[k]).join(" ") + "</div>" + logCallout(rows) +
    '<p class="note small">' + t("oslIntro", B_n()) + "</p>" + wxBox() +
    '<h3 class="sub">' + esc(t("ilH")) + '</h3><p class="note small">' + t("ilNote") + '</p><div class="tw"><table class="ot il">' + head(true) + "<tbody>" + il.map(r => row(r, true)).join("") + '</tbody></table></div><div class="toolbar"><button class="btn small" id="x-il1">' + esc(t("expIl1")) + "</button></div>" +
    '<h3 class="sub">' + esc(t("mjH")) + '</h3><p class="note small">' + esc(t("mjNote")) + "</p>" + bhtml + exportBox();
}
const cmpChip = (c, r) => c === "same" ? chip("s-file", "=", t("cmpSame")) : c === "differ" ? chip("s-missing", "≠", t("cmpDiffer")) : c === "not_comparable" ? chip("s-na", "?", t("cmpNC", r && r.cmpDiff != null && isFinite(r.cmpDiff) ? fmt(r.cmpDiff, 2) : "–")) : "";
function logCallout(rows) {
  const FS = flightState();
  if (!FS.logs.length) { const n = rows.filter(logCould).length; return '<div class="callout"><p>' + t("logInvite", n) + '</p><button class="btn primary" id="pick2b">' + esc(t("pickLog")) + "</button></div>"; }
  const lv = LVL[st.profile]; rows = rows.filter(r => lv.includes(r.level)); const pj = rows.filter(r => r.st === "log" && /^nProc/.test(r.note || "")), nLog = FS.logs.filter(l => !((l.L || l).proc)).length;
  const pjTxt = pj.length ? " " + t("projUsed", pj.length) : "";
  if (!nLog) return '<div class="callout ok"><p>' + pjTxt.trim() + "</p></div>";
  const lg = rows.filter(r => r.st === "log" && !/^nProc/.test(r.note || "")), same = lg.filter(r => r.cmp === "same").length, diff = lg.filter(r => r.cmp === "differ"), im = FS.O.images[cur() ? cur().name : ""];
  return '<div class="callout ok"><p>' + t("logUsed", lg.length, nLog, same, diff.length) + (im ? " " + esc(t("logMatched", im.log, im.n)) : FS.imgs.length ? " " + esc(t("logNoMatch")) : "") + (diff.length ? '<br><small>' + esc(t("cmpDiffer")) + ": " + esc(diff.map(r => r.field).join(", ")) + "</small>" : "") + pjTxt + "</p></div>";
}
function exportBox() {
  const F = batchFiles(); if (!F.length) return "";
  return '<h3 class="sub" id="exportH">' + esc(t("expH")) + '</h3><p class="note small">' + esc(t("expIntro", F.length, flightState().logs.length)) + '</p><div class="toolbar"><button class="btn primary" id="x-rep">' + esc(t("expRep")) + '</button><button class="btn" id="x-mj">' + esc(t("expMj")) + '</button><button class="btn" id="x-pv">' + esc(t("expPv")) + '</button><button class="btn" id="x-il">' + esc(t("expIl")) + '</button><button class="btn" id="x-cam">' + esc(t("expCam")) + '</button><button class="btn" id="x-p4d">' + esc(t("expP4d")) + '</button><button class="btn" id="x-odm">' + esc(t("expOdm")) + '</button><button class="btn" id="x-gj">' + esc(t("expGj")) + '</button></div><p class="note small">' + t("expNote") + t("pvNote") + "</p>";
}
const B_n = () => batchFiles().length;

/* ---------------------------------------------------------------- weather archive (Open-Meteo): only after the user's explicit consent
   The request carries the flight's mean position rounded to 0.01° (about 1 km) and its dates; no file, name or other value leaves the browser.
   Values are hourly model or reanalysis values for a grid cell, so they are marked as estimates; a field record takes precedence. */
const WX_HOURLY = ["temperature_2m", "relative_humidity_2m", "surface_pressure", "cloud_cover", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation"];
const ENV_CSV_HEAD = "time_utc,air_temperature_c,relative_humidity_pct,air_pressure_hpa,wind_speed_ms,wind_direction_deg,cloud_cover_okta_or_pct,sky_condition,solar_zenith_deg,solar_azimuth_deg,incoming_irradiance_ground_wm2,surface_condition";
function wxParams() {
  const A = batchFiles().map(f => f.res.summary).filter(S => S.lat != null && S.lon != null); if (!A.length) return null;
  const lat = A.reduce((a, S) => a + S.lat, 0) / A.length, lon = A.reduce((a, S) => a + S.lon, 0) / A.length;
  let t0 = Infinity, t1 = -Infinity; for (const S of A) if (S.utcMs != null && isFinite(S.utcMs)) { if (S.utcMs < t0) t0 = S.utcMs; if (S.utcMs > t1) t1 = S.utcMs; }
  // the flight span from a log is preferred: it is UTC whatever the camera clock says
  const FS = flightState(), ms = (FS && FS.O && FS.O.mission) || {}, a = ms["mission.start_utc"], b = ms["mission.end_utc"];
  if (a && b) { const x = Date.parse(a.val), y = Date.parse(b.val); if (isFinite(x) && isFinite(y) && y >= x && y - x < 2 * 86400e3) { t0 = x; t1 = y; } }
  if (!isFinite(t0)) return { err: "wxNoUtc" };
  if (t1 - t0 > 2 * 86400e3) return { err: "wxLong" };
  if (t1 > Date.now() + 3600e3) return { err: "wxFuture" };
  const r2 = v => Math.round(v * 100) / 100, day = x => new Date(x).toISOString().slice(0, 10);
  return { lat: r2(lat), lon: r2(lon), t0, t1, d0: day(t0), d1: day(t1), key: [r2(lat), r2(lon), t0, t1].join("|") };
}
function wxFor() { const W = st.wx; if (!W || W.status !== "ok") return null; const p = wxParams(); return p && !p.err && p.key === W.key ? W : null; }
function wxSummary(j, p) {
  const H = j && j.hourly; if (!H || !Array.isArray(H.time)) throw new Error("no hourly data");
  const rows = H.time.map((tm, i) => { const o = { ms: Date.parse(tm + ":00Z") }; for (const k of WX_HOURLY) o[k] = H[k] ? H[k][i] : null; return o; }).filter(o => isFinite(o.ms));
  let sel = rows.filter(o => o.ms >= p.t0 - 1800e3 && o.ms <= p.t1 + 1800e3 && o.temperature_2m != null);
  if (!sel.length) { const mid = (p.t0 + p.t1) / 2, ok = rows.filter(o => o.temperature_2m != null).sort((x, y) => Math.abs(x.ms - mid) - Math.abs(y.ms - mid)); sel = ok.slice(0, 1); }
  if (!sel.length || Math.abs(sel[0].ms - (p.t0 + p.t1) / 2) > 3 * 3600e3 + (p.t1 - p.t0) / 2) throw new Error("wxNoData");
  const mean = k => { const v = sel.map(o => o[k]).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
  const mx = k => { const v = sel.map(o => o[k]).filter(x => x != null && isFinite(x)); return v.length ? Math.max(...v) : null; };
  const sum = k => { const v = sel.map(o => o[k]).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((a, x) => a + x, 0) : null; };
  let u = 0, w = 0; for (const o of sel) if (o.wind_speed_10m != null && o.wind_direction_10m != null) { const r = o.wind_direction_10m * Math.PI / 180; u += o.wind_speed_10m * Math.sin(r); w += o.wind_speed_10m * Math.cos(r); }
  const dir = u || w ? (Math.atan2(u, w) * 180 / Math.PI + 360) % 360 : mean("wind_direction_10m"), rd = (v, d) => v == null ? null : +v.toFixed(d);
  const hh = x => new Date(x).toISOString().slice(11, 16), h0 = hh(sel[0].ms), h1 = hh(sel[sel.length - 1].ms);
  return { rows: sel, h0, h1, day: new Date(sel[0].ms).toISOString().slice(0, 10), gLat: j.latitude, gLon: j.longitude, gust: rd(mx("wind_gusts_10m"), 1), precip: rd(sum("precipitation"), 1),
    vals: { air_temperature: rd(mean("temperature_2m"), 1), relative_humidity: rd(mean("relative_humidity_2m"), 0), air_pressure: rd(mean("surface_pressure"), 1), wind_speed: rd(mean("wind_speed_10m"), 1), wind_direction: rd(dir, 0), cloud_cover: rd(mean("cloud_cover"), 0) } };
}
async function wxFetch() {
  const p = wxParams(); if (!p || p.err) return;
  const recent = Date.now() - p.t1 < 6 * 86400e3, api = recent ? "forecast API (weather models)" : "historical weather API (reanalysis)";
  const url = (recent ? "https://api.open-meteo.com/v1/forecast" : "https://archive-api.open-meteo.com/v1/archive") + "?latitude=" + p.lat + "&longitude=" + p.lon + "&start_date=" + p.d0 + "&end_date=" + p.d1 + "&hourly=" + WX_HOURLY.join(",") + "&timezone=GMT&wind_speed_unit=ms";
  st.wx = { status: "loading", key: p.key }; renderOSL();
  try {
    const r = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }); let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || j.error) throw new Error((j && j.reason) || "HTTP " + r.status);
    const W = wxSummary(j, p), at = new Date().toISOString().slice(0, 10), n = W.rows.length;
    W.src = "Open-Meteo " + api + ", " + W.day + " " + W.h0 + (n > 1 ? "–" + W.h1 : "") + " UTC" + (n > 1 ? ", mean of " + n + " hourly values" : "");
    W.srcLong = "Open-Meteo.com " + api + " (data CC BY 4.0), grid cell at " + fmtLL(W.gLat, W.gLon) + ", hourly values " + W.day + " " + W.h0 + (n > 1 ? "–" + W.h1 : "") + " UTC, retrieved " + at + "; model values, not measured on site";
    st.wx = Object.assign(W, { status: "ok", key: p.key, recent });
  } catch (e) { const m = String(e && e.message || e); st.wx = { status: "err", key: p.key, err: m === "wxNoData" ? t("wxNoData") : m }; }
  renderOSL();
}
const fmtLL = (a, b) => (a == null || b == null) ? "?" : Math.abs(a).toFixed(2) + "° " + (a < 0 ? "S" : "N") + ", " + Math.abs(b).toFixed(2) + "° " + (b < 0 ? "W" : "E");
function wxBox() {
  const p = wxParams(); if (!p) return "";
  if (p.err) return '<div class="callout wx"><p>' + esc(t(p.err)) + "</p></div>";
  const W = st.wx && st.wx.key === p.key ? st.wx : null;
  if (W && W.status === "loading") return '<div class="callout wx"><p>' + esc(t("wxLoading")) + "</p></div>";
  if (W && W.status === "ok") return '<div class="callout wx ok"><p>' + t("wxOk", W) + '</p><button class="btn small" id="x-env">' + esc(t("wxCsv")) + "</button></div>";
  const ask = st.wxAsk === p.key;
  return '<div class="callout wx"><p>' + (W && W.status === "err" ? esc(t("wxErr", W.err)) + " " : "") + (ask ? esc(t("wxConfirm", fmtLL(p.lat, p.lon), p.d0 === p.d1 ? p.d0 : p.d0 + " – " + p.d1)) : esc(t("wxInvite"))) + "</p>" +
    (ask ? '<button class="btn primary" id="wx-go">' + esc(t("wxGo")) + '</button><button class="btn" id="wx-no">' + esc(t("wxNo")) + "</button>" : '<button class="btn" id="wx-ask">' + esc(t("wxAsk")) + "</button>") + "</div>";
}
function envCSV() {
  const W = wxFor(); if (!W) return ENV_CSV_HEAD + "\n"; const c = v => v == null ? "" : String(v);
  return ENV_CSV_HEAD + "\n" + W.rows.map(o => { const sp = M.solarPosition(o.ms, W.gLat != null ? W.gLat : 0, W.gLon != null ? W.gLon : 0);
    return [new Date(o.ms).toISOString().replace(/\.\d+Z$/, "Z"), c(o.temperature_2m), c(o.relative_humidity_2m), c(o.surface_pressure), c(o.wind_speed_10m), c(o.wind_direction_10m), c(o.cloud_cover), "", (90 - sp.elevation).toFixed(2), sp.azimuth.toFixed(2), "", ""].join(","); }).join("\n") + "\n";
}

/* ---------------------------------------------------------------- tab: batch */
function batchChecks(F) {
  const out = [], S = F.map(f => f.res.summary), nm = i => F[i].name;
  const add = (ok, key, det) => out.push({ ok, key, det });
  const ser = new Set(S.map(s => s.serial || "?")), mod = new Set(S.map(s => (s.make + " " + s.model).trim()));
  add(ser.size <= 1 && mod.size <= 1, ser.size > 1 || mod.size > 1 ? "chkSerialBad" : "chkSerialOk", ser.size > 1 || mod.size > 1 ? Array.from(mod).join(", ") + " · " + Array.from(ser).join(", ") : Array.from(mod)[0] || "");
  const ord = S.map((s, i) => ({ i, ms: timeMs(s) })).filter(x => x.ms != null).sort((a, b) => a.ms - b.ms);
  if (ord.length >= 3) { const gaps = []; for (let k = 1; k < ord.length; k++) gaps.push({ a: ord[k - 1].i, b: ord[k].i, d: (ord[k].ms - ord[k - 1].ms) / 1000 }); const md = gaps.map(g => g.d).sort((x, y) => x - y)[Math.floor(gaps.length / 2)]; const big = gaps.filter(g => g.d > Math.max(3 * md, md + 5)); add(!big.length, big.length ? "chkGapBad" : "chkGapOk", (big.length ? big.map(g => nm(g.a) + " → " + nm(g.b) + ": " + fmt(g.d, 1) + " s").join("; ") + " · " : "") + t("median", fmt(md, 1) + " s")); }
  const isos = new Set(S.map(s => s.iso)), exps = new Set(S.map(s => s.exposureTime && s.exposureTime.toPrecision(4))), modes = new Set(S.map(s => s.exposureMode)), progs = new Set(S.map(s => s.exposureProgram));
  if (isos.size > 1 || exps.size > 1 || modes.size > 1 || progs.size > 1) { const modeOf = a => { const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1); return Object.keys(c).sort((p, q) => c[q] - c[p])[0]; }; const mi = modeOf(S.map(s => String(s.iso))), me = modeOf(S.map(s => String(s.exposureTime && s.exposureTime.toPrecision(4)))), mm = modeOf(S.map(s => String(s.exposureMode))); const odd = S.map((s, i) => String(s.iso) !== mi || String(s.exposureTime && s.exposureTime.toPrecision(4)) !== me || String(s.exposureMode) !== mm ? nm(i) + " (" + fmtExp(s.exposureTime) + ", ISO " + (s.iso || "?") + ")" : null).filter(Boolean); add(false, "chkExpBad", odd.join("; ")); }
  else add(true, "chkExpOk", fmtExp(S[0].exposureTime) + ", ISO " + (S[0].iso || "?"));
  const nogps = S.map((s, i) => s.lat == null ? nm(i) : null).filter(Boolean); add(!nogps.length, nogps.length ? "chkGpsBad" : "chkGpsOk", nogps.join(", "));
  const rs = S.map(s => s.rtk && s.rtk.state || "–"), rset = new Set(rs);
  if (rset.size > 1) add(false, "chkRtkMixed", S.map((s, i) => rs[i] !== "fixed" ? nm(i) + ": " + t("rtk_" + (s.rtk && s.rtk.state || "none")) : null).filter(Boolean).join("; "));
  else add(rs[0] === "fixed", rs[0] === "fixed" ? "chkRtkOk" : "chkRtkSame", rs[0] === "–" ? t("rtkNoInfo") : t("rtk_" + rs[0]));
  const gp = S.map((s, i) => s.gimbal && s.gimbal.pitch != null && Math.abs(s.gimbal.pitch + 90) > 2 ? nm(i) + " (" + fmt(s.gimbal.pitch, 1) + "°)" : null).filter(Boolean), hasG = S.some(s => s.gimbal && s.gimbal.pitch != null);
  if (hasG) add(!gp.length, gp.length ? "chkGimbalBad" : "chkGimbalOk", gp.join("; "));
  const notz = S.map((s, i) => s.utcMs == null ? nm(i) : null).filter(Boolean); add(!notz.length, notz.length ? "chkTzBad" : "chkTzOk", notz.length === S.length ? t("allFiles") : notz.join(", "));
  const ar = S.map(s => s.altRel).filter(x => x != null); if (ar.length > 1) { const sp = Math.max(...ar) - Math.min(...ar); add(sp <= 5, sp <= 5 ? "chkAltOk" : "chkAltBad", fmt(Math.min(...ar), 1) + "–" + fmt(Math.max(...ar), 1) + " m"); }
  return out;
}
function renderBatch() {
  const P = $("#p-batch"), F = batchFiles();
  if (F.length < 2) { P.innerHTML = '<div class="empty">' + t("batchEmpty") + (Object.keys(FLIGHT).length ? '<br><button class="btn" data-smp="flight" style="margin-top:10px">' + esc(t("smpFlight")) + "</button>" : "") + "</div>"; return; }
  const ch = batchChecks(F);
  const serials = new Set(F.map(f => f.res.summary.serial || "–")), showSer = serials.size > 1;
  const day = x => x ? String(x).slice(0, 10) : "", days = new Set(F.map(f => day(f.res.summary.utc || f.res.summary.localTime)).filter(Boolean)), oneDay = days.size <= 1;
  const tShow = x => { const s2 = fmtTime(x); return oneDay ? s2.replace(/^\S+\s+/, "") : s2; };
  const rows = F.map(f => { const S = f.res.summary, i = st.files.indexOf(f), k = S.rtk && S.rtk.state; return '<tr class="' + (f === cur() ? "hl" : "") + '"><td class="n">' + (F.indexOf(f) + 1) + '</td><td class="fn0"><button class="btn small" data-f="' + i + '">' + esc(f.name) + '</button></td><td class="n">' + (S.utc ? tShow(S.utc) + " UTC" : S.localTime ? tShow(S.localTime) + " *" : "–") + '</td><td class="n">' + (S.lat != null ? fmt(S.lat, 6, false) + "<br>" + fmt(S.lon, 6, false) : "–") + '</td><td class="n">' + (S.altRel != null ? fmt(S.altRel, 1) : "–") + " / " + (S.altAbs != null ? fmt(S.altAbs, 1) : S.altGPS != null ? fmt(S.altGPS, 1) : "–") + "</td><td>" + (k ? '<span class="chip s-' + ({ ok: "file", warn: "missing", bad: "bad", info: "derived", na: "na" })[(RTK_ST[k] || RTK_ST.other)[0]] + '"><i>' + (RTK_ST[k] || RTK_ST.other)[1] + "</i>" + esc(t("rtk_" + k)) + "</span>" : "–") + '</td><td class="n">' + fmtExp(S.exposureTime) + "<br>ISO " + (S.iso || "–") + '</td><td class="n">' + (S.gimbal && S.gimbal.pitch != null ? fmt(S.gimbal.pitch, 1) + "°" : "–") + "</td>" + (showSer ? '<td class="n">' + esc(S.serial || "–") + "</td>" : "") + "</tr>"; }).join("");
  P.innerHTML = '<p class="note small">' + esc(t("batchIntro", F.length)) + "</p>" +
    '<div class="plots"><div><h3 class="sub">' + esc(t("trkH")) + '</h3><div class="plot"><canvas id="trkCv" role="img" aria-label="' + esc(t("trkAria")) + '"></canvas></div></div><div><h3 class="sub">' + esc(t("altH")) + '</h3><div class="plot"><canvas id="altCv" role="img" aria-label="' + esc(t("altAria")) + '"></canvas></div></div></div>' +
    '<div class="legend">' + ["fixed", "int", "float", "single", "none"].map(k => '<span><span aria-hidden="true" style="color:var(--' + RTK_ST[k][0] + ')">' + RTK_ST[k][1] + "</span> " + esc(t("rtk_" + k)) + "</span>").join("") + '<span><span class="sw" style="background:var(--accent-soft);border:1px solid var(--accent)"></span>' + esc(t("fpLegend")) + "</span></div>" +
    '<h3 class="sub">' + esc(t("chkH")) + '</h3><ul class="checks">' + ch.map(c => "<li>" + (c.ok ? chip("s-file", "✓", t("ok")) : chip("s-missing", "!", t("check"))) + "<span>" + esc(t(c.key)) + (c.det ? "<small>" + esc(dec(c.det)) + "</small>" : "") + "</span></li>").join("") + "</ul>" +
    '<div class="tw"><table class="bt"><thead><tr><th>#</th><th>' + esc(t("thFile")) + "</th><th>" + esc(t("thTime")) + "</th><th>" + esc(t("thLatLon")) + "</th><th>" + esc(t("thAlt")) + "</th><th>RTK</th><th>" + esc(t("thExp")) + "</th><th>" + esc(t("thGimbal")) + "</th>" + (showSer ? "<th>" + esc(t("thSerial")) + "</th>" : "") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" + (oneDay && days.size ? '<p class="note small">' + esc(t("thDate")) + ": " + esc([...days][0]) + "</p>" : "") +
    '<p class="note small">' + esc(t("batchStar")) + '</p><div class="toolbar"><button class="btn" id="x-il">' + esc(t("expIl")) + '</button><button class="btn" id="x-mj">' + esc(t("expMj")) + '</button><button class="btn" id="x-jall">' + esc(t("expJsonAll")) + '</button></div><p class="note small">' + t("xNote") + "</p>";
  drawTrack(); drawAlt();
}

/* ---------------------------------------------------------------- exports */
function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime || "text/plain;charset=utf-8" })), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function ilRow(f) {
  const row = {}; for (const x of M.imageLog(f.res)) row[x.column] = x.value;
  const im = flightState().O.images[f.name];
  if (im) { for (const [c, x] of Object.entries(im.cols)) if (c[0] !== "_") row[c] = String(x.val); row.aux = [row.aux, "timestamp, position, RTK and sigma from " + im.log + " #" + im.n + (im.cols.lat_deg && im.cols.lat_deg.note === "nInterp" ? " (position interpolated from the trajectory, an estimate)" : "")].filter(Boolean).join("; "); row._log = im.log; }
  return row;
}
function imageLogCSV(F) { const cols = M.IMAGE_LOG_COLUMNS, lines = [cols.join(",")]; for (const f of F) { const row = ilRow(f); lines.push(cols.map(c => M.csvCell(row[c] == null ? "" : row[c])).join(",")); } return lines.join("\r\n") + "\r\n"; }
// camera positions for photogrammetry: a CSV whose columns are mapped on import (Metashape, Pix4D), and geo.txt for OpenDroneMap (EPSG:4326, x = longitude)
function cameraRows(F) { return F.map(f => ({ f, r: ilRow(f) })).filter(x => x.r.lat_deg !== "" && x.r.lat_deg != null); }
const ang = r => OSLFlight.sfmAngles(num(r.gimbal_yaw_deg), num(r.gimbal_pitch_deg), num(r.gimbal_roll_deg));
const has = v => v !== "" && v != null;
// Metashape: Import Reference with these columns (rotation as yaw, pitch, roll; accuracy per axis); one header row
function camerasCSV(F) {
  const lines = ["label,latitude,longitude,height_ellipsoid_m,yaw,pitch,roll,accuracy_x_m,accuracy_y_m,accuracy_z_m,source"];
  for (const { f, r } of cameraRows(F)) { const a = ang(r);
    lines.push([f.name, r.lat_deg, r.lon_deg, r.alt_ellipsoid_m, a ? a.yaw : "", a ? a.pitch : "", a ? a.roll : "", r.sigma_x_m, r.sigma_y_m, r.sigma_z_m, r._log || "image EXIF/XMP"].map(v => M.csvCell(v == null ? "" : v)).join(",")); }
  return lines.join("\r\n") + "\r\n";
}
// PIX4Dmatic image geolocation: no header (a # comment is allowed), EPSG:4326 axis order latitude, longitude; 9, 6 or 4 columns, the same for every row
function pix4dCSV(F) {
  const rows = cameraRows(F).filter(x => has(x.r.alt_ellipsoid_m)).map(x => ({ f: x.f, r: x.r, a: ang(x.r) }));
  const withA = rows.length && rows.every(x => x.a), withS = rows.length && rows.every(x => has(x.r.sigma_x_m) && has(x.r.sigma_y_m) && has(x.r.sigma_z_m));
  const lines = ["# imagename,latitude,longitude,ellipsoidal height (m)" + (withA ? ",yaw,pitch,roll (deg; pitch 0 = nadir)" : "") + (withS ? ",accuracy horz (m),accuracy vert (m)" : "") + "; EPSG:4326; OpenSkyLab metadata reader"];
  for (const { f, r, a } of rows) lines.push([f.name, r.lat_deg, r.lon_deg, r.alt_ellipsoid_m].concat(withA ? [a.yaw, a.pitch, a.roll] : []).concat(withS ? [Math.max(+r.sigma_x_m, +r.sigma_y_m), +r.sigma_z_m] : []).join(","));
  return { text: lines.join("\r\n") + "\r\n", n: rows.length, skipped: cameraRows(F).length - rows.length };
}
// GeoJSON for QGIS: exposures of the main log (or the images without a log) as points, footprints of nadir images as polygons
function geojson(F) {
  const FS = flightState(), feats = [], byImg = {}; for (const m of (FS.F && FS.F.matches) || []) if (m.log) byImg[m.log + "#" + m.n] = m.image;
  const r6 = v => v == null || v === "" ? null : +(+v).toFixed(9), pt = (lon, lat, props) => feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [r6(lon), r6(lat)] }, properties: props });
  const main = FS.F && FS.F.exposures.length ? FS.logs.find(l => l.exposures === FS.F.exposures) : null;
  if (main) for (const e of main.exposures) { if (e.lat == null || !isFinite(e.lat)) continue; pt(e.lon, e.lat, { kind: "exposure", source: main.name, n: e.n, image: byImg[main.name + "#" + e.n] || e.name || null, time_utc: e.t != null ? new Date(e.t).toISOString() : null, height_m: e.h != null ? +(+e.h).toFixed(3) : null, solution: e.q || null, sigma_h_m: e.sH != null ? e.sH : e.sN != null ? Math.max(e.sN, e.sE) : null, sigma_v_m: e.sV != null ? e.sV : null }); }
  for (const { f, r } of cameraRows(F)) { const S = f.res.summary, a = ang(r);
    if (!main) pt(r.lon_deg, r.lat_deg, { kind: "image", image: f.name, time_utc: r.timestamp_utc || null, height_ellipsoid_m: r6(r.alt_ellipsoid_m), height_rel_m: r6(r.alt_rel_m), solution: r.rtk_flag || null, sigma_x_m: r6(r.sigma_x_m), sigma_y_m: r6(r.sigma_y_m), sigma_z_m: r6(r.sigma_z_m), yaw: a ? a.yaw : null, pitch: a ? a.pitch : null, roll: a ? a.roll : null, source: r._log || "image EXIF/XMP" });
    if (S.footprint && a && Math.abs(a.pitch) <= 5) { const lat = +r.lat_deg, lon = +r.lon_deg, k = 111320 * Math.cos(lat * Math.PI / 180), poly = footprintPoly(S, 0, 0);
      if (poly) { const ring = poly.map(q => [r6(lon + q[0] / k), r6(lat + q[1] / 111320)]); ring.push(ring[0]); feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { kind: "footprint", image: f.name, gsd_cm: S.gsd ? +(S.gsd * 100).toFixed(2) : null, note: "nadir, flat ground at take-off elevation" } }); } } }
  return JSON.stringify({ type: "FeatureCollection", name: "openskylab_exposures", features: feats }) + "\n";
}
function odmGeo(F) {
  const lines = ["EPSG:4326"];
  for (const { f, r } of cameraRows(F)) { const z = r.alt_ellipsoid_m, sx = r.sigma_x_m, sy = r.sigma_y_m, sz = r.sigma_z_m, acc = z !== "" && sx !== "" && sy !== "" && sz !== "" && [sx, sy, sz].every(v => v != null);
    lines.push([f.name, r.lon_deg, r.lat_deg].concat(z !== "" && z != null ? [z] : []).concat(acc ? [0, 0, 0, Math.max(+sx, +sy), sz] : []).join(" ")); }
  return lines.join("\n") + "\n";
}
// metadata.json and, beside it, where each value came from (provenance.json); one pass so the two always agree
const READER = { name: "OpenSkyLab metadata reader", version: "1.4.0", url: "https://openskylab.space/reader" };
function metaBuild(F) {
  // slots to fill in: "" for free text, [] for lists; numbers, enumerations and objects are left out until known, so that the draft never carries a value of the wrong type
  const empty = blk => { const o = {}; for (const r of OSL_STD.rows) if (r[0] === blk) { if (/^array/.test(r[7])) o[r[1]] = []; else if (r[7] === "string" && !/ \| /.test(r[6])) o[r[1]] = ""; } return o; };
  const ds = empty("dataset"), mi = empty("mission"), out = { schema_version: OSL_STD.version, provenance: "provenance.json", dataset: ds, missions: [mi], sensors: [], references: [], processing: [], products: [empty("product")] };
  const groups = new Map(); for (const f of F) { const S = f.res.summary, k = [S.make, S.model, S.serial, S.band ? S.band.name : ""].join("|"); if (!groups.has(k)) groups.set(k, f); }
  const fields = [];
  const fill = (o, rows, blk, path, f) => { for (const r of rows) if (r.block === blk && (r.st === "file" || r.st === "derived" || r.st === "log") && r.val !== "" && r.val != null) { o[r.field] = schemaVal(r.field, r.val); fields.push({ path: path + "." + r.field, r, f }); } };
  const L0 = L; L = "en"; // provenance is written in English whatever the page language
  try {
    let first = true, i = 0;
    for (const f of groups.values()) {
      const rows = oslEval(f), p = "sensors[" + i + "]";
      if (first) { fill(ds, rows, "dataset", "dataset", f); fill(mi, rows, "mission", "missions[0]", f); first = false;
        const ws = rows.find(r => r.block === "environment" && r.field === "weather_source" && r.note === "nWx"); // weather archive (Open-Meteo), only after the user asked for it
        if (ws) { mi.environment = Object.assign({}, mi.environment, { weather_source: ws.val, sampling_interval: 3600 }); fields.push({ path: "missions[0].environment.weather_source", r: ws, f }, { path: "missions[0].environment.sampling_interval", r: { st: "derived", val: 3600, src: ws.src, note: "nWx" }, f }); } }
      const s = empty("sensor"); fill(s, rows, "sensor", p, f); const g = empty("geometry"); fill(g, rows, "geometry", p + ".geometry", f); s.geometry = g;
      if (f.res.summary.sensorType === "multispectral") { const m = empty("multispectral"); fill(m, rows, "multispectral", p + ".multispectral", f); s.multispectral = m; }
      if (f.res.summary.sensorType === "thermal_LWIR") { const m = empty("thermal"); fill(m, rows, "thermal", p + ".thermal", f); s.thermal = m; }
      out.sensors.push(s); i++;
    }
  } finally { L = L0; }
  // processing and products from a loaded processing project (Pix4D .p4d, Metashape doc.xml / chunk.zip)
  const PR = OSLFlight.procRecord((st.logs || []).filter(l => l.L).map(l => l.L));
  if (PR.length) {
    const SRCS = { p4d: { software: "software/projectVersion", steps: "options: steps switched on and their settings", photogrammetry_settings: "options/initial, cameras/rig", adjustment_quality: "inputs: images (enabled, accuracyXY/Z), gcps; options/ortho/meanResolution", output_crs: "inputs/coordinateSystems/output" },
      thermotiff: { software: "software (processing_record.json) or dji_api_version (conversion_log.csv)", steps: "the conversion run: parameters, image counts", thermal_settings: "parameters of the conversion (distance, humidity, emissivity, reflection, ambient) and their source", atmospheric_model: "DJI Thermal SDK, the converter ThermoTIFF uses", photogrammetry_settings: "not applicable", adjustment_quality: "not applicable" },
      metashape: { software: "meta Info/LastSavedSoftwareVersion", steps: "meta <Step>/… of the chunk", photogrammetry_settings: "settings accuracy_*, meta AlignCameras, OptimizeCameras", adjustment_quality: "cameras (transform), markers (reference enabled, frame projections), meta OptimizeCameras/sigma0", output_crs: "chunk reference" } };
    out.processing = PR.map((r, i) => { for (const k of Object.keys(r.processing)) fields.push({ path: "processing[" + i + "]." + k, pr: { log: r.log, source: r.log + ": " + (k === "workflow_id" ? "assigned by the reader, one per project" : (SRCS[r.source] || {})[k] || k) } }); return r.processing; });
    const prods = PR.flatMap(r => r.products.map(p => ({ p, log: r.log })));
    if (prods.length) out.products = prods.map(({ p, log }, i) => { for (const k of Object.keys(p)) fields.push({ path: "products[" + i + "]." + k, pr: { log, source: log + ": " + (k === "product_type" ? "product present or set to be exported" : k === "crs" ? "reference system of the project" : k === "format" ? "export settings" : k === "vertical_crs" ? "height definition of the project" : "workflow of this project") } }); return Object.assign(empty("product"), p); });
  }
  // v0.3: declared level and modules (geometry is added by the user when the images are processed into a map or model)
  ds.profile = { C: "core", Q: "quantitative", F: "full" }[st.profile] || "core";
  ds.modules = [...new Set([...groups.values()].map(f => f.res.summary.sensorType).map(x => x === "multispectral" ? "multispectral" : x === "thermal_LWIR" ? "thermal" : null).filter(Boolean))];
  return { out, fields, groups: groups.size, PR };
}
// the check table shows oblique_images as false or [true, tilt from nadir]; the schema wants { included, gimbal_pitch_deg }
function schemaVal(field, v) {
  if (field === "oblique_images") return Array.isArray(v) ? { included: true, gimbal_pitch_deg: +(v[1] - 90).toFixed(1) } : { included: false, gimbal_pitch_deg: null };
  return v;
}
function metadataJSON(F) { return JSON.stringify(metaBuild(F).out, null, 2) + "\n"; }
const hex = buf => Array.from(new Uint8Array(buf)).map(x => x.toString(16).padStart(2, "0")).join("");
const HASH_MAX = 512 * 1048576; // larger files are listed without a hash (the browser digests a file in one piece)
async function sha256Of(src) {
  if (!(globalThis.crypto && crypto.subtle) || !src) return "";
  const n = src.byteLength != null ? src.byteLength : src.size; if (!(n <= HASH_MAX)) return "";
  try { return hex(await crypto.subtle.digest("SHA-256", src.byteLength != null ? src : await src.arrayBuffer())); } catch (x) { return ""; }
}
const sha256Text = s => sha256Of(new TextEncoder().encode(s));
// provenance.json (OpenSkyLab provenance, draft for specification 0.4): inputs with SHA-256, the software that read them, and the origin of every value in metadata.json
const isProj = l => !!(l.L && (l.L.proc || /^(pix4d-project|metashape)$/.test(l.L.kind)));
async function provenanceJSON(F) {
  const logsE = (st.logs || []).filter(l => l.L);
  for (const f of F) if (!f.sha) f.sha = await sha256Of(f.bytes || f.blob);
  for (const l of logsE) if (l.sha == null) l.sha = await sha256Of(l.src);
  const B = metaBuild(F), FS = flightState(), en = n => n ? (T.en.on[n] || "") : "";
  const imgId = new Map(F.map((f, i) => [f, "image:" + (i + 1)])), logId = new Map(logsE.map((l, i) => [l.name, "log:" + (i + 1)]));
  const inputs = F.map(f => ({ id: imgId.get(f), role: "image", file: f.name, bytes: f.size, sha256: f.sha || null, read_utc: f.readAt || null }))
    .concat(logsE.map(l => ({ id: logId.get(l.name), role: isProj(l) ? "processing_project" : /^(rinex|rtcm3|ubx|sbf|novatel)$/.test(l.L.kind) ? "gnss_log" : "flight_log", kind: l.L.kind, file: l.name, bytes: l.size, sha256: l.sha || null, device: l.L.device || undefined, read_utc: l.readAt || null })));
  // processing projects are listed as inputs but are not flight logs: they do not count in the "logs" collection
  const logsF = logsE.filter(l => !isProj(l));
  const allImg = F.length > 1 ? "images" : imgId.get(F[0]), allLog = logsF.length > 1 ? "logs" : logsF.length ? logId.get(logsF[0].name) : null;
  const ORIGIN = { file: "image", derived: "derived", log: "flight_log" };
  // mission and dataset values are statistics over all loaded images (or come from the logs); sensor values from the first image of each sensor
  const fields = B.fields.map(({ path, r, f, pr }) => {
    if (pr) return { path, origin: "processing_log", source: pr.source, from: [logId.get(pr.log)].filter(Boolean) };
    if (r.note === "nWx") return { path, origin: "external_service", source: r.src || "", from: [], note: en(r.note), estimate: true };
    if (r.note && /^nProc/.test(r.note) && r.log) return Object.assign({ path, origin: "processing_log", source: r.src || "", from: [logId.get(r.log)].filter(Boolean) }, en(r.note) ? { note: en(r.note) } : {});
    const from = r.st === "log" ? [allLog] : r.note === "nGeo" ? [FS.G && FS.G.source === "log" ? allLog : allImg] : [/^(dataset|missions)/.test(path) ? allImg : imgId.get(f)];
    const o = { path, origin: ORIGIN[r.st], source: r.src || "", from: from.filter(Boolean) };
    if (en(r.note)) o.note = en(r.note); if (isEst(r)) o.estimate = true;
    if (r.st === "log" && r.img != null) { o.check = { image_value: r.img, image_source: r.imgSrc || "", agreement: r.cmp || "not_compared" };
      if (r.cmp === "not_comparable") { o.check.difference = r.cmpDiff != null && isFinite(r.cmpDiff) ? +r.cmpDiff.toFixed(3) : null; o.check.why = "height reference of the image value not documented"; } }
    return o;
  });
  // image_log.csv: per column, how many rows come from the image, from the log or are empty
  const cols = {};
  for (const f of F) {
    const im = FS.O.images[f.name];
    for (const x of M.imageLog(f.res)) {
      if (x.column === "aux") continue;
      const c = cols[x.column] || (cols[x.column] = { image: 0, derived: 0, flight_log: 0, flight_log_interpolated: 0, empty: 0, sources: new Set() });
      if (im && im.cols[x.column]) { c.flight_log++; if (im.cols[x.column].note === "nInterp") c.flight_log_interpolated++; c.sources.add(im.log); }
      else if (x.status === "file") { c.image++; if (x.source) c.sources.add(x.source); }
      else if (x.status === "derived") { c.derived++; if (x.source) c.sources.add(x.source); }
      else c.empty++;
    }
  }
  const ilCols = Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, Object.assign(Object.fromEntries(["image", "derived", "flight_log", "flight_log_interpolated", "empty"].filter(n => c[n]).map(n => [n, c[n]])), c.sources.size ? { sources: [...c.sources] } : {})]));
  const mj = metadataJSON(F), il = imageLogCSV(F), now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const reads = inputs.map(x => x.read_utc).filter(Boolean).sort();
  const collections = [];
  if (allImg === "images") collections.push({ id: "images", role: "images", members: F.length });
  if (allLog === "logs") collections.push({ id: "logs", role: "logs", members: logsF.length });
  // processing: one software agent per program and version, one activity per step recorded in the project
  const agents = [{ id: "software:reader", type: "software", name: READER.name, version: READER.version, url: READER.url, components: { parser: M.version, flight_logs: OSLFlight.VERSION, specification: OSL_STD.version } }], acts = [];
  let prodIx = 0;
  for (const r of B.PR || []) {
    const swAgents = r.software.map(sw => { const id = "software:" + sw.name.toLowerCase().replace(/^agisoft /, "").replace(/[^a-z0-9]+/g, "-") + (sw.version ? "-" + sw.version.replace(/[^0-9a-z.]+/gi, "-") : "");
      if (!agents.some(a => a.id === id)) agents.push({ id, type: "software", name: sw.name, version: sw.version || "unknown" }); return id; });
    const base = prodIx; prodIx += r.products.length;
    // the loaded images the project lists (by file name); the step used them, not necessarily only them
    // ThermoTIFF: the loaded TIFFs are the outputs of the conversion, the R-JPEGs its inputs (same file name, other extension)
    const outImg = f => r.source === "thermotiff" && /\.tiff?$/i.test(f.name);
    const inProj = new Set(r.images), mineAll = F.filter(f => inProj.has(f.name.replace(/\.[^.]*$/, "").toLowerCase())), mine = mineAll.filter(f => !outImg(f)), made = mineAll.filter(outImg).map(f => imgId.get(f));
    const used = mine.length && mine.length === F.length && allImg === "images" ? ["images"] : mine.map(f => imgId.get(f));
    for (const s of r.steps) {
      const gen = r.made.map((o, k) => o === s.order ? "metadata.json#products[" + (base + k) + "]" : null).filter(Boolean);
      const a = { id: "activity:" + r.wf.toLowerCase() + "-" + s.order, type: "processing", order: s.order, name: s.name, agent: swAgents.length === 1 ? swAgents[0] : swAgents, workflow_id: r.wf,
        used, generated: s.order === 1 ? gen.concat(made) : gen, recorded_in: r.logs.length > 1 ? r.logs.map(n => logId.get(n)) : logId.get(r.log),
        parameters: Object.assign({}, s.parameters, s.duration_s != null ? { duration_s: s.duration_s } : {}, s.memory_bytes != null ? { memory_bytes: s.memory_bytes } : {}, s.software_version ? { software_version: s.software_version } : {}) };
      acts.push(a);
    }
  }
  const P = {
    provenance_version: "0.4-draft",
    generated_utc: now,
    describes: [{ file: "metadata.json", sha256: await sha256Text(mj), schema_version: OSL_STD.version }, { file: "image_log.csv", sha256: await sha256Text(il), rows: F.length }],
    agents,
    activities: [{ id: "activity:read", type: "metadata_extraction", agent: "software:reader", started_utc: reads[0] || now, ended_utc: now, used: inputs.map(x => x.id), generated: ["metadata.json", "image_log.csv"],
      parameters: Object.assign({ profile: ({ C: "core", Q: "quantitative", F: "full" })[st.profile] || "core", sensor_groups: B.groups, matched_images: Object.keys(FS.O.images || {}).length }, logsF.length ? { log_matching: "file name, DJI MRK index, MicaSense CaptureId or time" } : {}) }].concat(acts),
    inputs: inputs.map(x => JSON.parse(JSON.stringify(x))),
    collections,
    fields,
    image_log_columns: ilCols,
    not_recorded: (B.PR || []).length ? "Values typed or edited by hand after this export are not covered. The processing activities come from the project file as saved: it does not say when each step ran, and for Metashape the version that ran a step only when the step recorded it; the quality report holds times, step versions and accuracy figures (add them by hand). A step lists as used the loaded images whose file names the project contains."
      : "Values typed or edited by hand after this export, and every processing step, are not covered: add them as further activities (see the OpenSkyLab provenance draft)."
  };
  if (!collections.length) delete P.collections;
  // image ↔ log matching, one record per image: how it was matched, how many records fitted, which were rejected and why
  const MT = (FS.F && FS.F.matches) || [];
  if (MT.length && logsF.length) P.matching = F.map(f => { const m = MT.find(x => x.image === f.name); if (!m) return null;
    const r = { image: imgId.get(f), status: m.status || (m.log ? "unique" : "unmatched"), method: m.how || null, log: m.log ? logId.get(m.log) || m.log : null, record: m.log ? m.n : null,
      time_offset_s: m.dt != null ? +m.dt.toFixed(3) : null, distance_m: m.dxy != null ? +m.dxy.toFixed(3) : null, candidates: m.candidates != null ? m.candidates : null };
    if (m.reason) r.reason = m.reason; if (m.alternatives && m.alternatives.length) r.alternatives = m.alternatives.map(a => ({ log: logId.get(a.log) || a.log, record: a.n, time_offset_s: a.dt }));
    if (m.rejected && m.rejected.length) r.rejected = m.rejected.map(a => ({ log: logId.get(a.log) || a.log, record: a.n, why: a.why }));
    return r; }).filter(Boolean);
  return JSON.stringify(P, null, 2) + "\n";
}

/* ---------------------------------------------------------------- events */
function bind() {
  if ($("#lang-cs")) { $("#lang-cs").onclick = () => setLang("cs"); $("#lang-en").onclick = () => setLang("en"); }
  ["ov", "tags", "osl", "batch", "flt"].forEach(k => { $("#t-" + k).onclick = () => setTab(k); });
  const fin = $("#fin"); $("#pick").onclick = () => fin.click(); fin.onchange = () => { readUserFiles(fin.files); fin.value = ""; };
  const fdir = $("#findir"); if (fdir && $("#pickDir")) { $("#pickDir").onclick = () => fdir.click(); fdir.onchange = () => { readUserFiles(fdir.files, true); fdir.value = ""; }; }
  const fin2 = $("#fin2"); if (fin2) { $("#pick2").onclick = () => fin2.click(); fin2.onchange = () => { readUserFiles(fin2.files); fin2.value = ""; }; }
  const dz = document.querySelector(".panel"), drop = $("#drop");
  // either box takes any file: images and logs are told apart by their content
  const zones = [drop, $("#drop2")].filter(Boolean), hl = x => { const z = x.target.closest && x.target.closest(".drop"); zones.forEach(d => d.classList.toggle("over", z ? d === z : d === drop)); };
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, x => { x.preventDefault(); hl(x); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, x => { x.preventDefault(); if (ev === "drop" || !dz.contains(x.relatedTarget)) zones.forEach(d => d.classList.remove("over")); }));
  dz.addEventListener("drop", async x => { const dt = x.dataTransfer; if (!dt) return; const dir = await filesFromDrop(dt); if (dir) readUserFiles(dir, true); else if (dt.files && dt.files.length) readUserFiles(dt.files); });
  document.addEventListener("click", x => {
    const b = x.target.closest("button, summary"); if (!b) return;
    if (flightClick(b)) return;
    if (b.id === "pick2b") { const f2 = $("#fin2") || $("#fin"); f2.click(); return; }
    if (b.dataset.smp) { loadSample(b.dataset.smp); return; }
    if (b.dataset.f != null) { st.cur = +b.dataset.f; renderAll(); return; }
    if (b.dataset.rm != null) { const i = +b.dataset.rm, f = st.files[i]; dropEntry(f); st.files.splice(i, 1); if (st.cur >= st.files.length) st.cur = st.files.length - 1; else if (st.cur > i) st.cur--; renderAll(); return; }
    if (b.id === "privBtn") { st.priv = !st.priv; renderPriv(); return; }
    if (b.dataset.h) { st.H = +b.dataset.h; updGsd(); return; }
    if (b.id === "m-f" || b.id === "m-r") { st.raw = b.id === "m-r"; renderTags(); return; }
    if (b.id === "g-open" || b.id === "g-close") { const e = cur(); if (e) e.res.groups.forEach(g => st.open[g.id] = b.id === "g-open"); renderGroups(); return; }
    if (b.dataset.prof) { st.profile = b.dataset.prof; renderOSL(); renderSteps(); return; }
    if (b.dataset.of) { st.oslF = b.dataset.of; renderOSL(); return; }
    if (b.id === "wx-ask") { const p = wxParams(); st.wxAsk = p && p.key; renderOSL(); return; }
    if (b.id === "wx-no") { st.wxAsk = null; renderOSL(); return; }
    if (b.id === "wx-go") { st.wxAsk = null; wxFetch(); return; }
    if (b.id === "x-env") { download("environment.csv", envCSV(), "text/csv;charset=utf-8"); return; }
    const e = cur(); if (!e) return; const stem = e.name.replace(/\.[^.]+$/, "");
    if (b.id === "x-json") download(stem + "_metadata.json", M.toExiftoolJSON([e.res]), "application/json");
    else if (b.id === "x-csv") download(stem + "_metadata.csv", "\ufeff" + M.toCSV(e.res), "text/csv;charset=utf-8");
    else if (b.id === "x-il1") download(stem + "_image_log.csv", imageLogCSV([e]), "text/csv;charset=utf-8");
    else if (b.id === "x-il") download("image_log.csv", imageLogCSV(batchFiles()), "text/csv;charset=utf-8");
    else if (b.id === "x-cam") download("camera_positions.csv", camerasCSV(batchFiles()), "text/csv;charset=utf-8");
    else if (b.id === "x-odm") download("geo.txt", odmGeo(batchFiles()), "text/plain;charset=utf-8");
    else if (b.id === "x-p4d") download("pix4d_geolocation.csv", pix4dCSV(batchFiles()).text, "text/csv;charset=utf-8");
    else if (b.id === "x-gj") download("exposures.geojson", geojson(batchFiles()), "application/geo+json");
    else if (b.id === "x-rep") download("flight_report.html", reportHTML(), "text/html;charset=utf-8");
    else if (b.id === "x-mj") download("metadata.json", metadataJSON(batchFiles()), "application/json");
    else if (b.id === "x-pv") { b.disabled = true; provenanceJSON(batchFiles()).then(s => download("provenance.json", s, "application/json")).finally(() => { b.disabled = false; }); }
    else if (b.id === "x-jall") download("exiftool_style.json", M.toExiftoolJSON(batchFiles().map(f => f.res)), "application/json");
  });
  document.addEventListener("toggle", x => {
    const d = x.target; if (!(d instanceof HTMLDetailsElement)) return;
    if (d.dataset.g) { const was = st.open[d.dataset.g]; st.open[d.dataset.g] = d.open; if (d.open && !d.querySelector("table") && was !== true) renderGroups(); }
    if (d.dataset.o) st.open[d.dataset.o] = d.open;
  }, true);
  document.addEventListener("input", x => {
    if (x.target.id === "hsl") { st.H = +x.target.value; updGsd(); }
    if (x.target.id === "q") { st.q = x.target.value; renderGroups(); }
  });
  let rz = 0; const ro = new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (st.tab === "ov") drawLocatorWithH(); if (st.tab === "batch") { drawTrack(); drawAlt(); } if (st.tab === "flt") drawFlight(); }); });
  ro.observe($(".main"));
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; if (mq && mq.addEventListener) mq.addEventListener("change", () => renderTab());
}
function setLang(l) { L = l; try { localStorage.setItem("osl-lang", l); } catch (e) { /* storage blocked */ } applyStatic(); if ($("#q")) $("#p-tags").innerHTML = ""; renderAll(); }
applyStatic(); bind(); renderAll();
if (SAMPLES.s1) loadSample("s1");
