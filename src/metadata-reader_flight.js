/*OSL-FLIGHT-START*/
/* OpenSkyLab flight reader: drone flight logs, GNSS logs and geotag files read in the browser.
   Reads (each as far as the format is documented or was verified on field data):
   DJI Timestamp.MRK, RINEX 2/3 observation and navigation files, RTCM 3 (DJI PPKRAW.bin), PX4 ULog (also the Wingtra variant),
   Wingtra geotaglog / flight json / ini / geotags.csv, Septentrio SBF, senseFly eBee X .bb3 (the GNSS stream inside it),
   senseFly geoinfo.txt, eMotion KML, Trimble JobXML (.jxl), MicaSense paramlog.dat and gpslog.dat, Parrot Sequoia TLMB,
   Wingtra LiDAR service.log, ppk.pcmp and .data recordings, Wingtra payload computer (OBC) logs, NovAtel OEM binary; generic: ArduPilot DataFlash .bin and text .log, MAVLink .tlog, NMEA 0183, GPX, CSV geotags.
   Processing projects: Pix4Dmapper .p4d and Agisoft Metashape (doc.xml, chunk.zip, .psz; .psx is only a pointer) give the processing record.
   Encrypted logs are recognised and reported, not decoded.
   Nothing leaves the browser. Large files are read in blocks. */
const OSLFlight = (() => {
"use strict";
const VERSION = "0.3.0";

/* ---------------------------------------------------------------- bytes and blocks */
const isBlob = s => typeof Blob !== "undefined" && s instanceof Blob;
const sizeOf = s => isBlob(s) ? s.size : s.length;
async function slice(src, a, b) { if (!isBlob(src)) return src.subarray(a, Math.min(b, src.length)); return new Uint8Array(await src.slice(a, b).arrayBuffer()); }
async function* blocks(src, step) { step = step || 1 << 23; const n = sizeOf(src); for (let a = 0; a < n; a += step) yield await slice(src, a, a + step); }
function cat(a, b) { if (!a.length) return b; if (!b.length) return a; const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
/* fn(buf, final) parses whole records and returns the number of bytes consumed; the rest is carried over to the next block */
async function scan(src, fn, o) {
  let carry = new Uint8Array(0), done = 0; const n = sizeOf(src);
  for await (const c of blocks(src)) { const b = cat(carry, c); const k = fn(b, false); carry = b.subarray(k); done += c.length; if (o && o.progress) o.progress(done / n); }
  if (carry.length) fn(carry, true);
}
async function eachLine(src, fn, o) {
  const td = new TextDecoder("utf-8"); let rest = "", stop = false, done = 0; const n = sizeOf(src);
  for await (const c of blocks(src)) {
    const s = rest + td.decode(c, { stream: true }); const L = s.split(/\r?\n/); rest = L.pop();
    for (const l of L) if (fn(l) === false) { stop = true; break; }
    done += c.length; if (o && o.progress) o.progress(done / n);
    if (stop) return;
  }
  rest += td.decode(); if (rest) fn(rest);
}
async function text(src, max) { const b = await slice(src, 0, max || sizeOf(src)); return new TextDecoder("utf-8").decode(b); }
const dvOf = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const asc = (b, a, n) => { let s = ""; for (let i = a; i < a + n && i < b.length; i++) { if (!b[i]) break; s += String.fromCharCode(b[i]); } return s.trim(); };
const startsWith = (b, s) => { for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false; return true; };
function find(b, s, from) { const c0 = s.charCodeAt(0); outer: for (let i = from || 0; i <= b.length - s.length; i++) { if (b[i] !== c0) continue; for (let k = 1; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer; return i; } return -1; }
function entropy(b) { if (!b.length) return 0; const h = new Uint32Array(256); for (const x of b) h[x]++; let e = 0; for (const v of h) if (v) { const p = v / b.length; e -= p * Math.log2(p); } return e; }

/* ---------------------------------------------------------------- checksums */
const CRC16 = (() => { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; t[i] = c; } return t; })();
function crc16(b, a, e) { let c = 0; for (let i = a; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[((c >> 8) ^ b[i]) & 0xff]; return c; }
const CRC24 = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i << 16; for (let k = 0; k < 8; k++) { c <<= 1; if (c & 0x1000000) c ^= 0x1864cfb; } t[i] = c & 0xffffff; } return t; })();
function crc24(b, a, e) { let c = 0; for (let i = a; i < e; i++) c = ((c << 8) & 0xffffff) ^ CRC24[((c >> 16) ^ b[i]) & 0xff]; return c; }

/* ---------------------------------------------------------------- time */
const GPS0 = Date.UTC(1980, 0, 6), WEEK = 604800000;
const LEAPS = [[Date.UTC(2017, 0, 1), 18], [Date.UTC(2015, 6, 1), 17], [Date.UTC(2012, 6, 1), 16], [Date.UTC(2009, 0, 1), 15], [Date.UTC(2006, 0, 1), 14], [Date.UTC(1999, 0, 1), 13]];
const leapAt = gpsMs => { for (const [t, l] of LEAPS) if (gpsMs - l * 1000 >= t) return l; return 13; };
const gpsMsToUtc = g => g - leapAt(g) * 1000;
const gpsToUtc = (week, towMs) => gpsMsToUtc(GPS0 + week * WEEK + towMs);
const iso = ms => ms == null || !isFinite(ms) ? null : new Date(ms).toISOString();
const isoS = ms => ms == null || !isFinite(ms) ? "–" : new Date(ms).toISOString().replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
const median = a => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const countBy = (a, f) => { const o = {}; for (const x of a) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };
const R2D = 180 / Math.PI;

/* ---------------------------------------------------------------- result object */
function newLog(kind, name, size) {
  return { kind, name, size, device: {}, startMs: null, endMs: null, timeSource: null, trajectory: [], exposures: [], facts: [], notes: [], raw: null, base: null, panels: null, encrypted: false };
}
const fact = (L, k, v, extra) => { if (v != null && v !== "" && !(typeof v === "number" && !isFinite(v))) L.facts.push(extra ? [k, v, extra] : [k, v]); };
function span(L, ms) { if (ms == null || !isFinite(ms)) return; if (L.startMs == null || ms < L.startMs) L.startMs = ms; if (L.endMs == null || ms > L.endMs) L.endMs = ms; }
/* keeps at most ~n points of a long trajectory (every k-th point) */
function thin(pts, n) { n = n || 3000; if (pts.length <= n) return pts; const k = Math.ceil(pts.length / n), out = []; for (let i = 0; i < pts.length; i += k) out.push(pts[i]); if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]); return out; }

/* ---------------------------------------------------------------- recognition */
const ULOG_MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];
function sniff(name, h) {
  const n = String(name || ""), low = n.toLowerCase(), s = new TextDecoder("latin1").decode(h.subarray(0, 4096));
  if (ULOG_MAGIC.every((x, i) => h[i] === x)) return "ulog";
  if (startsWith(h, "TLMB")) return "tlmb";
  if (startsWith(h, "MICA")) return "mica-gpslog";
  if (/^\s*\{\s*"Parameters"/.test(s) || (/paramlog/i.test(low) && h[0] === 0x7b)) return "mica-paramlog";
  if (h[0] === 0xa3 && h[1] === 0x95 && h[2] === 0x80) return "ardupilot-bin";
  if (/^FMT, ?128, ?89, ?FMT,/.test(s)) return "ardupilot-log";
  if ((h[8] === 0xfe || h[8] === 0xfd) && h.length > 16 && (/\.tlog$/.test(low) || (h[0] === 0 && h[1] >= 1 && h[1] <= 0x0e))) return "tlog";
  if (h[0] === 0x24 && h[1] === 0x40) return "sbf";
  if ((h[0] === 0xb5 && h[1] === 0x62) || (/\.ubx$/.test(low) && find(h.subarray(0, 4096), "\xb5b") >= 0)) return "ubx";
  if (h[0] === 0xaa && h[1] === 0x44 && (h[2] === 0x12 || h[2] === 0x13)) return "novatel";
  if (/\.sbf$/.test(low)) return "sbf";
  if (h[0] === 0x1e && h[1] === 0x8a && h[2] === 0x9a && h[3] === 0x5e && h[4] === 0xff && h[5] === 0xff) return "bbx";
  if (h[0] === 0x1e && h[1] === 0x8a && h[2] === 0x9a && h[3] === 0x5e && /\.efl$/.test(low)) return "efl";
  if (h.length > 32 && /^BUILD /.test(new TextDecoder("latin1").decode(h.subarray(16, 22))) && /\.dat$/.test(low)) return "dji-dat";
  if (/^# [^\n]*\r?\n0{9};\d+;\d+;[^;\n]*;/.test(s)) return "jeti";
  if (/\.bbz$/.test(low) || (h[0] === 0x50 && h[1] === 0x4b && h[2] === 3 && h[3] === 4 && /^(syslog|version|log_\d+\.txt|IX-[\w-]+\.bb3)$/.test(new TextDecoder().decode(h.subarray(30, 30 + (h[26] | h[27] << 8)))))) return "bbz";
  if (/<pix4dmapper[\s>]/.test(s) || (/\.p4d$/.test(low) && /^\s*(<\?xml[^>]*>\s*)?</.test(s))) return "pix4d-project";
  if (/\.(psx|psz)$/.test(low) || /^\s*(<\?xml[^>]*>\s*)?<(document|chunk|frame) version="\d+\.\d+\.\d+"/.test(s) || (h[0] === 0x50 && h[1] === 0x4b && h[2] === 3 && h[3] === 4 && new TextDecoder().decode(h.subarray(30, 30 + (h[26] | h[27] << 8))) === "doc.xml")) return "metashape";
  if (/^(\xef\xbb\xbf|\ufeff)?source,output,status,message,width,height,distance,humidity,emissivity,reflection,ambient_temp,/.test(s)) return "thermotiff-log";
  if (/^\s*\{/.test(s) && /"software"\s*:\s*\{\s*"name"\s*:\s*"ThermoTIFF"/.test(s)) return "thermotiff-record";
  if (/\.bb3$/.test(low) || (h[0] === 0xcd && (h[1] & 0x80))) return "bb3";
  if (/RINEX VERSION \/ TYPE|COMPACT RINEX FORMAT/.test(s.slice(0, 200))) return "rinex";
  if (h[0] === 0xd3 && (h[1] & 0xfc) === 0) return "rtcm3";
  if (/\.(bin|rtcm\d?)$/.test(low) && rtcmProbe(h)) return "rtcm3";
  if (/\.mrk$/.test(low)) return "dji-mrk";
  if (/^#Rev: sensefly\/geoinfo/.test(s)) return "sf-geoinfo";
  if (/<kml[\s>]/.test(s)) return "kml";
  if (/<JOBFile[\s>]/.test(s)) return "jxl";
  if (/<Project>[\s\S]*<trajectory|<Project>\s*<Files>/.test(s)) return "pcmp";
  if (/\.pix4dcapture-mission(-plan)?$/.test(low) || (/^\s*\{/.test(s) && /"missionType"\s*:/.test(s) && /"(surveyRegion|missionPlan)"\s*:/.test(s))) return "pix4dcapture-mission";
  if (/"geotaggingSessionId"/.test(s)) return "wingtra-geotaglog";
  if (/^\s*\{/.test(s) && /"captureState"|"planeId"|"ppkSupportedSignals"/.test(s)) return "wingtra-json";
  if (/^\[General\][\s\S]*EventsRTKFix/.test(s)) return "wingtra-ini";
  if (/^# image name,latitude/.test(s)) return "wingtra-geotags";
  if (/<gpx[\s>]/.test(s)) return "gpx";
  if (/(^|\/)djiflightrecord_[^/]*\.txt$/.test(low) && h.length >= 100 && h[10] >= 1 && h[10] <= 20) return "dji-fr";
  if (/^\d\d:\d\d:\d\d : (Console log file|=== New session|Robot \S+ created)/.test(s)) return "emotion-transcript";
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[\w\]\[AppNavManager:\d+\]:\s+--- App Start/.test(s) || /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[\w\].*Pix4Dcapture version/.test(s)) return "pix4dcapture-log";
  if (/^\d{8}-\d{6}\.\d{3}Z:(DBG|INFO|WRN|ERR) [\w.]+: /.test(s)) return "ebeex-afpu";
  if (/^\[\["\d{4}-\d\d-\d\d \d\d:\d\d:\d\d","[^"]*","/.test(s)) return "dji-events";
  if (/^\uFEFF?CUSTOM\.dateTime,OSD\.flyTime,OSD\.latitude,/.test(s)) return "dji-fr-csv";
  if (/\.(csv|txt)$/.test(low) && !/[\x00-\x08]/.test(s.slice(0, 512)) && csvHeader(s)) return "csv-geotags";
  if (/\.csv$/.test(low) && !/[\x00-\x08]/.test(s.slice(0, 512)) && csvColumns(s)) return "csv-columns";
  if (/^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.\d+ [A-Z]{2,4}: /.test(s)) return "lidar-service";
  if (/^\0*\d{4}-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d\.\d+\|\s*[A-Z]+\s*\|/.test(s) || /^<\?xml[^>]*>\s*<log>\s*(<severity level="\w+" timestamp="\d{4}-[A-Z][a-z]{2}-|$)/.test(s)) return "wingtra-obc";
  if ((h.length >= 16 && h[0] === 0 && h[4] === 0 && h[5] === 4 && startsWith(h.subarray(8), "WINGTRA-")) || LIDAR_PART.test(n)) return "lidar-data";
  if (/(^|\n)[^\n$]{0,40}\$(G[PNLABQ]|BD)(GGA|RMC|GSA|GSV|VTG|ZDA|GLL|GST),/.test(s.slice(0, 2048)) && !/[\x00-\x08\x0e-\x1f]/.test(s.slice(0, 512))) return "nmea";
  if (/(^|\/)(diag|hostlog|httplog|sequoia_diag)\.dat$/.test(low) || /_em\.bb3$/.test(low)) return "encrypted";
  if (/^[\s\S]{0,8}[\w-]+\/[\w\/.-]+\.lz\.enc\0/.test(s.slice(0, 300))) return "encrypted";   // DJI device log bundle (DJI Assistant export)
  return null;
}
/* names that look like logs or geotags even when the content is not recognised */
function rtcmProbe(h) { for (let i = 0; i + 6 < Math.min(h.length, 8192); i++) { if (h[i] !== 0xd3 || (h[i + 1] & 0xfc)) continue; const n = ((h[i + 1] & 3) << 8) | h[i + 2]; if (i + 6 + n <= h.length && crc24(h, i, i + 3 + n) === ((h[i + 3 + n] << 16) | (h[i + 4 + n] << 8) | h[i + 5 + n])) return true; } return false; }
const LOGNAME = /\.(gz|crx|rnx|mrk|obs|nav|bin|rtcm\d?|ulg|tlog|nmea|nma|gpx|geotaglog|ini|sbf|bb3|bbx|bbz|efl|kml|jxl|pcmp|dat|data|log|pix4dcapture-mission(-plan)?|p4d|psx|psz|\d\d[ognlpc])$|geotags\.csv$|geoinfo\.txt$|(^|[\s_])flight[\s_]\d+\.json$/i;

async function parse(src, name, o) {
  o = o || {};
  let h = await slice(src, 0, 65536), gz = false;
  // gzip (.gz, as RINEX from IGS/EUREF/CZEPOS is distributed): unpacked in memory, then recognised by its content
  if (h[0] === 0x1f && h[1] === 0x8b && sizeOf(src) <= 200 * 1048576) { try { src = await gunzip(await slice(src, 0, sizeOf(src))); h = src.subarray(0, 65536); gz = true; } catch (e) { /* not readable as gzip */ } }
  let kind = sniff(gz ? String(name).replace(/\.gz$/i, "") : name, h); const size = sizeOf(src);
  if (kind === "csv-columns" && o.csvMap) kind = "csv-geotags";   // columns assigned by the user
  const P = PARSERS[kind];
  if (!P) return null;
  const L = newLog(kind, name, size); if (gz) L.notes.push("gzip");
  try { await P(src, L, h, o); } catch (e) { L.notes.push("parse-error"); L.error = String(e && e.message || e); }
  sanity(L, o.now);
  atExposure(L);
  L.trajectory = thin(L.trajectory);
  L.verify = verify(L);
  if (L.verify.state === "new") L.notes.push("unverified");
  if (!L.error && !L.encrypted && !L.listOnly && L.size && L.startMs == null && !L.exposures.length && !L.trajectory.length && !L.raw && !L.panels && !L.notes.some(n => /encrypted|undocumented|empty|no-positions|plan|processing|project-pointer|unmapped|clock-unset/.test(n)) && !L.facts.some(f => /^(fBase|fFiles|fMessages|fPackets|fTopics|fParams|fPlacemarks|fPoints)/.test(f[0]) && f[1])) L.notes.push("nothing-read");
  return L;
}

/* ---------------------------------------------------------------- plausibility of values
   Firmware updates and new aircraft can change units, scales or field order without changing the format name.
   Values outside physical limits are therefore removed from the result (positions) or reported (times), and counted. */
const GPS_EPOCH = Date.UTC(1980, 0, 6), MAX_SPEED = 120;
function sanity(L, now) {
  now = now || Date.now(); const okT = t => t == null || (t >= GPS_EPOCH && t <= now + 86400000), bad = {};
  let hit = k => { bad[k] = (bad[k] || 0) + 1; };
  let hit0 = hit;
  const pos = p => { if (p.lat == null && p.lon == null) return true; if (isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) < 1e-6 && Math.abs(p.lon) < 1e-6) { hit("noFix"); p.lat = p.lon = null; p.h = null; return false; }
    if (!isFinite(p.lat) || !isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) { hit("position"); p.lat = p.lon = null; p.h = null; return false; } if (p.h != null && (!isFinite(p.h) || p.h < -500 || p.h > 12000)) { hit("height"); p.h = null; } return true; };
  for (const e of L.exposures) {
    pos(e); if (!okT(e.t)) { hit("time"); e.t = null; }
    for (const k of ["sH", "sV", "sN", "sE"]) if (e[k] != null && (!isFinite(e[k]) || e[k] < 0 || e[k] > 1000)) { hit("sigma"); e[k] = null; }
  }
  // track points are counted under one key, so a point that is also an exposure is not counted twice
  let track = 0, trackNoFix = 0; hit = k => { if (k === "noFix") trackNoFix++; else track++; };
  L.trajectory = L.trajectory.filter(p => { if (!okT(p.t)) { track++; return false; } pos(p); return p.lat != null; });
  hit = hit0; if (track) bad.track = track; if (trackNoFix && !bad.noFix) bad.noFix = trackNoFix;
  if (!okT(L.startMs) || !okT(L.endMs)) { hit("span"); L.startMs = L.endMs = null; }
  if (L.startMs != null && L.endMs - L.startMs > 7 * 86400000) hit("duration");
  // speed between consecutive timed exposures (fixed-wing survey flights stay well below 120 m/s)
  const te = L.exposures.filter(e => e.t != null && e.lat != null).sort((a, b) => a.t - b.t); let fast = 0;
  for (let i = 1; i < te.length; i++) { const a = te[i - 1], b = te[i], dt = (b.t - a.t) / 1000; if (dt <= 0) continue; const d = Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos(a.lat / R2D)); if (d / dt > MAX_SPEED && d > 50) fast++; }
  if (fast) bad.speed = fast;
  L.sanity = bad;
  if (bad.noFix) fact(L, "fNoFix", bad.noFix);
  const real = Object.entries(bad).filter(x => x[0] !== "noFix");
  if (real.length) { L.notes.push("implausible"); fact(L, "fImplausible", real.map(([k, v]) => k + ": " + v).join(", ")); }
}

/* ---------------------------------------------------------------- flight state at each exposure
   Parsers that know it leave L._aux = { gq: GNSS quality [{t, sv, hdop | eph, fix}], vib: [{t, imu, v (largest axis, m/s²), clip (cumulative)}],
   modes: mode changes [{t, name, auto}], ev: messages of severity warning or worse [{t, lvl (0–7, RFC 5424), msg}] }, all in UTC ms.
   Each timed exposure gets the GNSS record nearest in time (within 2 s), the largest vibration within ±0.5 s and the mode in force.
   An exposure with a time but no position gets one interpolated linearly between the two trajectory points around it
   when they are at most 2 s apart; it is marked interp and stays an estimate. e._tc is the exposure time on the clock of the
   trajectory and of _aux (tlog: receive time; ULog: boot time), used when the exposure's own time comes from another clock. */
const AT_GAP = 2000, AT_VIB = 500;
function atExposure(L) {
  const A = L._aux || {}; delete L._aux;
  const ex = L.listOnly ? [] : L.exposures.filter(e => (e._tc != null ? e._tc : e.t) != null), tc = e => e._tc != null ? e._tc : e.t;
  const byT = a => (a || []).filter(x => x.t != null && isFinite(x.t)).sort((x, y) => x.t - y.t);
  const after = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t <= t) lo = m + 1; else hi = m; } return lo; };   // first index with a[i].t > t
  // 4 positions interpolated to the exposure time
  const tr = byT(L.trajectory.filter(p => p.lat != null)); let interp = 0;
  if (tr.length > 1) for (const e of ex) { if (e.lat != null) continue; const t = tc(e), i = after(tr, t), a = tr[i - 1]; let b = tr[i];
    if (a && a.t === t) b = a; if (!a || !b || b.t - a.t > AT_GAP) continue;
    const f = b === a ? 0 : (t - a.t) / (b.t - a.t);
    e.lat = a.lat + f * (b.lat - a.lat); e.lon = a.lon + f * (b.lon - a.lon); if (e.h == null && a.h != null && b.h != null) e.h = a.h + f * (b.h - a.h); e.interp = true; interp++; }
  const gq = byT(A.gq), vib = byT(A.vib), modes = byT(A.modes), evs = byT(A.ev);
  if (!ex.length || !(gq.length || vib.length || modes.length || evs.length || interp)) { for (const e of L.exposures) delete e._tc; return; }
  for (const e of ex) { const t = tc(e);
    if (gq.length) { const g = nearest(gq, t); if (Math.abs(g.t - t) <= AT_GAP) { e.sv = g.sv; if (g.hdop != null) e.hdop = +(+g.hdop).toFixed(2); if (g.eph != null) e.eph = +(+g.eph).toFixed(2); e.fix = g.fix; } }
    if (vib.length) { let v = null; for (let i = Math.max(0, after(vib, t - AT_VIB - 1)); i < vib.length && vib[i].t <= t + AT_VIB; i++) if (vib[i].t >= t - AT_VIB && isFinite(vib[i].v)) v = Math.max(v == null ? 0 : v, vib[i].v); if (v != null) e.vib = +v.toFixed(1); }
    if (modes.length) { const i = after(modes, t); if (i > 0) { e.mode = modes[i - 1].name; e.auto = modes[i - 1].auto; } } }
  // summary for the check: imaging window = first to last exposure
  const ts = ex.map(tc), t0 = Math.min(...ts), t1 = Math.max(...ts), S = { n: ex.length, interp };
  const G = ex.filter(e => e.fix != null || e.sv != null);
  if (G.length) S.gnss = { n: G.length, svMed: median(G.map(e => e.sv)), svMin: G.some(e => e.sv != null) ? Math.min(...G.filter(e => e.sv != null).map(e => e.sv)) : null,
    hdopMax: G.some(e => e.hdop != null) ? Math.max(...G.filter(e => e.hdop != null).map(e => e.hdop)) : null, ephMax: G.some(e => e.eph != null) ? Math.max(...G.filter(e => e.eph != null).map(e => e.eph)) : null,
    low: G.filter(e => e.fix != null && e.fix < 3).length, none: ex.length - G.length };
  const V = ex.filter(e => e.vib != null);
  if (V.length) { const clip = {}; for (const v of vib) if (v.t >= t0 - AT_VIB && v.t <= t1 + AT_VIB && isFinite(v.clip)) { const c = clip[v.imu] || (clip[v.imu] = [v.clip, v.clip]); c[0] = Math.min(c[0], v.clip); c[1] = Math.max(c[1], v.clip); }
    S.vib = { n: V.length, max: Math.max(...V.map(e => e.vib)), over30: V.filter(e => e.vib > 30).length, over60: V.filter(e => e.vib > 60).length, clip: Object.values(clip).reduce((s, c) => s + c[1] - c[0], 0) }; }
  const M = ex.filter(e => e.mode != null);
  if (M.length) S.modes = { n: M.length, names: [...new Set(M.map(e => e.mode))], out: M.filter(e => e.auto === false).length, outNames: [...new Set(M.filter(e => e.auto === false).map(e => e.mode))], unknown: M.every(e => e.auto == null) };
  const W = evs.filter(x => x.t >= t0 && x.t <= t1);
  // repeated messages (a real tlog repeats "Arming Checks Disabled" every few seconds) are listed once with their count
  // messages that differ only in numbers (a Wingtra log repeats "Found Trigger! TOW, WNc, …" with each trigger) form one kind, shown with # for the numbers;
  // errors (level 3 or worse) are listed first, then the most frequent kinds
  if (W.length) { const by = new Map(); for (const x of W) { const k = x.msg.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, "#"), g = by.get(k) || { msg: x.msg, n: 0, lvl: x.lvl }; g.n++; g.lvl = Math.min(g.lvl, x.lvl); by.set(k, g); }
    const kinds = [...by].sort((a, b) => (b[1].lvl <= 3) - (a[1].lvl <= 3) || b[1].n - a[1].n);
    S.ev = { n: W.length, err: W.filter(x => x.lvl <= 3).length, kinds: by.size, first: kinds.slice(0, 3).map(([k, g]) => g.n > 1 ? k + " ×" + g.n : g.msg) }; }
  L.atExp = S;
  for (const e of L.exposures) delete e._tc;
}

/* ---------------------------------------------------------------- versions checked against real files
   Each entry: the log kind, a test on the version string (format revision, firmware or receiver firmware) and where it was checked.
   A file outside the list is read the same way; the reader only says that its values should be checked.
   "standard" marks formats defined by a published specification (RINEX, RTCM, ULog, UBX, KML): a new version there is less risky. */
const VERIFIED = [
  { kind: "dji-mrk", re: /^DJI MRK$/, ver: "Mavic 3M (2025–2026), Mavic 3E FW 10.12 (2023)", src: "internal + public (Zenodo 8400634)" },
  { kind: "rinex", re: /^(Compact RINEX \(Hatanaka\) (1|3)(\.0)? \/ )?RINEX (2\.1\d?|3\.0[2-5])\b/, ver: "RINEX 2.10/2.11, 3.02–3.05; Compact RINEX 1/3 (Hatanaka), gzip", src: "internal + RTKLIB", standard: true },
  { kind: "rtcm3", re: /^RTCM 3/, ver: "RTCM 3.x MSM4–7, 1005–1033", src: "internal (DJI PPKRAW.bin)", standard: true },
  { kind: "ulog", re: /^Wingtra 2\.20\.|^PX4 1\.(6|1[1-6])\./, ver: "Wingtra 2.20.x; PX4 1.6, 1.13–1.16", src: "internal + pyulog", standard: true },
  { kind: "sbf", re: /^(AsteRx-m2[^|]* 6\.0\.|mosaic-X5[^|]* 6\.12\.|Post Processing SDK|TRIMBLE ALLOY)/, ver: "AsteRx-m2 6.0.x, mosaic-X5 6.12.x, Septentrio PP SDK, Trimble Alloy (RINEX → SBF)", src: "internal" },
  { kind: "bb3", re: /^eBee X .*6\.0\.|^encrypted$/, ver: "eBee X, AsteRx-m2 6.0.x", src: "internal" },
  { kind: "sf-geoinfo", re: /rev 3$/, ver: "geoinfo rev 3", src: "internal" },
  { kind: "kml", re: /eMotion|^KML$/, ver: "eMotion 3 (eBee Plus, eBee X)", src: "internal", standard: true },
  { kind: "jxl", re: /JobXML 5\.7/, ver: "JobXML 5.7 (eMotion)", src: "internal" },
  { kind: "mica-gpslog", re: /^v7\.|^v1\.3\./, ver: "RedEdge-MX v7.x, RedEdge-P v1.3.x", src: "internal" },
  { kind: "mica-paramlog", re: /./, ver: "RedEdge-M, RedEdge-MX v7.x, RedEdge-P v1.3.x", src: "internal" },
  { kind: "ubx", re: /./, ver: "u-blox 5–M8 (NAV-PVT, NAV-SOL, RXM-RAW/RAWX)", src: "internal + RTKLIB", standard: true },
  { kind: "tlmb", re: /^1\.7\./, ver: "Sequoia 1.7.x", src: "internal" },
  { kind: "wingtra-geotaglog", re: /v1$/, ver: "geotaglog v1 (WingtraPilot 2.20)", src: "internal" },
  { kind: "wingtra-json", re: /^v?2\.20\./, ver: "WingtraPilot 2.20.x", src: "internal" },
  { kind: "wingtra-ini", re: /./, ver: "WingtraHub 2.x", src: "internal" },
  { kind: "wingtra-geotags", re: /./, ver: "WingtraHub 2.x", src: "internal" },
  { kind: "lidar-service", re: /^5\.4\./, ver: "Wingtra LiDAR 5.4.x", src: "internal" },
  { kind: "pcmp", re: /./, ver: "Wingtra LiDAR 5.4.x", src: "internal" },
  { kind: "wingtra-obc", re: /^v?2\.(19|20)\.|^"?[pv]?2\.8\.3/, ver: "WingtraPilot 2.8.3 (xml), 2.19–2.20 (txt)", src: "internal" },
  { kind: "lidar-data", re: /^5\.4\./, ver: "Wingtra LiDAR 5.4.x (NovAtel OEM7500, Hesai PandarXT32)", src: "internal" },
  { kind: "novatel", re: /./, ver: "OEMV (RTKLIB); OEM7 BESTPOS, RANGECMP4 inside Wingtra LiDAR .data", src: "RTKLIB + internal" },
  { kind: "encrypted", re: /./, ver: "–", src: "internal" },
  // read from the published format descriptions; NMEA, GPX and CSV checked only on synthetic files so far
  { kind: "ardupilot-bin", re: /^Ardu(Plane 4\.4\.|Copter 4\.6\.)/, ver: "ArduPlane 4.4.x, ArduCopter 4.6.x", src: "public (Zenodo 12107372, 22310050)", standard: true },
  { kind: "ardupilot-log", re: /^ArduCopter 4\.3\./, ver: "ArduCopter 4.3.x", src: "public (Zenodo 8199999)", standard: true },
  { kind: "tlog", re: /^ArduCopter V?4\.6\./, ver: "ArduCopter 4.6.x", src: "public (Zenodo 22310050)", standard: true },
  { kind: "nmea", re: /(?!)/, ver: "", src: "synthetic", standard: true },
  { kind: "gpx", re: /(?!)/, ver: "", src: "synthetic", standard: true },
  { kind: "csv-geotags", re: /(?!)/, ver: "", src: "synthetic", standard: true },
  { kind: "csv-columns", re: /(?!)/, ver: "", src: "synthetic", standard: true },
  { kind: "dji-fr-csv", re: /IOS 4\.(9[5-9]|10[0-7])\./, ver: "iOS app 4.95–4.107 (FlightRecord v14, decoded with dji-log-parser 0.5.7)", src: "internal + synthetic" },
  { kind: "dji-fr-csv", re: /DJIFly (10\.1\.8|46\.0\.0)$/, ver: "Mavic 3 Enterprise series, app platform 6 (10.1.8, 46.0.0; 2026): summary and track, exposures not in the CSV", src: "internal" },
  { kind: "emotion-transcript", re: /./, ver: "eMotion 2 console transcript (eBee Classic, 2017)", src: "internal" },
  { kind: "ebeex-afpu", re: /^3\.22\./, ver: "eBee X FW 3.22.0", src: "internal" },
  { kind: "pix4dcapture-log", re: /^4\.1[23]\./, ver: "Pix4Dcapture iOS 4.12–4.13", src: "internal" },
  { kind: "bbz", re: /^eBee X .*6\.0\./, ver: "eBee X FW 3.22.0, AsteRx-m2 6.0.x", src: "internal" },
  { kind: "pix4dcapture-mission", re: /^(iOS-)?4\.8\.|^$/, ver: "Pix4Dcapture iOS 4.8 (mission and last-plan files)", src: "internal" },
  { kind: "bbx", re: /^2\.4\./, ver: "eBee firmware 2.4.x (eMotion 2)", src: "internal" },
  { kind: "dji-events", re: /./, ver: "DJI app events (2026)", src: "internal" },
  { kind: "dji-dat", re: /./, ver: "–", src: "internal" },
  { kind: "jeti", re: /./, ver: "Jeti DC/DS (2016)", src: "internal" },
  { kind: "efl", re: /./, ver: "–", src: "internal" },
  { kind: "pix4d-project", re: /^Pix4Dmapper 4\.4\./, ver: "Pix4Dmapper 4.4.12 (.p4d file version 21)", src: "internal" },
  { kind: "metashape", re: /^Metashape 2\.1\./, ver: "Metashape 2.1.2 (chunk format 1.7.0)", src: "internal" },
  // ThermoTIFF 0.1.0: read from its source code; conversion_log.csv also checked on a real run (DJI M3T, SDK API 0x13), processing_record.json on synthetic files only
  { kind: "thermotiff-log", re: /^ThermoTIFF/, ver: "ThermoTIFF 0.1.0 (DJI Thermal SDK API 0x13, M3T)", src: "internal" },
  { kind: "thermotiff-record", re: /(?!)/, ver: "", src: "source code + synthetic" },
  { kind: "dji-fr", re: /^v(8)\b/, ver: "FlightRecord v8 (iOS apps 4.3.64 and 4.9.1; 2019, 2026)", src: "internal" },
  { kind: "dji-fr", re: /^v(14)\b/, ver: "FlightRecord v14, summary only (iOS apps 4.95 and 4.103, 2022; app on platform 6, 2026)", src: "internal" }
];
function factOf(L, k) { const f = L.facts.find(x => x[0] === k); return f ? String(f[1]) : ""; }
/* the version string that decides whether a parser was checked on this variant */
function versionKey(L) {
  const d = L.device || {}, fm = factOf(L, "fFormat");
  switch (L.kind) {
    case "dji-mrk": return "DJI MRK";
    case "rinex": case "rtcm3": case "jxl": case "sf-geoinfo": case "wingtra-geotaglog": return fm;
    case "kml": return /eMotion/.test(fm) ? fm : "KML";
    case "ulog": return d.fw && !/^[0-9a-f]{40}$/.test(d.fw) ? (d.make === "Wingtra" ? "Wingtra " : "PX4 ") + d.fw : "";
    case "sbf": return (d.receiver || "") + " " + (d.fw || "");
    case "bbz": case "bb3": return d.receiver ? "eBee X " + d.receiver + " " + (d.fw || "") : L.encrypted || L.notes.includes("bb3-encrypted-part") ? "encrypted" : "";
    case "mica-gpslog": case "tlmb": case "lidar-service": case "lidar-data": case "wingtra-json": case "wingtra-obc": return d.fw || "";
    case "novatel": return "NovAtel";
    case "ardupilot-bin": case "ardupilot-log": case "tlog": return d.fw || fm;
    case "nmea": case "gpx": case "csv-geotags": return fm;
    case "csv-columns": return "";   // nothing read yet: the version check follows the columns assigned by hand
    case "emotion-transcript": return fm;
    case "ebeex-afpu": case "pix4dcapture-log": case "pix4dcapture-mission": case "bbx": return d.fw || "";
    case "thermotiff-log": case "thermotiff-record": return L.proc && L.proc.software[0].version ? "ThermoTIFF " + L.proc.software[0].version : "ThermoTIFF";
    case "pix4d-project": case "metashape": return L.proc && L.proc.software[0] && L.proc.software[0].version ? (L.kind === "metashape" ? "Metashape " : "Pix4Dmapper ") + L.proc.software[0].version : "";
    case "dji-fr": return "v" + (fm.match(/v(\d+)/) || [, ""])[1];
    case "dji-fr-csv": return [L.device.model, factOf(L, "fSoftware")].filter(Boolean).join(" ");
    default: return fm || L.kind;
  }
}
function verify(L) {
  const list = VERIFIED.filter(v => v.kind === L.kind), key = versionKey(L).trim();
  if (!list.length) return { state: "new", key, known: "" };
  const known = list.map(v => v.ver).join("; "), standard = list.some(v => v.standard);
  if (!key) return { state: "none", key, known, standard };
  return { state: list.some(v => v.re.test(key)) ? "ok" : "new", key, known, standard };
}

/* ---------------------------------------------------------------- DJI Timestamp.MRK */
const DJI_Q = { 50: "fixed", 34: "float", 16: "single", 0: "none" };
async function pMRK(src, L) {
  L.device.make = "DJI"; L.timeSource = "GPS week + seconds of week − leap seconds";
  const qs = [];
  await eachLine(src, l => {
    const p = l.trim().split(/\t+/); if (p.length < 10) return;
    const sow = parseFloat(p[1]), wk = parseInt(String(p[2]).replace(/[\[\]]/g, ""), 10);
    const val = x => parseFloat(String(x).split(",")[0]);
    const lat = val(p[6]), lon = val(p[7]), h = val(p[8]); const sd = String(p[9]).split(",").map(parseFloat);
    const q = parseInt(String(p[10] || "").split(",")[0], 10);
    if (!isFinite(sow) || !isFinite(wk)) return;
    const t = wk > 1000 && sow >= 0 ? gpsToUtc(wk, sow * 1000) : null; if (t == null && !L.notes.includes("mrk-no-gnss-time")) L.notes.push("mrk-no-gnss-time"); span(L, t); qs.push(q);
    L.exposures.push({ n: parseInt(p[0], 10), t, lat, lon, h, sN: sd[0], sE: sd[1], sV: sd[2], q: DJI_Q[q] || "Q=" + q, qRaw: q });
  });
  L.trajectory = L.exposures.map(e => ({ t: e.t, lat: e.lat, lon: e.lon, h: e.h }));
  fact(L, "fExposures", L.exposures.length);
  fact(L, "fQuality", Object.entries(countBy(qs, x => x)).map(([k, v]) => "Q " + k + ": " + v).join(", "));
  fact(L, "fSigma", [median(L.exposures.map(e => e.sN)), median(L.exposures.map(e => e.sE)), median(L.exposures.map(e => e.sV))].map(x => x == null ? "–" : x.toFixed(3)).join(" / ") + " m");
  fact(L, "fHeight", "ellipsoid");
  if (L.notes.includes("mrk-no-gnss-time")) fact(L, "fNoTime", "GPS week/SOW invalid");
}

/* ---------------------------------------------------------------- RINEX 2/3 */
async function pRINEX(src, L) {
  const hdr = {}; let inHdr = true, ver = null, type = null, nEp = 0, first = null, last = null, prev = null; const dts = [], sats = [], flags = {}, navSat = {};
  const tOf = (y, mo, d, hh, mi, ss) => { y = +y; if (y < 80) y += 2000; else if (y < 100) y += 1900; return Date.UTC(y, mo - 1, +d, +hh, +mi) + parseFloat(ss) * 1000; };
  // Compact RINEX (Hatanaka): only the epoch lines are rebuilt (text differences against the previous epoch line); observations are skipped
  let crx = 0, crxEp = "", crxSkip = 0;
  const crxLine = l => {
    if (crxSkip > 0) { crxSkip--; return null; }
    if (l[0] === ">" || l[0] === "&") crxEp = crx >= 3 ? l : " " + l.slice(1);
    else { let o = ""; const n = Math.max(l.length, crxEp.length); for (let i = 0; i < n; i++) { const c = l[i]; o += c === undefined || c === " " ? (crxEp[i] || " ") : c === "&" ? " " : c; } crxEp = o; }
    const ns = parseInt(crx >= 3 ? crxEp.slice(32, 35) : crxEp.slice(29, 32), 10), fl = +(crx >= 3 ? crxEp[31] : crxEp[28]);
    crxSkip = (isFinite(ns) ? ns : 0) + (fl > 1 ? 0 : 1); return crxEp;
  };
  await eachLine(src, l0 => {
    let l = l0;
    if (crx && !inHdr) { l = crxLine(l0); if (l == null) return; }
    if (inHdr) {
      const lab = l.slice(60).trim(), v = l.slice(0, 60);
      if (lab === "CRINEX VERS   / TYPE") { crx = parseFloat(v) || 1; return; }
      if (lab === "CRINEX PROG / DATE") return;
      if (lab) (hdr[lab] = hdr[lab] || []).push(v);
      if (lab === "RINEX VERSION / TYPE") { ver = parseFloat(v.slice(0, 9)); type = v.slice(20, 21); }
      if (lab === "END OF HEADER") inHdr = false;
      return;
    }
    if (type === "O") {
      let m;
      if (ver >= 3 && l[0] === ">") { const p = l.slice(1).trim().split(/\s+/); m = p; }
      else if (ver < 3 && /^ \d\d \s?\d{1,2} \s?\d{1,2} \s?\d{1,2} \s?\d{1,2}\s+\d+\.\d+\s+\d\s*\d/.test(l)) m = [l.slice(1, 3), l.slice(4, 6), l.slice(7, 9), l.slice(10, 12), l.slice(13, 15), l.slice(15, 26), l.slice(28, 29), l.slice(29, 32)].map(x => x.trim());
      if (!m) return;
      const t = tOf(m[0], m[1], m[2], m[3], m[4], m[5]); if (!isFinite(t)) return;
      nEp++; if (first == null) first = t; last = t; if (prev != null && dts.length < 200000) dts.push(t - prev); prev = t;
      flags[m[6]] = (flags[m[6]] || 0) + 1; sats.push(parseInt(m[7], 10));
    } else {
      const sv = ver >= 3 ? /^([GRECJIS]\d\d) \d{4} /.exec(l) : /^(\d\d| \d) \d\d /.exec(l);
      if (sv) navSat[sv[1].trim()] = (navSat[sv[1].trim()] || 0) + 1;
    }
  });
  const H = k => (hdr[k] || [""])[0];
  L.raw = { format: "RINEX " + ver, type: type === "O" ? "obs" : "nav" };
  fact(L, "fFormat", (crx ? "Compact RINEX (Hatanaka) " + crx + " / " : "") + "RINEX " + ver + " " + ({ O: "observation", N: "navigation", G: "GLONASS navigation", M: "meteo" }[type] || type));
  fact(L, "fProgram", H("PGM / RUN BY / DATE").replace(/\s{2,}/g, " · ").trim());
  if (type === "O") {
    const marker = H("MARKER NAME").trim(), rec = H("REC # / TYPE / VERS"), ant = H("ANT # / TYPE"), xyz = H("APPROX POSITION XYZ").trim().split(/\s+/).map(parseFloat);
    const dt = median(dts) / 1000, mode = H("MARKER TYPE").trim();
    L.startMs = first; L.endMs = last; L.timeSource = (H("TIME OF FIRST OBS").slice(48, 51).trim() || "GPS") + " time (RINEX epochs)";
    if (first != null && /GPS/.test(L.timeSource)) { L.startMs = gpsMsToUtc(first); L.endMs = gpsMsToUtc(last); }
    L.raw.epochs = nEp; L.raw.interval = dt; L.raw.marker = marker;
    L.device.receiver = rec.slice(20, 40).trim(); L.device.serial = rec.slice(0, 20).trim(); L.device.fw = rec.slice(40, 60).trim(); L.device.antenna = ant.slice(20, 40).trim();
    fact(L, "fMarker", marker); fact(L, "fReceiver", [rec.slice(20, 40).trim(), rec.slice(0, 20).trim(), rec.slice(40, 60).trim()].filter(Boolean).join(" · "));
    fact(L, "fAntenna", ant.slice(20, 40).trim() + (ant.slice(0, 20).trim() ? " · " + ant.slice(0, 20).trim() : ""));
    fact(L, "fEpochs", nEp); fact(L, "fInterval", dt != null ? dt + " s" : null);
    fact(L, "fSats", sats.length ? median(sats) + " (" + Math.min(...sats) + "–" + Math.max(...sats) + ")" : null);
    const sysTypes = (hdr["SYS / # / OBS TYPES"] || []).map(x => x.slice(0, 1)).filter(x => x.trim()); fact(L, "fSystems", [...new Set(sysTypes)].join(" "));
    const gaps = dt ? dts.filter(d => d > 2.5 * dt * 1000).length : 0; fact(L, "fGaps", gaps);
    const flagsOther = Object.entries(flags).filter(([k]) => k !== "0"); if (flagsOther.length) fact(L, "fEpochFlags", flagsOther.map(([k, v]) => k + ": " + v).join(", "));
    if (xyz.length === 3 && xyz.every(isFinite) && Math.hypot(...xyz) > 6e6) {
      const g = ecefToGeo(xyz[0], xyz[1], xyz[2]); fact(L, "fApprox", g.lat.toFixed(7) + ", " + g.lon.toFixed(7) + ", " + g.h.toFixed(2) + " m");
      L.raw.approx = g;
    }
    const kinematic = /kinematic|rover|non_geodetic|airborne/i.test(mode) || (dt != null && dt < 1);
    L.raw.role = kinematic ? "rover" : "base";
    if (!kinematic) L.base = { marker, receiver: L.device.receiver, antenna: L.device.antenna, approx: L.raw.approx || null, startMs: L.startMs, endMs: L.endMs, interval: dt };
    fact(L, "fRole", L.raw.role);
  } else {
    fact(L, "fNavRecords", Object.values(navSat).reduce((a, b) => a + b, 0)); fact(L, "fNavSats", Object.keys(navSat).length);
  }
}
function ecefToGeo(x, y, z) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - e2)), h = 0;
  for (let i = 0; i < 6; i++) { const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
  return { lat: lat * R2D, lon: Math.atan2(y, x) * R2D, h };
}

/* ---------------------------------------------------------------- RTCM 3 */
function bits(b, pos, n) { let v = 0; for (let i = 0; i < n; i++) { const k = pos + i; v = v * 2 + ((b[k >> 3] >> (7 - (k & 7))) & 1); } return v; }
async function pRTCM(src, L) {
  const types = {}; let bad = 0, n = 0, week = null; const tows = new Set(); let tmin = null, tmax = null, stn = new Set();
  await scan(src, (b, fin) => {
    let i = 0;
    while (i + 6 <= b.length) {
      if (b[i] !== 0xd3) { i++; continue; }
      const len = ((b[i + 1] & 3) << 8) | b[i + 2]; if (i + 6 + len > b.length) { if (fin) break; return i; }
      const c = (b[i + 3 + len] << 16) | (b[i + 4 + len] << 8) | b[i + 5 + len];
      if (crc24(b, i, i + 3 + len) !== c) { bad++; i++; continue; }
      const p = b.subarray(i + 3, i + 3 + len), t = bits(p, 0, 12); types[t] = (types[t] || 0) + 1; n++;
      if (t >= 1071 && t <= 1077) { const tow = bits(p, 24, 30); tows.add(tow); if (tmin == null || tow < tmin) tmin = tow; if (tmax == null || tow > tmax) tmax = tow; stn.add(bits(p, 12, 12)); }
      if (t === 1019 && week == null) week = bits(p, 18, 10);
      i += 6 + len;
    }
    return b.length;
  });
  const ep = [...tows].sort((a, b) => a - b), dt = median(ep.slice(1).map((x, k) => x - ep[k])) / 1000;
  L.raw = { format: "RTCM 3", type: "raw rover/base observations", epochs: ep.length, interval: dt };
  fact(L, "fFormat", "RTCM 3.x"); fact(L, "fMessages", n); fact(L, "fCrcBad", bad);
  fact(L, "fMsgTypes", Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " (" + rtcmName(+k) + "): " + v).join(", "));
  fact(L, "fEpochs", ep.length); fact(L, "fInterval", dt != null ? dt + " s" : null);
  if (week != null && tmin != null) { const wk = week + 2048; L.startMs = gpsToUtc(wk, tmin); L.endMs = gpsToUtc(wk, tmax); L.timeSource = "GPS MSM epochs + week from 1019 (mod 1024 + 2048)"; }
  else if (tmin != null) fact(L, "fTow", (tmin / 1000).toFixed(1) + "–" + (tmax / 1000).toFixed(1) + " s");
}
function rtcmName(t) { if (t >= 1071 && t <= 1137) return ({ 107: "GPS", 108: "GLONASS", 109: "Galileo", 110: "SBAS", 111: "QZSS", 112: "BeiDou", 113: "NavIC" }[Math.floor(t / 10)] || "") + " MSM" + (t % 10); return { 1005: "station ARP", 1006: "station ARP + height", 1007: "antenna", 1008: "antenna + serial", 1019: "GPS ephemeris", 1020: "GLONASS ephemeris", 1033: "receiver + antenna", 1042: "BeiDou ephemeris", 1044: "QZSS ephemeris", 1045: "Galileo F/NAV", 1046: "Galileo I/NAV", 1230: "GLONASS biases", 4011: "proprietary (Swift/DJI)" }[t] || (t >= 4001 ? "proprietary" : ""); }

/* ---------------------------------------------------------------- PX4 ULog (also Wingtra: two extra bytes before each message after the flag bits) */
const UT = { uint8_t: [1, "getUint8"], int8_t: [1, "getInt8"], bool: [1, "getUint8"], char: [1, "getUint8"], uint16_t: [2, "getUint16"], int16_t: [2, "getInt16"], uint32_t: [4, "getUint32"], int32_t: [4, "getInt32"], float: [4, "getFloat32"], double: [8, "getFloat64"], uint64_t: [8, "u64"], int64_t: [8, "i64"] };
function rd(dv, t, o) { const x = UT[t]; if (!x) return null; if (x[1] === "u64") return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; if (x[1] === "i64") return dv.getUint32(o, true) + dv.getInt32(o + 4, true) * 4294967296; return dv[x[1]](o, true); }
async function pULog(src, L, h) {
  const b = src instanceof Uint8Array ? src : await slice(src, 0, sizeOf(src)); const dv = dvOf(b);
  const fmts = {}, subs = {}, info = {}, params = {}, cnt = {}, logs = []; let p = 16, pre = 0, tmin = null, tmax = null, decided = false, badMsg = 0;
  const T = "FIMPQARDLCSOB";
  const lay = {};
  function layout(name) {
    if (lay[name]) return lay[name]; const out = {}; let off = 0;
    for (const f of (fmts[name] || "").split(";")) {
      const m = /^\s*([\w]+)(?:\[(\d+)\])?\s+([\w]+)\s*$/.exec(f); if (!m) continue;
      const t = m[1], c = m[2] ? +m[2] : 1, nm = m[3];
      if (UT[t]) { out[nm] = { t, o: off, c }; off += UT[t][0] * c; }
      else if (fmts[t]) { const s = layout(t); off += s._size * c; }
    }
    out._size = off; return (lay[name] = out);
  }
  const gps = [], att = [], navs = [], wtrig = [], wgeo = [];
  while (p + 3 <= b.length) {
    const ty = String.fromCharCode(b[p + pre + 2]);
    if (!decided && p > 16) { if (T.includes(String.fromCharCode(b[p + 2]))) pre = 0; else if (T.includes(String.fromCharCode(b[p + 4]))) pre = 2; decided = true; continue; }
    if (!T.includes(ty)) { p++; continue; }
    const sz = dv.getUint16(p + pre, true), a = p + pre + 3; if (a + sz > b.length) break;
    const m = b.subarray(a, a + sz), md = dvOf(m);
    try { // a damaged message is counted and skipped; the rest of the log is still read
    if (ty === "F") { const s = asc(m, 0, sz); const k = s.indexOf(":"); fmts[s.slice(0, k)] = s.slice(k + 1); }
    else if (ty === "I" || ty === "M" || ty === "P") {
      const q = ty === "M" ? 1 : 0, kl = m[q], key = asc(m, q + 1, kl), sp = key.indexOf(" "), t = key.slice(0, sp), nm = key.slice(sp + 1), vo = q + 1 + kl;
      let v; if (/^char/.test(t)) v = asc(m, vo, sz - vo); else v = UT[t] ? rd(dvOf(m.subarray(vo)), t, 0) : null;
      if (ty === "P") params[nm] = v; else if (!(nm in info)) info[nm] = v;
    } else if (ty === "A") { subs[md.getUint16(1, true)] = { name: asc(m, 3, sz - 3), multi: m[0] }; }
    else if (ty === "D") {
      const id = md.getUint16(0, true), s = subs[id]; cnt[id] = (cnt[id] || 0) + 1;
      const ts = rd(md, "uint64_t", 2); if (ts > 0) { if (tmin == null || ts < tmin) tmin = ts; if (tmax == null || ts > tmax) tmax = ts; }
      if (s && (s.name === "vehicle_gps_position" || s.name === "sensor_gps") && !s.multi) {
        const Lf = layout(s.name), body = dvOf(m.subarray(2)), g = (k, sc) => Lf[k] ? rd(body, Lf[k].t, Lf[k].o) * (sc || 1) : null;
        const lat = Lf.latitude_deg ? g("latitude_deg") : g("lat", 1e-7), lon = Lf.longitude_deg ? g("longitude_deg") : g("lon", 1e-7);
        const alt = Lf.altitude_ellipsoid_m ? g("altitude_ellipsoid_m") : g("alt_ellipsoid", 1e-3);
        gps.push({ topic: s.name, ts, utc: g("time_utc_usec"), lat, lon, h: alt, fix: g("fix_type"), eph: g("eph"), epv: g("epv"), sv: g("satellites_used") });
      }
      if (s && s.name === "vehicle_status" && !s.multi) { const Lf = layout(s.name); if (Lf.nav_state) { const v = rd(dvOf(m.subarray(2)), Lf.nav_state.t, Lf.nav_state.o); if (!navs.length || navs[navs.length - 1].v !== v) navs.push({ ts, v }); } }
      // WingtraPilot 2.20 logs the trigger in camera_trigger_wingtra (time, sequence) and the autopilot geotag in geotag_dataman_item; there is no camera_capture
      if (s && (s.name === "camera_trigger_wingtra" || s.name === "geotag_dataman_item")) { const Lf = layout(s.name), body = dvOf(m.subarray(2)), g = k => Lf[k] ? rd(body, Lf[k].t, Lf[k].o) : null;
        if (s.name === "camera_trigger_wingtra") wtrig.push({ ts, utc: g("timestamp_utc"), seq: g("seq") }); else wgeo.push({ ts, utc: g("time_utc_usec"), lat: g("lat"), lon: g("lon"), h: g("alt"), ok: g("is_valid") }); }
      if (s && s.name === "camera_capture") { const Lf = layout(s.name), body = dvOf(m.subarray(2)), g = (k, sc) => Lf[k] ? rd(body, Lf[k].t, Lf[k].o) * (sc || 1) : null; att.push({ ts, utc: g("timestamp_utc"), seq: g("seq"), lat: g("lat"), lon: g("lon"), h: g("alt"), ok: g("result") }); }
    } else if (ty === "L") { logs.push({ ts: rd(md, "uint64_t", 1), lvl: m[0], msg: asc(m, 9, sz - 9) }); }
    else if (ty === "C") { const w = pre ? 1 : 2; logs.push({ ts: rd(md, "uint64_t", 1 + w), lvl: m[0], msg: asc(m, 9 + w, sz - 9 - w) }); }   // tag: uint16 in PX4, one byte in the Wingtra variant (WingtraPilot 2.20)
    } catch (e) { badMsg++; }
    p = a + sz;
  }
  const topics = {}; for (const id in subs) { const s = subs[id]; const k = s.name + (s.multi ? "#" + s.multi : ""); topics[k] = (topics[k] || 0) + (cnt[id] || 0); }
  const use = gps.filter(g => g.topic === "vehicle_gps_position").length ? gps.filter(g => g.topic === "vehicle_gps_position") : gps;
  // boot time → UTC from GPS messages with a valid UTC time; without a fix the receiver time is not trusted (a WingtraOne log without a fix gave 2011)
  const sync = use.filter(g => g.utc > 1e15 && (g.fix == null || g.fix >= 2)).map(g => g.utc / 1000 - g.ts / 1000), off = median(sync);
  if (off == null && use.some(g => g.utc > 1e15)) L.notes.push("gps-no-fix-time");
  const toUtc = ts => off == null ? null : ts / 1000 + off;
  L.trajectory = use.filter(g => g.fix >= 2 && g.lat).map(g => ({ t: toUtc(g.ts), lat: g.lat, lon: g.lon, h: g.h, q: fixName(g.fix) }));
  L.exposures = att.map((c, k) => ({ n: c.seq != null ? c.seq : k, t: c.utc > 1e15 ? c.utc / 1000 : toUtc(c.ts), _tc: toUtc(c.ts), lat: c.lat, lon: c.lon, h: c.h, q: "log" }));
  if (!att.length && wtrig.length) {
    // Wingtra: the trigger has a time but no position. The autopilot geotag (geotag_dataman_item) is logged about 0.2 s after the trigger and its
    // height is not ellipsoidal (about 38 m below the GNSS ellipsoidal height in the field log), so it is not joined: the position is interpolated
    // from the GNSS trajectory (ellipsoidal) and marked as an estimate. The exposure time of record is the PPK event in the geotaglog.
    L.exposures = wtrig.map((c, k) => ({ n: c.seq != null ? c.seq : k, t: c.utc > 1e15 ? c.utc / 1000 : toUtc(c.ts), _tc: toUtc(c.ts), lat: null, lon: null, h: null, q: "log" }));
    L._wt = "camera_trigger_wingtra " + wtrig.length + " · geotag_dataman_item " + wgeo.length;
  }
  // WingtraPilot numbers nav_state its own way (the survey runs in state 5, AUTO_RTL in PX4), so for Wingtra the state is shown by number and not rated
  const wingtra = /wingtra/i.test((info.sys_name || "") + (info.vehicle_name || "") + JSON.stringify(info));
  // state at the exposures (atExposure): GNSS quality, navigation state, logged messages of level warning or worse (levels are ASCII digits 0–7)
  L._aux = { gq: use.map(g => ({ t: toUtc(g.ts), sv: g.sv, eph: g.eph, fix: g.fix })), modes: navs.map(x => ({ t: toUtc(x.ts), name: wingtra ? "nav_state " + x.v : PX4_NAV[x.v] || "nav_state " + x.v, auto: wingtra ? null : x.v === 3 })),
    ev: logs.map(x => ({ t: toUtc(x.ts), lvl: x.lvl >= 48 ? x.lvl - 48 : x.lvl, msg: x.msg })).filter(x => x.lvl <= 4) };
  if (tmin != null && off != null) { L.startMs = toUtc(tmin); L.endMs = toUtc(tmax); L.timeSource = "boot time + GPS time_utc_usec"; }
  const sysName = info.sys_name || info.vehicle_name || ""; L.device.make = /wingtra/i.test(sysName + JSON.stringify(info)) ? "Wingtra" : "PX4";
  L.device.model = info.vehicle_name || info.sys_name || null; L.device.fw = info.ver_sw_release_wingtra != null ? relVer(info.ver_sw_release_wingtra) : info.ver_sw_release ? relVer(info.ver_sw_release) : info.ver_sw || null;
  L.device.camera = info.camera_serial_number || null;
  // a header count of images without camera_capture messages: a reduced log (the ULog that WingtraHub keeps next to the geotags has 9 topics)
  if (+info.camera_image_count > 0 && !att.length && !wtrig.length) L.notes.push("ulog-no-captures");
  fact(L, "fFormat", "ULog" + (pre ? " (Wingtra variant, 2-byte prefix)" : ""));
  fact(L, "fVehicle", L.device.model); fact(L, "fFirmware", L.device.fw); fact(L, "fCameraSerial", L.device.camera); fact(L, "fCameraCount", info.camera_image_count); fact(L, "fCameraTriggers", L._wt); delete L._wt;
  fact(L, "fDuration", tmin != null ? ((tmax - tmin) / 1e6).toFixed(0) + " s" : null);
  fact(L, "fTopics", Object.entries(topics).filter(x => x[1]).sort((a, b) => b[1] - a[1]).map(x => x[0] + ": " + x[1]).join(", "));
  if (use.length) {
    fact(L, "fGnssFix", Object.entries(countBy(use, g => fixName(g.fix))).map(([k, v]) => k + ": " + v).join(", "));
    fact(L, "fEph", median(use.map(g => g.eph)) != null ? median(use.map(g => g.eph)).toFixed(2) + " / " + median(use.map(g => g.epv)).toFixed(2) + " m" : null);
    fact(L, "fSats", median(use.map(g => g.sv)));
  }
  if (logs.length) fact(L, "fLogMessages", logs.length + ": " + [...new Set(logs.map(x => x.msg))].slice(0, 8).join(" | "));
  if (Object.keys(params).length) fact(L, "fParams", Object.keys(params).length);
  if (badMsg) { fact(L, "fBadMessages", badMsg); L.notes.push("corrupt-messages"); }
  L.gnss = { fix: countBy(use, g => fixName(g.fix)) };
}
// vehicle_status.nav_state (PX4 msg/VehicleStatus.msg); only AUTO_MISSION counts as the automatic mission
const PX4_NAV = { 0: "MANUAL", 1: "ALTCTL", 2: "POSCTL", 3: "AUTO_MISSION", 4: "AUTO_LOITER", 5: "AUTO_RTL", 6: "POSITION_SLOW", 10: "ACRO", 12: "DESCEND", 13: "TERMINATION", 14: "OFFBOARD", 15: "STAB", 17: "AUTO_TAKEOFF", 18: "AUTO_LAND", 19: "AUTO_FOLLOW_TARGET", 20: "AUTO_PRECLAND", 21: "ORBIT", 22: "AUTO_VTOL_TAKEOFF" };
const fixName = f => ({ 0: "none", 1: "none", 2: "2D", 3: "single", 4: "dgnss", 5: "float", 6: "fixed", 8: "fixed" }[f] || "fix " + f);
const relVer = v => typeof v === "number" ? [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255].join(".") : v;

/* ---------------------------------------------------------------- Septentrio SBF (also used for the stream inside eBee X .bb3) */
const SBF_MODE = { 0: "none", 1: "single", 2: "dgnss", 3: "fixed position", 4: "fixed", 5: "float", 6: "sbas", 7: "fixed", 8: "float", 10: "ppp" };
const SBF_NAMES = { 4007: "PVTGeodetic", 4006: "PVTCartesian", 5906: "PosCovGeodetic", 5908: "VelCovGeodetic", 5924: "ExtEvent", 4037: "ExtEventPVTCartesian", 4038: "ExtEventPVTGeodetic", 4027: "MeasEpoch", 4000: "MeasExtra", 4001: "DOP", 4109: "Meas3Ranges", 5902: "ReceiverSetup", 4002: "GPSNav", 4004: "GLONav", 4245: "GALNav", 4251: "BDSNav", 4013: "ChannelStatus", 4014: "ReceiverStatus", 4015: "Commands", 5914: "ReceiverTime", 5891: "GPSIon", 4020: "GEORawL1", 4082: "QualityInd", 4040: "BaseVectorGeod", 5938: "AttEuler" };
function sbfState() {
  const S = { blocks: {}, bad: 0, modes: {}, pvt: [], ev: [], evp: [], setup: null, tmin: null, tmax: null, hacc: [], nsv: [] };
  S.feed = (b, fin) => {
    const dv = dvOf(b); let i = 0;
    while (i + 8 <= b.length) {
      if (b[i] !== 0x24 || b[i + 1] !== 0x40) { i++; continue; }
      const crc = dv.getUint16(i + 2, true), id = dv.getUint16(i + 4, true), ln = dv.getUint16(i + 6, true);
      if (ln < 8 || ln % 4 || ln > 65532) { i++; continue; }
      if (i + ln > b.length) { if (fin) break; return i; }
      if (crc16(b, i + 4, i + ln) !== crc) { S.bad++; i++; continue; }
      const bid = id & 0x1fff; S.blocks[bid] = (S.blocks[bid] || 0) + 1;
      const tow = dv.getUint32(i + 8, true), wn = dv.getUint16(i + 12, true), okT = tow !== 4294967295 && wn !== 65535;
      if ((bid === 4007 || bid === 4038) && ln >= 88) {
        const mode = b[i + 14] & 15, lat = dv.getFloat64(i + 16, true), lon = dv.getFloat64(i + 24, true), h = dv.getFloat64(i + 32, true);
        const und = dv.getFloat32(i + 40, true), nsv = b[i + 74], ha = ln >= 94 ? dv.getUint16(i + 90, true) : 65535, va = ln >= 94 ? dv.getUint16(i + 92, true) : 65535;
        const valid = lat > -2e10 && Math.abs(lat) <= Math.PI;
        const t = okT ? gpsToUtc(wn, tow) : null;
        if (bid === 4007) {
          S.modes[SBF_MODE[mode] || "mode " + mode] = (S.modes[SBF_MODE[mode] || "mode " + mode] || 0) + 1;
          if (valid && okT) { S.pvt.push({ t, lat: lat * R2D, lon: lon * R2D, h, q: SBF_MODE[mode] }); if (S.tmin == null || t < S.tmin) S.tmin = t; if (S.tmax == null || t > S.tmax) S.tmax = t; if (ha !== 65535) S.hacc.push(ha / 100); if (nsv !== 255) S.nsv.push(nsv); S.und = und; }
        } else S.evp.push({ t, lat: valid ? lat * R2D : null, lon: valid ? lon * R2D : null, h: valid ? h : null, und, q: SBF_MODE[mode] || "mode " + mode, sH: ha !== 65535 ? ha / 100 : null, sV: va !== 65535 ? va / 100 : null });
      }
      if ((bid === 4027 || bid === 4109) && okT) { const t = gpsToUtc(wn, tow); if (S.mmin == null || t < S.mmin) S.mmin = t; if (S.mmax == null || t > S.mmax) S.mmax = t; }
      if (bid === 4006 && ln >= 40 && !S.xyz) { const x = dv.getFloat64(i + 16, true), y = dv.getFloat64(i + 24, true), z = dv.getFloat64(i + 32, true); if (Math.hypot(x, y, z) > 6e6) S.xyz = ecefToGeo(x, y, z); }
      if (bid === 5924 && ln >= 20 && okT) { const off = dv.getFloat32(i + 16, true); S.ev.push({ t: gpsToUtc(wn, tow) + (isFinite(off) ? off * 1000 : 0), src: b[i + 14] }); }
      if (bid === 5902 && !S.setup) S.setup = { marker: asc(b, i + 16, 60), serial: asc(b, i + 156, 20), name: asc(b, i + 176, 20), version: asc(b, i + 196, 20), antenna: asc(b, i + 236, 20), fw: ln >= 328 ? asc(b, i + 288, 40) : "", product: ln >= 368 ? asc(b, i + 328, 40) : "" };
      i += ln;
    }
    return fin ? b.length : i;
  };
  return S;
}
function sbfResult(S, L) {
  const st = S.setup || {};
  L.device.receiver = [st.product, st.name].filter(x => x && !/^unknown$/i.test(x)).join(" · ") || null; L.device.serial = st.serial || null; L.device.fw = st.fw || st.version || null;
  L.startMs = S.tmin != null ? S.tmin : S.mmin; L.endMs = S.tmax != null ? S.tmax : S.mmax; L.timeSource = "GPS time in SBF blocks − leap seconds";
  L.trajectory = S.pvt.filter((p, k) => k % 5 === 0 || k === S.pvt.length - 1);
  const raw = (S.blocks[4027] || 0) + (S.blocks[4109] || 0);
  L.raw = { format: "SBF", type: raw ? "raw observations (MeasEpoch)" : "no raw observations", epochs: raw, interval: S.pvt.length > 1 ? median(S.pvt.slice(1, 2000).map((p, k) => p.t - S.pvt[k].t)) / 1000 : S.mmin != null && raw > 1 ? Math.round((S.mmax - S.mmin) / (raw - 1)) / 1000 : null };
  const evAll = S.evp.length ? S.evp : S.ev.map(e => ({ t: e.t, q: "event" }));
  L.exposures = evAll.map((e, k) => ({ n: k + 1, t: e.t, lat: e.lat, lon: e.lon, h: e.h, sH: e.sH, sV: e.sV, q: e.q }));
  fact(L, "fFormat", "Septentrio SBF"); fact(L, "fReceiver", [st.product, st.name, st.serial].filter(x => x && !/^unknown$/i.test(x)).join(" · "));
  fact(L, "fFirmware", [st.version, st.fw].filter(x => x && !/^unknown|not applicable$/i.test(x)).join(" · ")); fact(L, "fMarker", st.marker && !/^SEPT$|^unknown$/i.test(st.marker) ? st.marker : null);
  fact(L, "fBlocks", Object.entries(S.blocks).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => (SBF_NAMES[k] || k) + ": " + v).join(", "));
  fact(L, "fPvtModes", Object.entries(S.modes).map(([k, v]) => k + ": " + v).join(", "));
  fact(L, "fHacc", median(S.hacc) != null ? median(S.hacc).toFixed(2) + " m" : null); fact(L, "fSats", median(S.nsv));
  fact(L, "fUndulation", S.und != null && isFinite(S.und) ? S.und.toFixed(2) + " m" : null);
  fact(L, "fRawObs", raw ? raw + " (" + (L.raw.interval != null ? L.raw.interval + " s" : "?") + ")" : 0);
  fact(L, "fEvents", S.ev.length); if (S.evp.length) fact(L, "fEventModes", Object.entries(countBy(S.evp, e => e.q)).map(([k, v]) => k + ": " + v).join(", ") + (median(S.evp.map(e => e.sH)) != null ? " · σH " + median(S.evp.map(e => e.sH)).toFixed(2) + " m, σV " + median(S.evp.map(e => e.sV)).toFixed(2) + " m" : ""));
  fact(L, "fCrcBad", S.bad);
  L.gnss = { modes: S.modes };
  if (/PostProcessing/i.test(st.name + st.serial + st.product)) L.notes.push("sbf-postprocessed");
  if (raw && !S.ev.length && (/base/i.test(L.name) || (S.pvt.length ? spread(S.pvt) < 5 : !!S.xyz))) { L.raw.role = "base"; L.base = { marker: st.marker, receiver: L.device.receiver, approx: S.xyz || (S.pvt.length ? S.pvt[S.pvt.length >> 1] : null), startMs: L.startMs, endMs: L.endMs, interval: L.raw.interval }; fact(L, "fRole", "base"); if (S.xyz) fact(L, "fApprox", S.xyz.lat.toFixed(7) + ", " + S.xyz.lon.toFixed(7) + ", " + S.xyz.h.toFixed(2) + " m"); }
  else if (raw) L.raw.role = "rover";
}
const spread = pts => { const la = pts.map(p => p.lat), lo = pts.map(p => p.lon); return Math.hypot((Math.max(...la) - Math.min(...la)) * 111320, (Math.max(...lo) - Math.min(...lo)) * 111320 * Math.cos(la[0] / R2D)); };
async function pSBF(src, L, h, o) { const S = sbfState(); await scan(src, S.feed, o); sbfResult(S, L); }

/* ---------------------------------------------------------------- senseFly eBee .bb3: frames 0xCD … 0xCE, escape 0xCF with C0→CF, C1→CD, C2→CE, C3→2B;
   frame type 0x82 is plain (channel 5/2 carries the GNSS receiver's SBF stream), other frame types are encrypted */
const BB3_ESC = { 0xc0: 0xcf, 0xc1: 0xcd, 0xc2: 0xce, 0xc3: 0x2b };
async function pBB3(src, L, h, o) {
  const S = sbfState(), types = {}, chans = {}; let sb = new Uint8Array(0), strs = new Set(), frames = 0;
  await scan(src, (b, fin) => {
    let i = 0;
    while (i < b.length) {
      const a = b.indexOf(0xcd, i); if (a < 0) return b.length;
      const e = b.indexOf(0xce, a + 1); if (e < 0) return fin ? b.length : a;
      let r = b.subarray(a + 1, e); i = e + 1; frames++;
      if (r.indexOf(0xcf) >= 0) { const out = new Uint8Array(r.length); let k = 0, n = 0; while (k < r.length) { if (r[k] === 0xcf && k + 1 < r.length) { out[n++] = BB3_ESC[r[k + 1]] != null ? BB3_ESC[r[k + 1]] : r[k + 1]; k += 2; } else out[n++] = r[k++]; } r = out.subarray(0, n); }
      if (!r.length) continue; types[r[0]] = (types[r[0]] || 0) + 1;
      if (r[0] === 0x82 && r.length > 11) {
        const ch = r[7] + "/" + r[8]; chans[ch] = (chans[ch] || 0) + 1;
        if (r[7] === 5 && r[8] === 2) { const n = r[9] | (r[10] << 8); sb = cat(sb, r.subarray(11, 11 + n)); if (sb.length > 65536) { const k = S.feed(sb, false); sb = sb.subarray(k); } }
        else if (r[7] === 20 && strs.size < 40) { const s = new TextDecoder("latin1").decode(r.subarray(9)).match(/[ -~]{4,}/g); if (s) s.forEach(x => strs.add(x.trim())); }
      }
    }
    return b.length;
  }, o);
  S.feed(sb, true);
  const plain = types[0x82] || 0, total = Object.values(types).reduce((a, b) => a + b, 0);
  L.device.make = "senseFly / AgEagle";
  const list = [...strs].filter(x => x.length >= 5 && /[A-Za-z]{2}|\d\.\d/.test(x) && !/[^\w .:#\-\/"]/.test(x));
  L.device.model = list.find(x => /ebee/i.test(x)) || null; L.device.serial = list.find(x => /^[A-Z]{2}-\d\d-\d{4,}/.test(x)) || null;
  if (S.pvt.length || S.ev.length) { sbfResult(S, L); L.facts.unshift(["fFormat", "senseFly .bb3 → Septentrio SBF (GNSS stream)"]); L.facts = L.facts.filter((f, k) => !(f[0] === "fFormat" && k > 0)); }
  else { fact(L, "fFormat", "senseFly .bb3"); L.encrypted = plain === 0; }
  fact(L, "fFrames", frames + " · plain " + plain + " · encrypted " + (total - plain));
  fact(L, "fDeviceStrings", list.slice(0, 12).join(" · "));
  if (total - plain > 0) L.notes.push("bb3-encrypted-part");
}

/* ---------------------------------------------------------------- senseFly geoinfo.txt, eMotion KML, Trimble JobXML */
async function pGeoinfo(src, L) {
  let cols = null, rev = null;
  await eachLine(src, l => {
    if (/^#Rev:/.test(l)) { const m = /geoinfo\/(\d+)/.exec(l); if (m) rev = m[1]; }
    if (/^#/.test(l) || !l.trim()) return; const p = l.split("\t");
    if (!cols) { cols = p.map(x => x.trim()); return; }
    const g = k => p[cols.indexOf(k)], name = g("fileName");
    L.exposures.push({ n: L.exposures.length + 1, name, lat: +g("latitude"), lon: +g("longitude"), h: +g("altitude_wgs84"), sH: +g("Accuracy XY"), sV: +g("Accuracy Z"), q: "log" });
  });
  L.device.make = "senseFly / AgEagle";
  const shots = new Set(L.exposures.map(e => e.name.replace(/_\d\.tif$/i, "").replace(/_THM\.JPG$/i, "")));
  fact(L, "fFormat", "senseFly geoinfo" + (rev ? " rev " + rev : "")); fact(L, "fImages", L.exposures.length); fact(L, "fShots", shots.size);
  fact(L, "fAccXY", median(L.exposures.map(e => e.sH)) != null ? median(L.exposures.map(e => e.sH)).toFixed(2) + " / " + median(L.exposures.map(e => e.sV)).toFixed(2) + " m" : null);
  fact(L, "fHeight", "ellipsoid (altitude_wgs84)");
  const hi = L.exposures.filter(e => e.sH <= 0.1).length; fact(L, "fShareRtk", Math.round(100 * hi / Math.max(1, L.exposures.length)) + " %");
  for (const e of L.exposures) e.q = e.sH <= 0.1 ? "ppk" : "single";
}
async function pKML(src, L) {
  const s = await text(src); const name = /<name>([^<]*)<\/name>/.exec(s);
  const ext = {}; for (const m of s.matchAll(/<Data name="(\w+)">[\s\S]*?<value>([^<]*)<\/value>/g)) ext[m[1]] = m[2];
  const tr = /<gx:Track>([\s\S]*?)<\/gx:Track>/.exec(s);
  if (tr) { const w = [...tr[1].matchAll(/<when>([^<]+)<\/when>/g)].map(m => Date.parse(m[1])), c = [...tr[1].matchAll(/<gx:coord>([^<]+)<\/gx:coord>/g)].map(m => m[1].trim().split(/\s+/).map(Number));
    for (let k = 0; k < Math.min(w.length, c.length); k++) { L.trajectory.push({ t: w[k], lat: c[k][1], lon: c[k][0], h: c[k][2] }); span(L, w[k]); } }
  // only placemarks named like image files are exposures; others (mission waypoints of a plan, for example) are counted
  let other = 0;
  for (const m of s.matchAll(/<Placemark>\s*<name>([^<]+)<\/name>[\s\S]*?<Point>[\s\S]*?<coordinates>([^<]+)<\/coordinates>/g)) { const c = m[2].trim().split(",").map(Number), nm = m[1].trim(); if (!/\.(jpe?g|tiff?|dng|png)$/i.test(nm)) { other++; continue; } L.exposures.push({ n: L.exposures.length + 1, name: nm, lat: c[1], lon: c[0], h: c[2], q: "log" }); }
  L.device.model = ext.droneType || null; L.device.camera = ext.camera || null; L.timeSource = tr ? "gx:Track <when> (UTC)" : null;
  fact(L, "fFormat", "KML" + (ext.droneType ? " (senseFly eMotion)" : "")); fact(L, "fName", name && name[1]); fact(L, "fVehicle", ext.droneType); fact(L, "fCamera", ext.camera); fact(L, "fStart", ext.startTime);
  fact(L, "fTrackPoints", L.trajectory.length); fact(L, "fImages", L.exposures.length); fact(L, "fPlacemarks", other || null);
  if (ext.droneType) { fact(L, "fHeight", "geoid (absolute, about 46 m below ellipsoid in CZ)"); L.notes.push("kml-geoid"); }
}
async function pJXL(src, L) {
  const s = await text(src);
  const g = (re, x) => { const m = re.exec(x || s); return m ? m[1] : null; };
  L.device.make = g(/product="([^"]+)"/); L.device.camera = g(/<CameraDesignRecord[\s\S]*?<Type>([^<]+)<\/Type>/);
  for (const m of s.matchAll(/<PointRecord ID="\d+" TimeStamp="([^"]+)">([\s\S]*?)<\/PointRecord>/g)) {
    const b = m[2]; L.exposures.push({ n: L.exposures.length + 1, name: g(/<Name>([^<]+)<\/Name>/, b), tLocal: m[1], lat: +g(/<Latitude>([^<]+)</, b), lon: +g(/<Longitude>([^<]+)</, b), h: +g(/<Height>([^<]+)</, b), q: (g(/<SurveyMethod>([^<]+)</, b) || "").toLowerCase() === "autonomous" ? "single" : "log" });
  }
  fact(L, "fFormat", "Trimble JobXML " + (g(/<JOBFile[^>]* version="([\d.]+)"/) || "")); fact(L, "fCamera", L.device.camera);
  const px = g(/<PixelSize>([^<]+)</), fl = g(/<NominalFocalLength>([^<]+)</); fact(L, "fCameraModel", px && fl ? "f " + (+fl * 1000).toFixed(2) + " mm · pixel " + (+px * 1e6).toFixed(2) + " µm · " + g(/<WidthPixels>(\d+)/) + "×" + g(/<HeightPixels>(\d+)/) : null);
  fact(L, "fImages", L.exposures.length); fact(L, "fSurvey", Object.entries(countBy([...s.matchAll(/<SurveyMethod>([^<]+)</g)], m => m[1])).map(([k, v]) => k + ": " + v).join(", "));
  fact(L, "fTimeStamps", L.exposures.length ? L.exposures[0].tLocal + " … " + L.exposures[L.exposures.length - 1].tLocal + " (time zone not stated)" : null);
}

/* ---------------------------------------------------------------- Wingtra: geotaglog, flight json, ini, geotags.csv */
async function pWGeotaglog(src, L) {
  const J = JSON.parse(await text(src)); L.device.make = "Wingtra"; L.device.camera = J.payload || null;
  const im = J.images || [], seen = new Set();
  for (const x of im) {
    const g = x.geotaggedImage || {}, r = g.geoRef || {}, c = r.coordinate || [];
    if (!x.imageName) continue;
    const shot = x.imageName.replace(/_\d\.tif$/i, ""); const first = !seen.has(shot); seen.add(shot);
    const t = g.imageTimeStamp ? g.imageTimeStamp : r.timestamp ? r.timestamp * 1000 : null;
    L.exposures.push({ n: L.exposures.length + 1, name: x.imageName, shot, first, t: t || null, lat: c[0] || null, lon: c[1] || null, h: c[2] || null, sH: r.hAccuracy, sV: r.vAccuracy, q: /^PPK/.test(r.coordSys || "") ? "ppk" : r.coordSys ? "single" : "none", roll: r.roll, pitch: r.pitch, yaw: r.yaw, coordSys: r.coordSys });
    span(L, t);
  }
  const tr = J.triggers || [], or = J.orienations || J.orientations || [];
  L.trajectory = or.map(o => ({ t: (o.time || (o.geoRef || {}).timestamp) * 1000, lat: (o.geoRef || {}).coordinate[0], lon: (o.geoRef || {}).coordinate[1], h: (o.geoRef || {}).coordinate[2] })).filter(p => p.lat);
  L.timeSource = "geotaglog timestamps (UTC, s)";
  fact(L, "fFormat", "Wingtra geotaglog v" + J.version); fact(L, "fProject", J.projectName); fact(L, "fCamera", J.payload);
  fact(L, "fImages", im.length + " (" + (J.imagesMultiplier || "").trim() + ")"); fact(L, "fMatched", "images " + J.numberOfMatchedImages + " · triggers " + J.numberOfMatchedTriggers + " · orientations " + J.numberOfMatchedOrientations);
  fact(L, "fCalib", J.numberOfCalibrationImages); fact(L, "fFailed", [J.numberOfFailedTriggerMatchingImages, J.numberOfFailedOrientationsMatchingImages, J.numberOfCorruptImages, J.numberOfBadSeqImages].join(" / "));
  fact(L, "fCoordSys", Object.entries(countBy(L.exposures, e => e.coordSys || "–")).map(([k, v]) => k + ": " + v).join(", "));
  fact(L, "fAccXY", median(L.exposures.map(e => e.sH)) + " / " + median(L.exposures.map(e => e.sV)) + " m");
  fact(L, "fCreated", J.logFileCreationTime); fact(L, "fWarnings", (J.warnings || []).length);
}
async function pWJson(src, L) {
  const J = JSON.parse(await text(src)); L.device.make = "Wingtra"; L.device.camera = J.model || null; L.device.serial = J.planeId || null; L.device.fw = J.swVersion || null;
  const st = countBy(J.files || [], f => f.captureState || "–");
  L.panels = { preflight: (J.files || []).filter(f => f.captureState === "preflight").map(f => f.name), postflight: (J.files || []).filter(f => f.captureState === "postflight").map(f => f.name) };
  fact(L, "fFormat", "Wingtra flight json"); fact(L, "fCamera", J.model); fact(L, "fPlane", J.planeId); fact(L, "fSoftware", J.swVersion + (J.hwVersion ? " · hw " + J.hwVersion : ""));
  fact(L, "fFiles", (J.files || []).length + " · " + Object.entries(st).map(([k, v]) => k + ": " + v).join(", ")); fact(L, "fFlights", Array.isArray(J.flights) ? J.flights.length : J.flights);
  fact(L, "fOpticalOffset", (J.cameraOpticalCenterOffset || []).join(", ") + " m"); fact(L, "fSignals", J.ppkSupportedSignals); fact(L, "fSigned", J.signature ? "SHA-256 " + J.signature.slice(0, 16) + "…" : null);
  for (const f of J.files || []) L.exposures.push({ n: L.exposures.length + 1, name: f.name, q: f.captureState });
  L.listOnly = true;
}
async function pWIni(src, L) {
  const s = await text(src), kv = {}; for (const l of s.split(/\r?\n/)) { const m = /^\s*([^=\[]+?)\s*=\s*(.*)$/.exec(l); if (m) kv[m[1]] = m[2]; }
  L.device.make = "Wingtra"; fact(L, "fFormat", "Wingtra PPK ini"); fact(L, "fBaseName", kv.name); fact(L, "fBaseFiles", kv.LastBaseFiles);
  fact(L, "fRtkFix", kv.EventsRTKFix != null ? kv.EventsRTKFix + " %" : null); fact(L, "fAccXY", kv.EventsMeanHAccuracy ? (+kv.EventsMeanHAccuracy).toFixed(3) + " / " + (+kv.EventsMeanVAccuracy).toFixed(3) + " m" : null);
  fact(L, "fCoordSys", kv.coordinateSystem); fact(L, "fReprocessed", kv.DatasetReprocessedCount);
  fact(L, "fAntennaOffset", kv.antennaOffset + " · E " + kv.antennaEast + " · N " + kv.antennaNorth + " · U " + kv.antennaUp + " · ARP→APC " + kv.arpToApcUp);
  if (kv.x && kv.y && kv.z) { const g = ecefToGeo(+kv.x, +kv.y, +kv.z); fact(L, "fBasePos", g.lat.toFixed(8) + ", " + g.lon.toFixed(8) + ", " + g.h.toFixed(3) + " m (ECEF " + kv.x + ", " + kv.y + ", " + kv.z + ")"); L.base = { marker: kv.name, approx: g, used: true, geodetic: kv.geodetic }; }
  L.rtkFix = kv.EventsRTKFix != null ? +kv.EventsRTKFix : null;
}
async function pWGeotags(src, L) {
  L.device.make = "Wingtra";
  await eachLine(src, l => { if (/^#/.test(l) || !l.trim()) return; const p = l.split(","); if (p.length < 9) return; L.exposures.push({ n: L.exposures.length + 1, name: p[0], lat: +p[1], lon: +p[2], h: +p[3], omega: +p[4], phi: +p[5], kappa: +p[6], sH: +p[7], sV: +p[8], q: +p[7] <= 0.1 ? "ppk" : "single" }); });
  fact(L, "fFormat", "Wingtra geotags.csv"); fact(L, "fImages", L.exposures.length); fact(L, "fAccXY", median(L.exposures.map(e => e.sH)) + " / " + median(L.exposures.map(e => e.sV)) + " m");
  fact(L, "fAngles", "ω " + rng(L.exposures.map(e => e.omega)) + "° · φ " + rng(L.exposures.map(e => e.phi)) + "°");
}
const rng = a => { const v = a.filter(isFinite); return v.length ? Math.min(...v).toFixed(1) + "…" + Math.max(...v).toFixed(1) : "–"; };

/* ---------------------------------------------------------------- MicaSense paramlog.dat: JSON schema, "\n==========\n", records <u64 ts><u32 key><u32 count> + count × size */
const PL_T = { double: ["getFloat64", 8], float: ["getFloat32", 4], int32_t: ["getInt32", 4], uint32_t: ["getUint32", 4], uint16_t: ["getUint16", 2], int16_t: ["getInt16", 2], uint8_t: ["getUint8", 1], int8_t: ["getInt8", 1], bool: ["getUint8", 1], uint64_t: ["u64", 8], int64_t: ["u64", 8] };
async function pParamlog(src, L, h, o) {
  const head = await slice(src, 0, 4 << 20), sep = find(head, "\n==========\n"); if (sep < 0) throw new Error("paramlog separator not found");
  const J = JSON.parse(new TextDecoder().decode(head.subarray(0, sep))), P = J.Parameters || [];
  const top = {}; for (const p of P) if (p.parent === 0) { const fl = {}; let off = 0; for (const c of P.filter(c => c.parent === p.key)) { fl[c.name] = { t: c.type, o: off, s: c.size }; off += c.size; } top[p.key] = { name: p.name, size: p.size, fl }; }
  const cnt = {}, ub = [], gs = [], cap = [], dls = new Set(); let bad = 0;
  const get = (dv, f, base) => { if (!f) return null; if (f.t === "string") { let s = ""; for (let k = 0; k < f.s; k++) { const c = dv.getUint8(base + f.o + k); if (!c) break; s += String.fromCharCode(c); } return s; } const x = PL_T[f.t]; if (!x) return null; return x[0] === "u64" ? dv.getUint32(base + f.o, true) + dv.getUint32(base + f.o + 4, true) * 4294967296 : dv[x[0]](base + f.o, true); };
  let first = true;
  await scan(src, (b, fin) => {
    let p = first ? sep + 12 : 0; first = false; const dv = dvOf(b);
    while (p + 16 <= b.length) {
      const key = dv.getUint32(p + 8, true), n = dv.getUint32(p + 12, true), T = top[key];
      if (!T || n < 1 || n > 4096) { bad++; p++; continue; }
      const e = p + 16 + T.size * n; if (e > b.length) { if (fin) break; return p; }
      const ts = dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296; cnt[T.name] = (cnt[T.name] || 0) + n;
      for (let k = 0; k < n; k++) {
        const base = p + 16 + k * T.size, g = nm => get(dv, T.fl[nm], base);
        if (T.name === "Ublox" && ub.length < 400000) ub.push({ ts, lat: g("lat") * R2D, lon: g("lon") * R2D, h: g("altEll"), hAcc: g("hAcc"), vAcc: g("vAcc"), tow: g("timeOfWeek"), wk: g("gpsWeek"), valid: g("valid") });
        else if (T.name === "GpsStatus") gs.push({ fix: g("fixType"), pAcc: g("pAcc"), sv: g("satsUsed") });
        else if (T.name === "CaptureLog") cap.push({ ts, id: g("CaptureId") });
        else if (T.name === "DlsSensorInfo" && dls.size < 8) dls.add(g("Serial"));
      }
      p = e;
    }
    return fin ? b.length : p;
  }, o);
  const v = ub.filter(u => u.valid && u.wk > 1000);
  L.device.make = "MicaSense"; L.timeSource = "u-blox GPS week + time of week − leap seconds; captures: record time (Unix ns)";
  for (const u of v) { u.t = gpsToUtc(u.wk, u.tow * 1000); span(L, u.t); }
  L.trajectory = v.map(u => ({ t: u.t, lat: u.lat, lon: u.lon, h: u.h, q: "single" }));
  // record time: ns since boot until the clock is set, then Unix ns
  const seenId = new Set();
  for (const c of cap) { if (seenId.has(c.id)) continue; seenId.add(c.id); const t = c.ts > 1e17 ? c.ts / 1e6 : null; let pos = null; if (t != null && v.length) pos = nearest(v, t); L.exposures.push({ n: L.exposures.length + 1, captureId: c.id, t, lat: pos && pos.lat, lon: pos && pos.lon, h: pos && pos.h, sH: pos && pos.hAcc, sV: pos && pos.vAcc, q: pos ? "single" : "none" }); }
  fact(L, "fFormat", "MicaSense paramlog"); fact(L, "fFlightId", J.flight_id);
  fact(L, "fRecords", Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, x]) => k + ": " + x).join(", "));
  fact(L, "fGnssFix", Object.entries(countBy(gs, g => "fixType " + g.fix)).map(([k, x]) => k + ": " + x).join(", "));
  fact(L, "fHacc", median(v.map(u => u.hAcc)) != null ? median(v.map(u => u.hAcc)).toFixed(2) + " / " + median(v.map(u => u.vAcc)).toFixed(2) + " m" : null);
  fact(L, "fSats", median(gs.map(g => g.sv))); fact(L, "fCaptures", L.exposures.length); fact(L, "fDls", [...dls].filter(Boolean).join(", ")); fact(L, "fResync", bad);
}
function nearest(arr, t) { let lo = 0, hi = arr.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m; else hi = m; } return Math.abs(arr[lo].t - t) <= Math.abs(arr[hi].t - t) ? arr[lo] : arr[hi]; }

/* ---------------------------------------------------------------- MicaSense gpslog.dat: "MICA" frames (14-byte header, 2-byte trailer) carrying UBX-framed packets;
   class 0x67/0xFA tunnels the u-blox receiver's own UBX messages (NAV-SOL, NAV-POSLLH, NAV-TIMEUTC, NAV-SVINFO) */
function ubxScan(b, fin, cb) {
  let j = 0;
  while (j + 8 <= b.length) {
    if (b[j] !== 0xb5 || b[j + 1] !== 0x62) { j++; continue; }
    const ln = b[j + 4] | (b[j + 5] << 8); if (j + 8 + ln > b.length) { if (fin) break; return j; }
    let A = 0, B = 0; for (let k = j + 2; k < j + 6 + ln; k++) { A = (A + b[k]) & 255; B = (B + A) & 255; }
    if (A !== b[j + 6 + ln] || B !== b[j + 7 + ln]) { j += 2; continue; }
    cb(b[j + 2], b[j + 3], b.subarray(j + 6, j + 6 + ln)); j += 8 + ln;
  }
  return fin ? b.length : j;
}
async function pGpslog(src, L, h, o) {
  let outer = new Uint8Array(0), inner = new Uint8Array(0); const sol = [], llh = [], tu = [], dev = new Set(), oc = {};
  const innerCb = (c, i, p) => { const dv = dvOf(p);
    if (c === 1 && i === 6 && p.length >= 52) sol.push({ itow: dv.getUint32(0, true), wk: dv.getInt16(8, true), fix: p[10], ok: p[11] & 1, pAcc: dv.getUint32(24, true) / 100, sv: p[47] });
    else if (c === 1 && i === 2 && p.length >= 28) llh.push({ itow: dv.getUint32(0, true), lon: dv.getInt32(4, true) * 1e-7, lat: dv.getInt32(8, true) * 1e-7, h: dv.getInt32(12, true) / 1e3, hmsl: dv.getInt32(16, true) / 1e3, hAcc: dv.getUint32(20, true) / 1e3, vAcc: dv.getUint32(24, true) / 1e3 });
    else if (c === 1 && i === 0x21 && p.length >= 20) tu.push({ itow: dv.getUint32(0, true), y: dv.getUint16(12, true), valid: p[19] }); };
  const outerCb = (c, i, p) => { const k = c.toString(16) + "/" + i.toString(16); oc[k] = (oc[k] || 0) + 1;
    if (c === 0x67 && i === 0xfa && p.length > 2) { inner = cat(inner, p.subarray(2)); if (inner.length > 16384) { const k2 = ubxScan(inner, false, innerCb); inner = inner.subarray(k2); } }
    else if (c === 0x6e && i === 0xff && dev.size < 8) { const s = new TextDecoder("latin1").decode(p).match(/[ -~]{3,}/g); if (s) s.forEach(x => dev.add(x)); } };
  await scan(src, (b, fin) => {
    let i = 0;
    while (i < b.length) {
      const a = find(b, "MICA", i); if (a < 0) return fin ? b.length : Math.max(i, b.length - 3);
      const e = find(b, "MICA", a + 4); if (e < 0 && !fin) return a;
      const end = e < 0 ? b.length : e; if (end - a > 16) outer = cat(outer, b.subarray(a + 14, end - 2));
      if (outer.length > 16384) { const k = ubxScan(outer, false, outerCb); outer = outer.subarray(k); }
      i = end; if (e < 0) break;
    }
    return b.length;
  }, o);
  ubxScan(outer, true, outerCb); ubxScan(inner, true, innerCb);
  const wk = median(sol.map(s => s.wk)); const byTow = new Map(sol.map(s => [s.itow, s]));
  for (const p of llh) { const s = byTow.get(p.itow); if (wk && p.hAcc < 50) { const t = gpsToUtc(wk, p.itow); L.trajectory.push({ t, lat: p.lat, lon: p.lon, h: p.h, q: s && s.fix === 3 ? "single" : "none" }); span(L, t); } }
  L.device.make = "MicaSense"; const d = [...dev]; L.device.serial = d.find(x => /^RX\d\d-|^[A-Z]{2}\d\d-\d+/.test(x)) || null; L.device.fw = d.find(x => /^v\d/.test(x)) || null;
  L.timeSource = "u-blox NAV-POSLLH iTOW + NAV-SOL week − leap seconds";
  fact(L, "fFormat", "MicaSense gpslog (MICA frames → u-blox UBX)"); fact(L, "fCamera", d.slice(0, 4).join(" · "));
  fact(L, "fGnssFix", Object.entries(countBy(sol, s => "gpsFix " + s.fix)).map(([k, x]) => k + ": " + x).join(", "));
  fact(L, "fHacc", median(llh.map(p => p.hAcc)) != null ? median(llh.filter(p => p.hAcc < 50).map(p => p.hAcc)).toFixed(2) + " / " + median(llh.filter(p => p.hAcc < 50).map(p => p.vAcc)).toFixed(2) + " m" : null);
  fact(L, "fSats", median(sol.map(s => s.sv))); fact(L, "fUndulation", median(llh.map(p => p.h - p.hmsl)) != null ? median(llh.filter(p => p.hAcc < 50).map(p => p.h - p.hmsl)).toFixed(2) + " m" : null);
  fact(L, "fEpochs", llh.length + (sol.length > 1 ? " (" + (median(sol.slice(1, 2000).map((s, k) => s.itow - sol[k].itow)) / 1000) + " s)" : ""));
  fact(L, "fPackets", Object.entries(oc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, x]) => k + ": " + x).join(", "));
}

/* ---------------------------------------------------------------- u-blox UBX (raw receiver log) and NovAtel OEM binary (recognised, counted) */
const UBX_NAMES = { "1/2": "NAV-POSLLH", "1/3": "NAV-STATUS", "1/6": "NAV-SOL", "1/7": "NAV-PVT", "1/12": "NAV-VELNED", "1/21": "NAV-TIMEUTC", "1/30": "NAV-SVINFO", "1/35": "NAV-SAT", "2/10": "RXM-RAW", "2/11": "RXM-SFRB", "2/13": "RXM-SFRBX", "2/15": "RXM-RAWX", "13/3": "TIM-TM2", "a/9": "MON-HW", "a/4": "MON-VER" };
async function pUBX(src, L, h, o) {
  const cnt = {}, pts = [], fix = {}; let raw = 0, wk = null, rt0 = null, rt1 = null; const ev = [], ver = [];
  await scan(src, (b, fin) => ubxScan(b, fin, (c, i, p) => { const k = c.toString(16) + "/" + i.toString(16); cnt[k] = (cnt[k] || 0) + 1; const dv = dvOf(p);
    if (c === 1 && i === 7 && p.length >= 84) { const valid = p[11], ft = p[20], fl = p[21], carr = fl >> 6; fix[ft === 3 ? (carr === 2 ? "fixed" : carr === 1 ? "float" : "single") : "fix " + ft] = (fix[ft === 3 ? (carr === 2 ? "fixed" : carr === 1 ? "float" : "single") : "fix " + ft] || 0) + 1;
      if ((valid & 3) === 3 && ft >= 2) { const t = Date.UTC(dv.getUint16(4, true), p[6] - 1, p[7], p[8], p[9], p[10]) + dv.getInt32(16, true) / 1e6; pts.push({ t, lon: dv.getInt32(24, true) * 1e-7, lat: dv.getInt32(28, true) * 1e-7, h: dv.getInt32(32, true) / 1e3, sH: dv.getUint32(40, true) / 1e3, q: carr === 2 ? "fixed" : carr === 1 ? "float" : "single" }); } }
    else if (c === 1 && i === 6 && p.length >= 52) { const f = p[10]; fix["gpsFix " + f] = (fix["gpsFix " + f] || 0) + 1; if (wk == null && p[11] & 4) wk = dv.getInt16(8, true); }
    else if (c === 2 && (i === 0x10 || i === 0x15) && p.length >= 8) { raw++; const w = i === 0x10 ? dv.getInt16(4, true) : dv.getUint16(8, true), tow = i === 0x10 ? dv.getInt32(0, true) : dv.getFloat64(0, true) * 1000;
      if (w > 1000 && w < 5000 && isFinite(tow)) { const t = gpsToUtc(w, tow); if (rt0 == null || t < rt0) rt0 = t; if (rt1 == null || t > rt1) rt1 = t; if (wk == null) wk = w; } }
    else if (c === 0x0d && i === 3 && p.length >= 28) ev.push(p);
    else if (c === 0x0a && i === 4 && !ver.length) ver.push(asc(p, 0, 30), asc(p, 30, 10)); }), o);
  L.trajectory = pts; for (const q of pts) span(L, q.t); L.timeSource = pts.length ? "NAV-PVT UTC" : null;
  L.raw = { format: "UBX", type: raw ? "raw observations (RXM-RAW/RAWX)" : "no raw observations", epochs: raw };
  L.device.make = "u-blox"; L.device.fw = ver.filter(Boolean).join(" · ") || null;
  fact(L, "fFormat", "u-blox UBX"); fact(L, "fFirmware", L.device.fw); fact(L, "fPackets", Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => (UBX_NAMES[k] || k) + ": " + v).join(", "));
  fact(L, "fGnssFix", Object.entries(fix).map(([k, v]) => k + ": " + v).join(", ")); fact(L, "fRawObs", raw); fact(L, "fEvents", ev.length || null);
  if (!pts.length && rt0 != null) { L.startMs = rt0; L.endMs = rt1; L.timeSource = "RXM raw measurement time (GPS − leap seconds)"; }
  if (raw > 1 && rt0 != null) { L.raw.interval = Math.round((rt1 - rt0) / (raw - 1)) / 1000; fact(L, "fInterval", L.raw.interval + " s"); }
}
/* NovAtel OEM binary: sync AA 44 12, header length at +3, message id +4, body length +8, GPS week +14, ms of week +16, CRC32 after the body.
   novScan(b, fin, cb) calls cb(id, b, bodyStart, bodyLength, week, towMs) for each whole message and returns the bytes consumed. */
const NOV_NAMES = { 7: "GPSEPHEM", 8: "IONUTC", 41: "RAWEPHEM", 42: "BESTPOS", 43: "RANGE", 140: "RANGECMP", 241: "BESTXYZ", 723: "GLOEPHEMERIS", 2050: "RANGECMP4" };
const NOV_POS = { 0: "none", 1: "fixed position", 16: "single", 17: "dgps", 18: "sbas", 19: "propagated", 32: "float", 33: "float", 34: "float", 48: "fixed", 49: "fixed", 50: "fixed", 52: "single", 53: "single", 54: "dgps", 55: "float", 56: "fixed", 68: "float", 69: "ppp" };
function novScan(b, fin, cb) {
  let i = 0; const dv = dvOf(b);
  while (i + 28 <= b.length) { if (b[i] !== 0xaa || b[i + 1] !== 0x44 || b[i + 2] !== 0x12) { i++; continue; } const hl = b[i + 3], id = dv.getUint16(i + 4, true), ml = dv.getUint16(i + 8, true); if (i + hl + ml + 4 > b.length) { if (fin) break; return i; } cb(id, b, i + hl, ml, dv.getUint16(i + 14, true), dv.getUint32(i + 16, true)); i += hl + ml + 4; }
  return fin ? b.length : i;
}
/* collects message counts, BESTPOS positions and the time of raw observations */
function novState() {
  const S = { cnt: {}, n: 0, pos: [], wk: null, raw: 0, r0: null, r1: null };
  S.cb = (id, b, a, ml, wk, ms) => { S.cnt[id] = (S.cnt[id] || 0) + 1; S.n++; if (wk > 1000 && wk < 5000 && S.wk == null) S.wk = wk;
    if (id === 43 || id === 140 || id === 2050) { S.raw++; const t = gpsToUtc(wk, ms); if (S.r0 == null) S.r0 = t; S.r1 = t; }
    else if (id === 42 && ml >= 66) { const dv = dvOf(b), pt = dv.getUint32(a + 4, true), lat = dv.getFloat64(a + 8, true), lon = dv.getFloat64(a + 16, true);
      if (pt && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) S.pos.push({ t: gpsToUtc(wk, ms), lat, lon, h: dv.getFloat64(a + 24, true) + dv.getFloat32(a + 32, true), sH: Math.hypot(dv.getFloat32(a + 40, true), dv.getFloat32(a + 44, true)), sV: dv.getFloat32(a + 48, true), q: NOV_POS[pt] || "type " + pt, sv: b[a + 65] }); } };
  return S;
}
function novFacts(S, L) {
  fact(L, "fMessages", S.n); fact(L, "fMsgTypes", Object.entries(S.cnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => (NOV_NAMES[k] || k) + ": " + v).join(", "));
  if (S.pos.length) { fact(L, "fPvtModes", Object.entries(countBy(S.pos, p => p.q)).map(([k, v]) => k + ": " + v).join(", ")); fact(L, "fHacc", median(S.pos.map(p => p.sH)).toFixed(2) + " m"); fact(L, "fSats", median(S.pos.map(p => p.sv))); }
  if (S.raw) { const iv = S.raw > 1 ? Math.round((S.r1 - S.r0) / (S.raw - 1)) / 1000 : null; L.raw = { format: "NovAtel OEM", type: "raw observations (" + [43, 140, 2050].filter(k => S.cnt[k]).map(k => NOV_NAMES[k]).join(", ") + ")", epochs: S.raw, interval: iv }; fact(L, "fRawObs", S.raw + (iv != null ? " (" + iv + " s)" : "")); }
}
async function pNovatel(src, L, h, o) {
  const S = novState(); await scan(src, (b, fin) => novScan(b, fin, S.cb), o);
  L.device.make = "NovAtel"; if (!S.raw) L.raw = { format: "NovAtel OEM", type: "messages", epochs: 0 };
  fact(L, "fFormat", "NovAtel OEM binary"); novFacts(S, L);
  L.trajectory = thin(S.pos); for (const p of S.pos) span(L, p.t); if (S.pos.length) L.timeSource = "GPS week + ms of week in message headers − leap seconds";
  else if (S.r0 != null) { L.startMs = S.r0; L.endMs = S.r1; L.timeSource = "raw observation time (GPS − leap seconds)"; }
}

/* ---------------------------------------------------------------- Wingtra LiDAR recording WINGTRA-<date>-<time>-NNN.data (firmware 5.4).
   Part 001 starts with a 1 KiB header: u32 0, u32 1024, then text fields: payload name (+8), firmware (+24), GNSS receiver (+40), scanner (+104).
   Then records <u32 stream><u32 length><payload>: stream 1 IMU (f64 GPS time of week first, 32 B, 200 Hz), stream 2 NovAtel OEM binary,
   stream 4 Hesai scanner packets, stream 0 empty markers. The first record of a stream can be its definition ("$IMURAW", "$HSAI").
   The recording is cut into parts of 256 MiB regardless of records: the next part begins with the rest of the cut record. */
const LIDAR_PART = /(^|\/)WINGTRA-\d{4}(?:-\d\d){5}-(\d{3})\.data$/i;
/* a plausible chain of records from offset a: zero bytes also read as empty records, so the chain must hold mostly non-empty ones */
function lidarChain(b, a, need) { let i = a, full = 0, empty = 0; const dv = dvOf(b); while (i + 8 <= b.length && full < need) { const st = dv.getUint32(i, true), ln = dv.getUint32(i + 4, true); if (st > 15 || ln > 65536 || (i === a && !ln)) return false; if (ln) { full++; empty = 0; } else if (++empty > 8) return false; i += 8 + ln; } return full >= need || (i + 8 > b.length && full >= 3); }
async function pLidarData(src, L, h, o) {
  const head = h.length >= 168 && dvOf(h).getUint32(0, true) === 0 && dvOf(h).getUint32(4, true) === 1024 && startsWith(h.subarray(8), "WINGTRA-");
  const pm = LIDAR_PART.exec(L.name || ""), part = pm ? +pm[2] : head ? 1 : null;
  let lead = head ? 1024 : null;
  if (!head) { const b0 = await slice(src, 0, 1 << 18); for (let a = 0; a < Math.min(b0.length, 1 << 16); a++) if (lidarChain(b0, a, 50)) { lead = a; break; } }
  L.device.make = "Wingtra"; L.device.model = "WingtraOne LiDAR"; fact(L, "fFormat", "Wingtra LiDAR recording (.data)");
  if (head) { L.device.serial = asc(h, 8, 16) || null; L.device.fw = asc(h, 24, 16) || null; L.device.receiver = asc(h, 40, 64) || null;
    fact(L, "fFirmware", L.device.fw); fact(L, "fReceiver", L.device.receiver); fact(L, "fScanner", asc(h, 104, 32)); fact(L, "fSerial", L.device.serial); }
  if (lead == null) { L.notes.push("lidar-data-unreadable"); L.lidar = { file: (L.name || "").split("/").pop(), part, lead: null, need: null }; return; }
  const cnt = {}, bytes = {}, defs = {}, N = novState(), imu = []; let nov = new Uint8Array(0), skip = lead, stop = null, tail = 0, need = null, pos = 0;
  const rec = (st, p) => { cnt[st] = (cnt[st] || 0) + 1; bytes[st] = (bytes[st] || 0) + p.length;
    if (cnt[st] === 1 && p[0] === 0x24) defs[st] = new TextDecoder("latin1").decode(p.subarray(0, 200)).match(/[A-Z][\w-]{2,}/g).slice(0, 2).join(" · ");
    else if (st === 1 && p.length >= 8) { const t = dvOf(p).getFloat64(0, true); if (t >= 0 && t < 604800) imu.push(t); }
    else if (st === 2) { nov = cat(nov, p); if (nov.length > 1 << 16) nov = nov.subarray(novScan(nov, false, N.cb)); } };
  await scan(src, (b, fin) => {
    let i = 0; if (skip) { i = Math.min(skip, b.length); skip -= i; }
    if (stop != null) return b.length;
    const dv = dvOf(b);
    while (i + 8 <= b.length) { const st = dv.getUint32(i, true), ln = dv.getUint32(i + 4, true); if (st > 15 || ln > 65536) { stop = pos + i; return b.length; } if (i + 8 + ln > b.length) { if (fin) need = 8 + ln - (b.length - i); break; } rec(st, b.subarray(i + 8, i + 8 + ln)); i += 8 + ln; }
    if (fin) tail = b.length - i; pos += i; return i;
  }, o);
  novScan(nov, true, N.cb);
  // GPS week: from the NovAtel headers, else from the UTC date and time in the file name
  const nm = /(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)/.exec(L.name || ""), wk = N.wk != null ? N.wk : nm ? Math.floor((Date.UTC(+nm[1], nm[2] - 1, +nm[3], +nm[4], +nm[5], +nm[6]) + 18000 - GPS0) / WEEK) : null;
  if (imu.length && wk != null) { span(L, gpsToUtc(wk, imu[0] * 1000)); span(L, gpsToUtc(wk, imu[imu.length - 1] * 1000)); L.timeSource = "IMU GPS time of week + GPS week " + (N.wk != null ? "(NovAtel)" : "(file name)") + " − leap seconds"; }
  else if (N.pos.length) { for (const p of N.pos) span(L, p.t); L.timeSource = "NovAtel BESTPOS (GPS − leap seconds)"; }
  L.trajectory = thin(N.pos.map(p => ({ t: p.t, lat: p.lat, lon: p.lon, h: p.h, q: p.q })));
  const dur = imu.length > 1 ? imu[imu.length - 1] - imu[0] : null, rate = n => dur && n / dur >= 1 ? " (" + Math.round(n / dur) + "/s)" : "", DEF = { 1: "IMU", 2: "NovAtel", 4: "scanner" };
  fact(L, "fPart", (part != null ? String(part).padStart(3, "0") : "?") + (head ? " · header 1 KiB" : lead ? " · begins with " + lead + " B of a record cut at the end of the previous part" : "") + (need != null ? " · last record continues in the next part (" + need + " B)" : tail ? " · " + tail + " B after the last whole record" : ""));
  fact(L, "fStreams", Object.keys(cnt).sort((a, b) => a - b).map(k => k + (defs[k] ? " " + defs[k] : DEF[k] ? " " + DEF[k] : "") + ": " + cnt[k] + rate(cnt[k]) + (bytes[k] ? ", " + (bytes[k] >= 1048576 ? (bytes[k] / 1048576).toFixed(1) + " MiB" : Math.ceil(bytes[k] / 1024) + " KiB") : "")).join(" · "));
  fact(L, "fDuration", dur != null ? Math.round(dur) + " s" : null);
  if (N.n) novFacts(N, L); if (L.raw) L.raw.role = "rover";
  if (N.pos.length >= 10) { const a = N.pos[0], d = Math.max(...N.pos.map(r => Math.hypot((r.lat - a.lat) * 111320, (r.lon - a.lon) * 111320 * Math.cos(a.lat / R2D)))); fact(L, "fMoved", d.toFixed(1) + " m"); if (d < 50) L.notes.push("lidar-static"); }
  if (stop != null) { L.notes.push("lidar-data-broken"); fact(L, "fBrokenAt", stop); }
  L.lidar = { file: (L.name || "").split("/").pop(), part, lead: head ? 0 : lead, need };
}

/* ---------------------------------------------------------------- Parrot Sequoia TLMB: header key/values, then u32-length zlib blocks;
   inside: tag 0 section name, tag 2 variable list, tag 3 sample <u32 id><u32 s><u32 ns><u32 size> */
async function gunzip(u8) {
  if (typeof DecompressionStream !== "undefined") { const ds = new DecompressionStream("gzip"); const r = new Blob([u8]).stream().pipeThrough(ds); return new Uint8Array(await new Response(r).arrayBuffer()); }
  if (typeof require === "function") return new Uint8Array(require("zlib").gunzipSync(u8));
  throw new Error("no gunzip available");
}
async function inflate(u8) {
  if (typeof DecompressionStream !== "undefined") { const ds = new DecompressionStream("deflate"); const r = new Blob([u8]).stream().pipeThrough(ds); return new Uint8Array(await new Response(r).arrayBuffer()); }
  if (typeof require === "function") return new Uint8Array(require("zlib").inflateSync(u8));
  throw new Error("no inflate available");
}
const TL_T = { 1: ["getUint8", 1], 2: ["getInt8", 1], 3: ["getUint16", 2], 4: ["getInt16", 2], 5: ["getUint32", 4], 6: ["getInt32", 4], 9: ["getFloat32", 4], 10: ["getFloat64", 8] };
async function pTLMB(src, L, h, o) {
  const b0 = await slice(src, 0, 8192), dv0 = dvOf(b0), nh = dv0.getUint32(5, true); let p = 9; const hdr = {};
  for (let k = 0; k < nh && p < b0.length; k++) { const kl = b0[p]; const key = asc(b0, p + 1, kl); p += 1 + kl; const vl = b0[p]; hdr[key] = asc(b0, p + 1, vl); p += 1 + vl; }
  const names = {}, vars = {}, cnt = {}, ext = [], irr = []; let first = null, last = null, carry = new Uint8Array(0), pos = p, badBlocks = 0;
  const total = sizeOf(src);
  while (pos + 4 <= total) {
    const lb = await slice(src, pos, pos + 4), ln = dvOf(lb).getUint32(0, true); if (ln === 0xffffffff || pos + 4 + ln > total) break;
    let raw; try { raw = await inflate(await slice(src, pos + 4, pos + 4 + ln)); } catch (e) { raw = null; }
    pos += 4 + ln; if (o && o.progress) o.progress(pos / total);
    if (!raw) { badBlocks++; carry = new Uint8Array(0); continue; } // a damaged block is skipped, records resume in the next one
    const R = cat(carry, raw), dv = dvOf(R); let q = 0;
    while (q < R.length) {
      const t = R[q];
      if (t === 0) { if (q + 6 > R.length) break; const nl = R[q + 5]; if (q + 6 + nl > R.length) break; names[dv.getUint32(q + 1, true)] = asc(R, q + 6, nl); q += 6 + nl; }
      else if (t === 2) { if (q + 13 > R.length) break; const id = dv.getUint32(q + 1, true), nv = dv.getUint32(q + 9, true); let r = q + 13; const vs = []; let ok = true; let off = 0;
        for (let k = 0; k < nv; k++) { if (r + 24 > R.length) { ok = false; break; } const ds = dv.getUint32(r, true), ty = dv.getUint32(r + 8, true), sz = dv.getUint32(r + 12, true), c = dv.getUint32(r + 16, true); if (r + ds > R.length) { ok = false; break; } vs.push({ name: asc(R, r + 24, ds - 24), ty, sz, c, off }); off += sz * c; r += ds; }
        if (!ok) break; vars[id] = vs; q = r; }
      else if (t === 3) { if (q + 17 > R.length) break; const id = dv.getUint32(q + 1, true), s = dv.getUint32(q + 5, true), ns = dv.getUint32(q + 9, true), sz = dv.getUint32(q + 13, true); if (q + 17 + sz > R.length) break;
        cnt[id] = (cnt[id] || 0) + 1; const tt = s + ns * 1e-9; if (first == null) first = tt; last = tt; const nm = names[id];
        if (nm === "ExternalGPS" || nm === "Irradiance") { const o2 = {}; for (const v of vars[id] || []) { const T = TL_T[v.ty]; if (T && T[1] === v.sz && v.c === 1) o2[v.name] = dv[T[0]](q + 17 + v.off, true); else if (v.sz === 8 && v.c === 1 && (v.ty === 9 || v.ty === 10)) o2[v.name] = dv.getFloat64(q + 17 + v.off, true); } o2._t = tt; (nm === "ExternalGPS" ? ext : irr).push(o2); }
        q += 17 + sz; }
      else { q = R.length; L.notes.push("tlmb-unknown-tag"); }
    }
    carry = R.subarray(q);
  }
  if (badBlocks) { fact(L, "fBadMessages", badBlocks); L.notes.push("corrupt-messages"); }
  L.device.make = "Parrot"; L.device.model = "Sequoia"; L.device.serial = hdr["ro.serialno"] || null; L.device.fw = hdr["ro.parrot.build.version"] || null;
  L.exposures = ext.map((e, k) => ({ n: k, boot: e._t, lat: e.latitude, lon: e.longitude, h: e.altitude, sH: e.h_accuracy, sV: e.v_accuracy, q: "single" }));
  L.trajectory = L.exposures.map(e => ({ lat: e.lat, lon: e.lon, h: e.h }));
  fact(L, "fFormat", "Parrot TLMB (" + (hdr.compressionMethod || "") + ")"); fact(L, "fSerial", L.device.serial); fact(L, "fFirmware", L.device.fw);
  fact(L, "fLogDate", hdr.date ? hdr.date + " (camera clock)" : null); L.session = hdr.date || null; fact(L, "fBootSpan", first != null ? first.toFixed(1) + "–" + last.toFixed(1) + " s" : null);
  fact(L, "fSections", Object.entries(cnt).map(([k, v]) => (names[k] || k) + ": " + v).join(", "));
  fact(L, "fCaptures", ext.length); fact(L, "fHacc", median(ext.map(e => e.h_accuracy)) != null ? median(ext.map(e => e.h_accuracy)).toFixed(2) + " / " + median(ext.map(e => e.v_accuracy)).toFixed(2) + " m" : null);
  fact(L, "fSunshine", irr.length ? irr.length + " samples · gains " + [...new Set(irr.map(x => x.green_gain))].join(",") + " · integration " + [...new Set(irr.map(x => x.green_inttime))].join(",") + " ms" : null);
  L.timeSource = "time since camera boot (no UTC in TLMB)";
}

/* ---------------------------------------------------------------- Wingtra LiDAR service.log and ppk.pcmp */
async function pService(src, L) {
  const kv = {}, rmc = [], temps = [], recs = [], nav = [], led = {}, model = new Map(), lat = [], adj = [], freq = [];
  let clockJump = null, prevT = null, first = null, last = null, scanFail = 0, hist = [], calib = null; const offs = [];
  await eachLine(src, l => {
    const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)\.(\d+) (\w+): (.*)$/.exec(l); if (!m) return;
    const t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + parseFloat("0." + m[7]) * 1000, msg = m[9].trim();
    if (first == null) first = t; last = t; if (prevT != null && t - prevT > 86400000 && !clockJump) clockJump = { from: prevT, to: t }; prevT = t;
    let x;
    if ((x = /^Firmware version: (.*)/.exec(msg))) kv.fw = x[1]; else if ((x = /^Receiver model: (.*)/.exec(msg))) kv.rx = x[1]; else if ((x = /^Scanner model: (.*)/.exec(msg))) kv.sc = x[1];
    else if ((x = /^(WINGTRA-[0-9a-f]+)$/.exec(msg))) kv.id = x[1]; else if ((x = /^Lidar (linear|angular) offset = \((.*)\)/.exec(msg))) kv[x[1]] = x[2];
    else if ((x = /^WINGTRA orientation = \((.*)\)/.exec(msg))) kv.orient = x[1];
    else if ((x = /^Recording to (.*)/.exec(msg))) { kv.rec = x[1]; recs.push({ file: x[1], t }); }
    else if ((x = /^(\S+\.data) checksum is (\d+)/.exec(msg))) { const r = recs.find(r => r.file === x[1]); if (r) r.sum = x[2]; else recs.push({ file: x[1], sum: x[2] }); }
    else if ((x = /^LiDAR scanner temperature is ([\d.]+)/.exec(msg))) temps.push(+x[1]); else if (/^Time is good/.test(msg)) kv.timeGood = t;
    else if ((x = /^Kernel receiver model = (.*)/.exec(msg))) kv.rxModel = x[1];
    else if ((x = /^Slave antenna offset = \((.*)\)/.exec(msg))) kv.ant2 = x[1];
    else if ((x = /^(Max|Min) field of view is (-?[\d.]+)/.exec(msg))) kv["fov" + x[1]] = +x[2];
    else if ((x = /^Read error model: (\w+) = (\S+)/.exec(msg))) model.set(x[1], x[2]);
    else if ((x = /^IMU nSec = \S+, GPS nSec = \S+, latency = (-?\d+)/.exec(msg))) { if (kv.timeGood != null) lat.push(+x[1] / 1e6); }   // ns → ms, after the clock is set from GNSS
    else if ((x = /^Adjusting clock by (-?[\d.]+) microsec/.exec(msg))) adj.push(+x[1]);
    else if ((x = /^Adjusting frequency by (-?[\d.]+) ppm/.exec(msg))) freq.push(+x[1]);
    else if ((x = /^Adjusting system time by (-?\d+) seconds/.exec(msg))) kv.step = +x[1];
    else if ((x = /^NavSolver current state: (.*)/.exec(msg))) nav.push(x[1]);
    else if ((x = /^(\w+) LED state is changed to (\w+)/.exec(msg))) led[x[1]] = x[2];
    else if (/^Failed to connect to Hesai/.test(msg)) scanFail++;
    else if (/^Hesai current temp/.test(msg)) hist = [];
    else if ((x = /^Hesai total working time: (\d+) hours (\d+) minutes/.exec(msg))) kv.work = +x[1] * 60 + +x[2];
    else if ((x = /^Hesai total startup times: (\d+)/.exec(msg))) kv.starts = +x[1];
    else if ((x = /^Hesai total time (?:between (-?\d+) deg C and (-?\d+) deg C|below (-?\d+) deg C|(-?\d+) deg C): (\d+) hours (\d+) minutes/.exec(msg))) { const mn = +x[5] * 60 + +x[6]; if (mn) hist.push((x[1] != null ? x[1] + "–" + x[2] : x[3] != null ? "< " + x[3] : "> " + x[4]) + " °C: " + mn + " min"); }
    else if ((x = /^Hesai factory calibration: "(.*)"$/.exec(msg))) { try { calib = JSON.parse(x[1].replace(/\\"/g, '"')).map(c => +c.e).filter(isFinite); } catch (e) { /* calibration text not readable */ } }
    else if ((x = /^USB drive size is (\S+)/.exec(msg))) kv.usbSize = x[1];
    else if ((x = /^USB drive used is (\S+)/.exec(msg))) { if (kv.usb0 == null) kv.usb0 = x[1]; kv.usb1 = x[1]; }
    else if ((x = /^Record without GNSS is (\w+)/.exec(msg))) kv.noGnss = x[1];
    else if (/^Stopped logging/.test(msg)) kv.stop = t;
    else if ((x = /^\$GPRMC,(\d\d)(\d\d)(\d\d(?:\.\d+)?),A,(\d\d)(\d\d\.\d+),([NS]),(\d{3})(\d\d\.\d+),([EW]),[^,]*,[^,]*,(\d\d)(\d\d)(\d\d)/.exec(msg))) {
      const ut = Date.UTC(2000 + +x[12], x[11] - 1, +x[10], +x[1], +x[2]) + parseFloat(x[3]) * 1000, la = (+x[4] + x[5] / 60) * (x[6] === "S" ? -1 : 1), lo = (+x[7] + x[8] / 60) * (x[9] === "W" ? -1 : 1);
      rmc.push({ t: ut, lat: la, lon: lo }); offs.push(t - ut); }
  });
  L.device.make = "Wingtra"; L.device.model = "WingtraOne LiDAR"; L.device.serial = kv.id || null; L.device.fw = kv.fw || null; L.device.receiver = kv.rx || null;
  L.trajectory = rmc.map(r => ({ t: r.t, lat: r.lat, lon: r.lon })); for (const r of rmc) span(L, r.t); L.timeSource = "NMEA $GPRMC (UTC)";
  L.lidar = { recorded: recs.map(r => r.file) };
  const rng = a => a.length ? Math.min(...a) + "…" + Math.max(...a) : null, hm = mn => Math.floor(mn / 60) + " h " + (mn % 60) + " min";
  fact(L, "fFormat", "Wingtra LiDAR service.log"); fact(L, "fFirmware", kv.fw); fact(L, "fReceiver", kv.rxModel ? kv.rx + " · " + kv.rxModel : kv.rx); fact(L, "fScanner", kv.sc); fact(L, "fSerial", kv.id);
  fact(L, "fBoresight", kv.linear ? "linear (" + kv.linear + ") m · angular (" + kv.angular + ")°" : null); fact(L, "fOrientation", kv.orient); fact(L, "fSecAntenna", kv.ant2);
  fact(L, "fFov", kv.fovMin != null && kv.fovMax != null ? kv.fovMin + "° → " + kv.fovMax + "° (" + ((kv.fovMax - kv.fovMin + 360) % 360) + "°)" : null);
  fact(L, "fRecording", recs.length ? recs.map(r => r.file + (r.t != null ? " " + iso(r.t).slice(11, 19) : "") + (r.sum ? " (checksum " + r.sum + ")" : "")).join(" · ") + (kv.stop != null ? " · stop " + iso(kv.stop).slice(11, 19) : "") : null);
  fact(L, "fRecordNoGnss", kv.noGnss); fact(L, "fUsb", kv.usbSize ? kv.usbSize + " · used " + kv.usb0 + (kv.usb1 !== kv.usb0 ? " → " + kv.usb1 : "") : null);
  fact(L, "fNavStates", nav.length ? nav.join(" → ") : null); fact(L, "fLeds", Object.keys(led).length ? Object.entries(led).map(([k, v]) => k + ": " + v).join(", ") : null);
  fact(L, "fImuModel", model.size ? [...model].map(([k, v]) => k + " " + v).join(", ") : null);
  fact(L, "fImuLatency", lat.length ? "median " + median(lat).toFixed(2) + " ms · max " + Math.max(...lat).toFixed(1) + " ms (" + lat.length + ")" : null);
  fact(L, "fClockSteer", adj.length || kv.step != null ? [kv.step != null ? "initial step " + kv.step + " s" : null, adj.length ? adj.length + " corrections, max " + Math.max(...adj.map(Math.abs)) + " µs" : null, freq.length ? "frequency " + rng(freq.map(x => +x.toFixed(2))) + " ppm" : null].filter(Boolean).join(" · ") : null);
  fact(L, "fScannerTemp", temps.length ? Math.min(...temps) + "–" + Math.max(...temps) + " °C" : null);
  fact(L, "fScannerUse", kv.work != null ? "working " + hm(kv.work) + (kv.starts != null ? " · " + kv.starts + " start-ups" : "") + (scanFail ? " · " + scanFail + " connection failures at start" : "") : null);
  fact(L, "fScannerTempHist", hist.length ? hist.join(", ") : null);
  fact(L, "fScannerCalib", calib && calib.length ? calib.length + " lasers, elevation " + Math.min(...calib) + "…" + Math.max(...calib) + "°" : null);
  fact(L, "fNmea", rmc.length);
  // a recording that never left the ground (all fixes within 50 m) is noted: no flight in this session
  if (rmc.length >= 10) { const a = rmc[0], d = Math.max(...rmc.map(r => Math.hypot((r.lat - a.lat) * 111320, (r.lon - a.lon) * 111320 * Math.cos(a.lat / R2D)))); fact(L, "fMoved", d.toFixed(1) + " m"); if (d < 50) L.notes.push("lidar-static"); }
  fact(L, "fLogClock", first != null ? iso(first) + " … " + iso(last) : null);
  if (clockJump) { fact(L, "fClockJump", iso(clockJump.from) + " → " + iso(clockJump.to)); L.notes.push("clock-jump"); }
  if (offs.length) fact(L, "fClockVsGnss", (median(offs) / 1000).toFixed(3) + " s");
}
async function pPcmp(src, L) {
  const s = await text(src), all = [...s.matchAll(/<(data|trajectory|rover|imu|base)\s+path="([^"]+)"([^>]*)>/g)];
  const files = all.map(m => m[1] + ": " + m[2] + (/ppk="1"/.test(m[3]) ? " (PPK)" : ""));
  L.device.make = "Wingtra"; fact(L, "fFormat", "Wingtra LiDAR project (ppk.pcmp)"); fact(L, "fFiles", files.join(" · ")); fact(L, "fLasers", (s.match(/<laser number=/g) || []).length);
  const rg = /<range\s+min="([^"]+)"\s+max="([^"]+)"/.exec(s), rot = /<rotation\s+min="([^"]+)"\s+max="([^"]+)"/.exec(s);
  fact(L, "fFilters", rg || rot ? [rg ? "range " + +rg[1] + "–" + +rg[2] + " m" : null, rot ? "rotation " + rot[1] + " → " + rot[2] : null].filter(Boolean).join(" · ") : null);
  const ant = [...s.matchAll(/<(priAnt|secAnt)\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)].map(m => (m[1] === "priAnt" ? "primary" : "secondary") + " (" + m[2] + ", " + m[3] + ", " + m[4] + ") m");
  fact(L, "fAntennaOffsets", ant.length ? ant.join(" · ") : null);
  L.lidar = { data: all.filter(m => m[1] === "data").map(m => m[2].split("/").pop()), inputs: all.filter(m => m[1] !== "data").map(m => m[2]) };
}

/* ---------------------------------------------------------------- Wingtra payload computer (OBC) log: obclogs/NNNNN_YYYYMMDD_hhmmss.txt (WingtraPilot 2.19+)
   "2026-Mar-18 13:18:45.627804|NOTICE|MAIN|text", older YYYYMMDD_hhmmss_NNNNN.xml "<severity level=".." timestamp="..">[MOD]: text</severity>".
   The OBC clock is not set from GNSS: its time is shown as written, and moved to UTC only by the PPK triggers ("Found Trigger! TOW, WNc, …"),
   whose GPS time equals the event time in the WingtraHub geotaglog. */
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
async function pObc(src, L, h, o) {
  const lv = {}, warn = new Map(), trig = [], geo = [], sweeps = [], kv = {}; let first = null, last = null, n = 0;
  const RX_T = /^(\d{4})-([A-Z][a-z]{2})-(\d\d) (\d\d):(\d\d):(\d\d(?:\.\d+)?)\|\s*(\w*)\s*\|\s*(\w*)\s*\|(.*)$/, RX_X = /<severity level="(\w+)" timestamp="(\d{4})-([A-Z][a-z]{2})-(\d\d) (\d\d):(\d\d):(\d\d(?:\.\d+)?)">(?:\[\s*(\w*)\]: )?(.*?)(?:<\/severity>|$)/;
  const ent = x => x.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  await eachLine(src, line => {
    line = line.replace(/\0/g, ""); let m = RX_T.exec(line), y, mo, d, hh, mi, ss, lev, mod, msg;
    if (m) [, y, mo, d, hh, mi, ss, lev, mod, msg] = m; else if ((m = RX_X.exec(line))) { [, lev, y, mo, d, hh, mi, ss, mod, msg] = m; msg = ent(msg); } else return;
    if (!lev || MON[mo] == null) return;
    const t = Date.UTC(+y, MON[mo], +d, +hh, +mi) + parseFloat(ss) * 1000; lev = lev.toUpperCase(); n++; lv[lev] = (lv[lev] || 0) + 1; if (first == null) first = t; last = t; msg = msg.trim();
    if (/^(WARN|WARNING|ERROR|ERR|CRITICAL|FATAL)$/.test(lev)) { const pre = mod ? mod + ": " : "", k = pre + msg.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, "#"), g = warn.get(k) || { msg: pre + msg, n: 0, err: false }; g.n++; if (lev !== "WARN" && lev !== "WARNING") g.err = true; warn.set(k, g); }
    let x;
    if ((x = /^Found Trigger! TOW, WNc, Offset, ClkBias: (\d+), (\d+), ([-\d.e+]+), [-\d.e+]+, ppkFixType (\d+)/.exec(msg))) trig.push({ tl: t, t: gpsToUtc(+x[2], +x[1]), fix: x[4] });
    else if ((x = /^New geotag item: (\d+)/.exec(msg))) geo.push({ tl: t, k: +x[1] });
    else if ((x = /^Sweep started with height above ground (-?[\d.]+)/.exec(msg))) sweeps.push(+x[1]);
    else if ((x = /^GIT_TAG: "?([^"\s]+)"?(?: GIT_HASH: "?(\w+))?/.exec(msg))) { if (!kv.fw) { kv.fw = x[1]; kv.hash = x[2]; } }
    else if ((x = /^Camera Software\s*: (.+)/.exec(msg))) kv.cam = x[1].trim();
    else if ((x = /^Found (Sony|MicaSense|Phase One|\w+) camera (\S+)/.exec(msg))) { if (!kv.cam0) kv.cam0 = x[1] + " " + x[2]; }
    else if ((x = /^Running on RPi HW_VER=(\S+)/.exec(msg))) kv.hw = x[1];
    else if (/^PPK RfStatus, Interference: Yes/.test(msg)) kv.rf = (kv.rf || 0) + 1;
    else if (/^SBF parser failures/.test(msg)) kv.sbf = (kv.sbf || 0) + 1;
    else if (/^PPK ReceiverStatus ExtError/.test(msg)) kv.ext = (kv.ext || 0) + 1;
    else if ((x = /^BUILD TYPE: (\S+)/.exec(msg))) kv.build = x[1];
  }, o);
  // the trigger logged nearest to a geotag item (within 1.5 s of OBC time) belongs to it; with geotag items present, only those triggers are exposures
  const used = new Set(); for (const g of geo) { let k = -1; trig.forEach((tr, i) => { if (!used.has(i) && Math.abs(tr.tl - g.tl) < 1500 && (k < 0 || Math.abs(tr.tl - g.tl) < Math.abs(trig[k].tl - g.tl))) k = i; }); if (k >= 0) used.add(k); }
  const ex = geo.length ? trig.filter((_, i) => used.has(i)) : trig;
  L.exposures = ex.map((e, k) => ({ n: k + 1, t: e.t, _tc: e.t, lat: null, lon: null, h: null, q: "log" }));
  const off = trig.length ? median(trig.map(e => e.tl - e.t)) : null;
  if (off != null) { span(L, first - off); span(L, last - off); L.timeSource = "OBC clock − median offset to the PPK trigger GPS time"; }
  L.device.make = "Wingtra"; L.device.model = "WingtraOne payload computer (OBC)"; L.device.fw = kv.fw || null; L.device.camera = kv.cam || kv.cam0 || null;
  fact(L, "fFormat", "Wingtra payload computer log (OBC)"); fact(L, "fFirmware", kv.fw ? kv.fw + (kv.hash ? " (" + kv.hash + ")" : "") + (kv.build ? " · " + kv.build : "") : null); fact(L, "fHardware", kv.hw ? "Raspberry Pi HW_VER=" + kv.hw : null);
  fact(L, "fCamera", [kv.cam0, kv.cam].filter(Boolean).join(" · "));
  fact(L, "fCameraTriggers", trig.length ? trig.length + " PPK triggers (" + Object.entries(countBy(trig, e => "ppkFixType " + e.fix)).map(([k, v]) => k + ": " + v).join(", ") + ")" + (geo.length ? " · " + geo.length + " geotag items · triggers without a geotag item: " + (trig.length - used.size) : "") : null);
  fact(L, "fSweeps", sweeps.length || null);
  fact(L, "fPpkHealth", kv.rf || kv.sbf || kv.ext ? ["RF interference: " + (kv.rf || 0), "SBF parser failures: " + (kv.sbf || 0), "receiver ExtError: " + (kv.ext || 0)].join(" · ") : null);
  fact(L, "fLogClock", first != null ? iso(first).replace("Z", "") + " … " + iso(last).replace("Z", "") + " (OBC clock, zone not stated)" : null);
  if (off != null) fact(L, "fClockVsGnss", (off >= 0 ? "+" : "−") + (Math.abs(off) / 1000).toFixed(1) + " s (" + Math.floor(Math.abs(off) / 3600000) + " h " + Math.floor(Math.abs(off) % 3600000 / 60000) + " min)");
  fact(L, "fLogLevels", Object.entries(lv).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ": " + v).join(", "));
  const top = [...warn.values()].sort((a, b) => b.err - a.err || b.n - a.n).slice(0, 6); fact(L, "fWarnings", top.length ? top.map(g => (g.err ? "[error] " : "") + g.msg.slice(0, 140) + (g.n > 1 ? " ×" + g.n : "")).join(" | ") : null);
  if (n && off == null) L.notes.push("obc-clock-unset");
}

/* ---------------------------------------------------------------- encrypted or undocumented logs */
async function pEncrypted(src, L, h) {
  if (!L.size) { fact(L, "fFormat", "empty file"); L.notes.push("empty"); return; }
  const bundle = /\.lz\.enc\0/.test(new TextDecoder("latin1").decode(h.subarray(0, 300)));
  const e = entropy(h.subarray(0, 65536)); L.encrypted = bundle || e > 7.5;
  if (bundle) { fact(L, "fFormat", "DJI device log bundle (members *.lz.enc, encrypted by DJI)"); fact(L, "fEntropy", e.toFixed(2) + " bit/B"); L.notes.push("encrypted"); return; }
  fact(L, "fFormat", /_em\.bb3$/i.test(L.name) ? "senseFly .bb3 (emergency log)" : /sequoia_diag/i.test(L.name) ? "Parrot Sequoia diagnostics" : /diag|hostlog|httplog/i.test(L.name) ? "MicaSense diagnostics" : "unknown");
  fact(L, "fEntropy", e.toFixed(2) + " bit/B"); L.notes.push(L.encrypted ? "encrypted" : "undocumented");
}

/* ---------------------------------------------------------------- ArduPilot DataFlash (.bin) and its text form (.log)
   Self-describing: FMT messages (type 128) give each message type its length, name, field types and column names.
   Read: GPS (time, status, position), GPA (accuracy), CAM / TRIG (exposures), MSG / VER (firmware). Column names differ
   between versions (GMS/GWk since 3.x, TimeMS/Week before), so fields are looked up by name, not by position. */
const DF_T = { b: [1, "getInt8"], B: [1, "getUint8"], M: [1, "getUint8"], h: [2, "getInt16"], H: [2, "getUint16"], i: [4, "getInt32"], I: [4, "getUint32"], f: [4, "getFloat32"], d: [8, "getFloat64"],
  c: [2, "getInt16", 0.01], C: [2, "getUint16", 0.01], e: [4, "getInt32", 0.01], E: [4, "getUint32", 0.01], L: [4, "getInt32", 1e-7], q: [8, "i64"], Q: [8, "u64"], n: [4, "s"], N: [16, "s"], Z: [64, "s"], a: [64, "x"] };
const AP_WANT = /^(GPS|GPS2|GPA|CAM|TRIG|MSG|VER|PARM|VIBE|MODE|ERR)$/;
// flight modes by vehicle (ArduCopter/ArduPlane/Rover mode.h); AUTO is the mission mode. ERR subsystems: AP_Logger.h LogErrorSubsystem
const AP_MODES = {
  copter: { 0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED", 5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND", 11: "DRIFT", 13: "SPORT", 14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE", 18: "THROW", 19: "AVOID_ADSB", 20: "GUIDED_NOGPS", 21: "SMART_RTL", 22: "FLOWHOLD", 23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID", 26: "AUTOROTATE", 27: "AUTO_RTL", 28: "TURTLE" },
  plane: { 0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO", 5: "FBWA", 6: "FBWB", 7: "CRUISE", 8: "AUTOTUNE", 10: "AUTO", 11: "RTL", 12: "LOITER", 13: "TAKEOFF", 14: "AVOID_ADSB", 15: "GUIDED", 16: "INITIALISING", 17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER", 20: "QLAND", 21: "QRTL", 22: "QAUTOTUNE", 23: "QACRO", 24: "THERMAL", 25: "LOITER_ALT_QLAND", 26: "AUTOLAND", 27: "GLIDE" },
  rover: { 0: "MANUAL", 1: "ACRO", 3: "STEERING", 4: "HOLD", 5: "LOITER", 6: "FOLLOW", 7: "SIMPLE", 8: "DOCK", 9: "CIRCLE", 10: "AUTO", 11: "RTL", 12: "SMART_RTL", 15: "GUIDED", 16: "INITIALISING" } };
const AP_AUTO = { copter: 3, plane: 10, rover: 10 };
const AP_ERR = { 1: "main", 2: "radio", 3: "compass", 5: "radio failsafe", 6: "battery failsafe", 7: "GPS failsafe", 8: "GCS failsafe", 9: "fence failsafe", 10: "flight mode", 11: "GPS", 12: "crash check", 15: "parachute", 16: "EKF check", 17: "EKF failsafe", 18: "baro", 19: "CPU", 20: "ADS-B failsafe", 21: "terrain", 22: "navigation", 23: "terrain failsafe", 24: "EKF primary", 25: "thrust loss", 26: "sensors failsafe", 27: "leak failsafe", 28: "pilot input", 29: "vibration failsafe", 30: "internal error", 31: "dead reckoning failsafe" };
const apFamily = v => /Copter|Heli/i.test(v || "") ? "copter" : /Plane/i.test(v || "") ? "plane" : /Rover|Boat/i.test(v || "") ? "rover" : null;
const apMode = (fam, num, name) => ({ name: name || (fam && AP_MODES[fam][num]) || "mode " + num, auto: fam ? num === AP_AUTO[fam] : null });
const AP_Q = { 0: "none", 1: "none", 2: "2D", 3: "single", 4: "dgnss", 5: "float", 6: "fixed" };
function apState() {
  const S = { gps: [], cam: [], trig: [], fw: null, vehicle: null, parm: 0, types: {}, hacc: null, status: null, sync: [], noWeek: 0, gq: [], vib: [], modes: [], ev: [] };
  S.rec = (name, r) => {
    S.types[name] = (S.types[name] || 0) + 1;
    const us = r.TimeUS != null ? r.TimeUS : r.TimeMS != null && r.Week == null ? r.TimeMS * 1000 : null;
    if (name === "GPS" && (r.I == null || r.I === 0)) {
      const st = r.Status, wk = r.GWk != null ? r.GWk : r.Week, tow = r.GMS != null ? r.GMS : r.Week != null ? r.TimeMS : null;
      S.status = st; let lat = r.Lat, lon = r.Lng; if (lat != null && Math.abs(lat) > 180) { lat *= 1e-7; lon *= 1e-7; }
      const t = wk > 0 && tow != null ? gpsToUtc(wk, tow) : null; if (t != null && us != null) S.sync.push(t - us / 1000); if (st >= 3 && !(wk > 0)) S.noWeek++;
      if (st >= 2 && lat) S.gps.push({ us, t, lat, lon, h: r.Alt, q: AP_Q[st] || "fix " + st, sH: S.hacc });
      S.gq.push({ us, t, sv: r.NSats != null ? r.NSats : r.NSat, hdop: r.HDop, fix: st });
    } else if (name === "GPA" && (r.I == null || r.I === 0)) S.hacc = r.HAcc != null ? r.HAcc : null;
    else if (name === "CAM" || name === "TRIG") {
      let lat = r.Lat, lon = r.Lng; if (lat != null && Math.abs(lat) > 180) { lat *= 1e-7; lon *= 1e-7; }
      const t = r.GPSWeek > 0 && r.GPSTime != null ? gpsToUtc(r.GPSWeek, r.GPSTime) : null;
      (name === "CAM" ? S.cam : S.trig).push({ n: r.Img != null ? r.Img : (name === "CAM" ? S.cam : S.trig).length + 1, us, t, lat, lon, h: r.GPSAlt != null ? r.GPSAlt : r.Alt, hRel: r.RelAlt, q: AP_Q[S.status] || null, sH: S.hacc, roll: r.R != null ? r.R : r.Roll, pitch: r.P != null ? r.P : r.Pitch, yaw: r.Y != null ? r.Y : r.Yaw });
    } else if (name === "MSG") { const msg = String(r.Message || "").trim(), m = !S.fw && /^(Ardu\w+|Blimp|AP_Periph|PX4)\s+V?(\d+\.\d+(?:\.\d+)?\S*)/.exec(msg); if (m) { S.vehicle = m[1]; S.fw = m[1] + " " + m[2]; }
      if (/failsafe|crash|glitch|error|lost/i.test(msg)) S.ev.push({ us, lvl: 4, msg }); }
    else if (name === "VIBE") S.vib.push({ us, imu: r.IMU || 0, v: Math.max(r.VibeX, r.VibeY, r.VibeZ), clip: r.Clip != null ? r.Clip : (r.Clip0 || 0) + (r.Clip1 || 0) + (r.Clip2 || 0) });
    else if (name === "MODE") S.modes.push({ us, num: r.ModeNum != null ? +r.ModeNum : +r.Mode, name: typeof r.Mode === "string" && !isFinite(+r.Mode) ? r.Mode : null });
    else if (name === "ERR" && r.ECode) S.ev.push({ us, lvl: 3, msg: "ERR " + (AP_ERR[r.Subsys] || "subsystem " + r.Subsys) + ", code " + r.ECode });
    else if (name === "VER" && !S.fw && r.FWS) { const m = /^(Ardu\w+|Blimp)\s+V?(\S+)/.exec(String(r.FWS).trim()); if (m) { S.vehicle = m[1]; S.fw = m[1] + " " + m[2]; } }
    else if (name === "PARM") S.parm++;
  };
  return S;
}
function apResult(S, L, fmtName) {
  const off = median(S.sync), toUtc = us => us == null || off == null ? null : us / 1000 + off;
  L.trajectory = S.gps.map(g => ({ t: g.t != null ? g.t : toUtc(g.us), lat: g.lat, lon: g.lon, h: g.h, q: g.q }));
  const ex = S.cam.length ? S.cam : S.trig;
  L.exposures = ex.map(e => ({ n: e.n, t: e.t != null ? e.t : toUtc(e.us), lat: e.lat || null, lon: e.lon || null, h: e.h, sH: e.sH, q: e.q || "log", roll: e.roll, pitch: e.pitch, yaw: e.yaw }));
  for (const p of L.trajectory) span(L, p.t); for (const e of L.exposures) span(L, e.t);
  L.timeSource = off != null ? "GPS week + ms of week (GWk/GMS) − leap seconds; other messages via boot time" : null;
  const fam = apFamily(S.vehicle);
  L._aux = { gq: S.gq.map(g => ({ t: g.t != null ? g.t : toUtc(g.us), sv: g.sv, hdop: g.hdop, fix: g.fix })), vib: S.vib.map(v => ({ t: toUtc(v.us), imu: v.imu, v: v.v, clip: v.clip })),
    modes: S.modes.map(m => Object.assign({ t: toUtc(m.us) }, apMode(fam, m.num, m.name))), ev: S.ev.map(e => ({ t: toUtc(e.us), lvl: e.lvl, msg: e.msg })) };
  L.device.make = "ArduPilot"; L.device.model = S.vehicle; L.device.fw = S.fw;
  fact(L, "fFormat", fmtName); fact(L, "fFirmware", S.fw);
  fact(L, "fExposures", ex.length ? ex.length + (S.cam.length ? " (CAM)" : " (TRIG)") : null);
  fact(L, "fHeight", ex.length ? "above mean sea level (CAM GPSAlt / Alt), not ellipsoid" : null);
  if (S.gps.length) fact(L, "fGnssFix", Object.entries(countBy(S.gps, g => g.q)).map(([k, v]) => k + ": " + v).join(", "));
  fact(L, "fParams", S.parm || null);
  fact(L, "fMessages", Object.entries(S.types).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ": " + v).join(", "));
  if (ex.length) L.notes.push("height-amsl");
  if (S.noWeek && !S.sync.length) L.notes.push("gps-no-week");
}
async function pDataFlash(src, L, h, o) {
  const S = apState(), F = {}; let bad = 0;
  F[128] = { len: 89, name: "FMT", fmt: "BBnNZ", cols: ["Type", "Length", "Name", "Format", "Columns"] };
  const dec = (f, b, j) => { const dv = dvOf(b), r = {}; let k = j + 3;
    for (let i = 0; i < f.fmt.length; i++) { const T = DF_T[f.fmt[i]]; if (!T) return null; const c = f.cols[i];
      if (T[1] === "s") r[c] = asc(b, k, T[0]); else if (T[1] === "x") { /* array, skipped */ } else if (T[1] === "u64" || T[1] === "i64") r[c] = rd(dv, T[1] === "u64" ? "uint64_t" : "int64_t", k);
      else { const v = dv[T[1]](k, true); r[c] = T[2] ? v * T[2] : v; } k += T[0]; }
    return r; };
  await scan(src, (b, fin) => {
    let j = 0;
    while (j + 3 <= b.length) {
      if (b[j] !== 0xa3 || b[j + 1] !== 0x95) { j++; continue; }
      const f = F[b[j + 2]]; if (!f) { j++; continue; }
      if (j + f.len > b.length) return fin ? b.length : j;
      if (f.name === "FMT") { const r = dec(f, b, j); if (r && r.Length >= 3) { const sz = 3 + [...String(r.Format)].reduce((t, c) => t + (DF_T[c] ? DF_T[c][0] : 1e6), 0); F[r.Type] = { len: r.Length, name: r.Name, fmt: r.Format, cols: String(r.Columns).split(","), ok: sz <= r.Length }; if (sz > r.Length) bad++; } }
      else if (AP_WANT.test(f.name) && f.ok) { const r = dec(f, b, j); if (r) S.rec(f.name, r); else S.types[f.name] = (S.types[f.name] || 0) + 1; }
      else S.types[f.name] = (S.types[f.name] || 0) + 1;
      j += f.len;
    }
    return fin ? b.length : j;
  }, o);
  apResult(S, L, "ArduPilot DataFlash (.bin)"); if (bad) { fact(L, "fBadFormats", bad); L.notes.push("df-bad-fmt"); }
}
async function pAPText(src, L, h, o) {
  const S = apState(), F = {};
  await eachLine(src, l => {
    const p = l.split(",").map(x => x.trim()); if (p.length < 2) return;
    if (p[0] === "FMT") { if (p.length >= 6) F[p[3]] = p.slice(5); return; }
    const cols = F[p[0]]; if (!cols) return;
    if (!AP_WANT.test(p[0])) { S.types[p[0]] = (S.types[p[0]] || 0) + 1; return; }
    const r = {}; cols.forEach((c, i) => { const v = p[i + 1]; r[c] = v != null && v !== "" && isFinite(+v) ? +v : v; }); S.rec(p[0], r);
  }, o);
  apResult(S, L, "ArduPilot text log (.log)");
}

/* ---------------------------------------------------------------- MAVLink telemetry log (.tlog): <u64 BE Unix µs><MAVLink 1 or 2 packet> ...
   Read: GPS_RAW_INT (24), CAMERA_FEEDBACK (180), CAMERA_TRIGGER (112), HEARTBEAT (0, autopilot and flight mode), AUTOPILOT_VERSION (148),
   STATUSTEXT (253, firmware and messages of severity warning or worse), VIBRATION (241).
   Packets are not CRC-checked (that needs the per-message CRC_EXTRA table); the timestamp and header are checked instead. */
// PX4 custom_mode in HEARTBEAT: main mode in bits 16–23, sub mode in bits 24–31 (px4_custom_mode.h); AUTO (4) + MISSION (4) is the mission
const PX4_MAIN = { 1: "MANUAL", 2: "ALTCTL", 3: "POSCTL", 4: "AUTO", 5: "ACRO", 6: "OFFBOARD", 7: "STABILIZED", 8: "RATTITUDE" }, PX4_SUB = { 1: "READY", 2: "TAKEOFF", 3: "LOITER", 4: "MISSION", 5: "RTL", 6: "LAND", 8: "FOLLOW_TARGET", 9: "PRECLAND" };
// MAV_TYPE of an ArduPilot heartbeat → vehicle (for the mode names)
const mavFamily = ty => ty === 1 || (ty >= 19 && ty <= 25) ? "plane" : ty === 10 || ty === 11 ? "rover" : [2, 3, 4, 13, 14, 15].includes(ty) ? "copter" : null;
const MAV_AP = { 3: "ArduPilot", 12: "PX4" }, MAV_FIX = { 0: "none", 1: "none", 2: "2D", 3: "single", 4: "dgnss", 5: "float", 6: "fixed", 7: "static", 8: "ppp" };
async function pTlog(src, L, h, o) {
  const gps = [], cam = [], trig = [], cnt = {}, gq = [], vib = [], modes = [], ev = []; let ap = null, fw = null, text = null, lastMode = null;
  const okTs = (b, j) => { const hi = (b[j] << 24 | b[j + 1] << 16 | b[j + 2] << 8 | b[j + 3]) >>> 0; const us = hi * 4294967296 + ((b[j + 4] << 24 | b[j + 5] << 16 | b[j + 6] << 8 | b[j + 7]) >>> 0); return us > 3.2e14 && us < 4.1e15 ? us : 0; };
  await scan(src, (b, fin) => {
    let j = 0;
    while (j + 16 <= b.length) {
      const us = okTs(b, j), m = b[j + 8]; if (!us || (m !== 0xfe && m !== 0xfd)) { j++; continue; }
      const len = b[j + 9], v2 = m === 0xfd, hl = v2 ? 10 : 6, sig = v2 && (b[j + 10] & 1) ? 13 : 0, tot = 8 + hl + len + 2 + sig;
      if (j + tot > b.length) return fin ? b.length : j;
      const sys = v2 ? b[j + 13] : b[j + 11], id = v2 ? b[j + 15] | b[j + 16] << 8 | b[j + 17] << 16 : b[j + 13];
      const raw = b.subarray(j + 8 + hl, j + 8 + hl + len), need = { 0: 9, 24: 50, 180: 47, 112: 12, 148: 60, 241: 32, 253: 51 }[id];
      if (sys !== 255 && need) { const p = new Uint8Array(Math.max(need, raw.length)); p.set(raw); const dv = dvOf(p), t = us / 1000;
        if (id === 0) { if (ap == null && MAV_AP[p[5]]) ap = MAV_AP[p[5]];
          if (MAV_AP[p[5]]) { const cm = dv.getUint32(0, true), key = p[5] + ":" + p[4] + ":" + cm; if (key !== lastMode) { lastMode = key;
            if (p[5] === 12) { const mm = (cm >>> 16) & 255, sm = cm >>> 24; modes.push({ t, name: mm === 4 ? "AUTO_" + (PX4_SUB[sm] || sm) : PX4_MAIN[mm] || "mode " + mm, auto: mm === 4 && sm === 4 }); }
            else modes.push(Object.assign({ t }, apMode(mavFamily(p[4]), cm))); } } }
        else if (id === 24) { const ft = p[28], eph = dv.getUint16(20, true); gq.push({ t, sv: p[29] === 255 ? null : p[29], hdop: eph === 65535 ? null : eph / 100, fix: ft }); const lat = dv.getInt32(8, true) * 1e-7, lon = dv.getInt32(12, true) * 1e-7, he = dv.getInt32(30, true), hacc = dv.getUint32(34, true);
          if (ft >= 2 && lat) gps.push({ t, lat, lon, h: he ? he / 1000 : dv.getInt32(16, true) / 1000, ell: !!he, q: MAV_FIX[ft] || "fix " + ft, sH: hacc ? hacc / 1000 : null }); }
        else if (id === 180) { const tu = rd(dv, "uint64_t", 0); cam.push({ n: dv.getUint16(40, true), t: tu > 1e15 && tu < 4.1e15 ? tu / 1000 : t, _tc: t, lat: dv.getInt32(8, true) * 1e-7, lon: dv.getInt32(12, true) * 1e-7, h: dv.getFloat32(16, true), roll: dv.getFloat32(24, true), pitch: dv.getFloat32(28, true), yaw: dv.getFloat32(32, true) }); }
        else if (id === 112) { const tu = rd(dv, "uint64_t", 0); trig.push({ n: dv.getUint32(8, true), t: tu > 1e15 && tu < 4.1e15 ? tu / 1000 : t, _tc: t }); }
        else if (id === 241) vib.push({ t, imu: 0, v: Math.max(dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true)), clip: dv.getUint32(20, true) + dv.getUint32(24, true) + dv.getUint32(28, true) });
        else if (id === 148 && !fw) { const v = dv.getUint32(16, true); if (v) fw = relVer(v); }
        else if (id === 253) { const s = asc(p, 1, 50); if (!text && /^(Ardu\w+|PX4)\s+v?\d/i.test(s)) text = s; if (p[0] <= 4) ev.push({ t, lvl: p[0], msg: s }); } }
      cnt[id] = (cnt[id] || 0) + 1; j += tot;
    }
    return fin ? b.length : j;
  }, o);
  L.trajectory = gps.map(g => ({ t: g.t, lat: g.lat, lon: g.lon, h: g.h, q: g.q }));
  const ex = cam.length ? cam : trig, last = t => { let q = null; for (const g of gps) { if (g.t > t) break; q = g; } return q; };
  L.exposures = ex.map(e => { const g = last(e._tc); return { n: e.n, t: e.t, _tc: e._tc, lat: e.lat || null, lon: e.lon || null, h: e.h, q: g ? g.q : "log", sH: g ? g.sH : null, roll: e.roll, pitch: e.pitch, yaw: e.yaw }; });
  L._aux = { gq, vib, modes, ev };
  for (const p of L.trajectory) span(L, p.t); for (const e of L.exposures) span(L, e.t);
  L.timeSource = "tlog receive time (ground station clock); CAMERA_FEEDBACK time_usec when set";
  L.device.make = ap; L.device.fw = text ? text.split(/\s+/).slice(0, 2).join(" ") : fw ? (ap || "") + " " + fw : null;
  fact(L, "fFormat", "MAVLink telemetry log (.tlog)"); fact(L, "fFirmware", L.device.fw);
  fact(L, "fExposures", ex.length ? ex.length + (cam.length ? " (CAMERA_FEEDBACK)" : " (CAMERA_TRIGGER)") : null);
  if (cam.length) { fact(L, "fHeight", "CAMERA_FEEDBACK alt_msl: above mean sea level"); L.notes.push("height-amsl"); }
  else if (trig.length && gps.length) { const ell = gps.every(g => g.ell); fact(L, "fHeight", ell ? "ellipsoid (GPS_RAW_INT alt_ellipsoid, interpolated to CAMERA_TRIGGER)" : "GPS_RAW_INT alt: above mean sea level (interpolated to CAMERA_TRIGGER)"); if (!ell) L.notes.push("height-amsl"); }
  if (gps.length) fact(L, "fGnssFix", Object.entries(countBy(gps, g => g.q)).map(([k, v]) => k + ": " + v).join(", "));
  fact(L, "fMessages", Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ 0: "HEARTBEAT", 1: "SYS_STATUS", 2: "SYSTEM_TIME", 24: "GPS_RAW_INT", 27: "RAW_IMU", 29: "SCALED_PRESSURE", 30: "ATTITUDE", 33: "GLOBAL_POSITION_INT", 42: "MISSION_CURRENT", 62: "NAV_CONTROLLER_OUTPUT", 65: "RC_CHANNELS", 74: "VFR_HUD", 112: "CAMERA_TRIGGER", 136: "TERRAIN_REPORT", 147: "BATTERY_STATUS", 148: "AUTOPILOT_VERSION", 152: "MEMINFO", 178: "AHRS2", 180: "CAMERA_FEEDBACK", 193: "EKF_STATUS_REPORT", 241: "VIBRATION", 253: "STATUSTEXT" }[k] || "#" + k) + ": " + v).join(", "));
}

/* ---------------------------------------------------------------- NMEA 0183: GGA (position, quality, height), RMC / ZDA (date), GST (σ) */
const NMEA_Q = { 0: "none", 1: "single", 2: "dgnss", 3: "pps", 4: "fixed", 5: "float", 6: "dead reckoning", 7: "manual", 8: "simulation" };
function nmeaOk(s) { const k = s.indexOf("*"); if (k < 0) return true; let c = 0; for (let i = 1; i < k; i++) c ^= s.charCodeAt(i); return parseInt(s.slice(k + 1, k + 3), 16) === c; }
function nmeaDeg(v, hemi) { if (!v) return null; const d = Math.floor(+v / 100), m = +v - d * 100, x = d + m / 60; return /[SW]/.test(hemi) ? -x : x; }
function nmeaTod(v) { if (!v || v.length < 6) return null; return ((+v.slice(0, 2) * 60 + +v.slice(2, 4)) * 60 + +v.slice(4)) * 1000; }
async function pNMEA(src, L, h, o) {
  let day = null, lastTod = null, bad = 0, n = 0; const pend = [], talkers = {}, gst = new Map();
  await eachLine(src, l => {
    const k = l.indexOf("$"); if (k < 0) return; const s = l.slice(k).trim(); if (!/^\$[A-Z]{5}/.test(s)) return; n++;
    if (!nmeaOk(s)) { bad++; return; }
    const p = s.split("*")[0].split(","), ty = p[0].slice(3); talkers[p[0].slice(1, 3)] = 1;
    if (ty === "RMC" && p[9] && p[9].length === 6) { const d = Date.UTC(2000 + +p[9].slice(4, 6), +p[9].slice(2, 4) - 1, +p[9].slice(0, 2)); if (day == null) for (const x of pend) if (x.tod != null) x.t = d + x.tod; day = d; lastTod = nmeaTod(p[1]); }
    else if (ty === "ZDA" && p[4]) { const d = Date.UTC(+p[4], +p[3] - 1, +p[2]); if (day == null) for (const x of pend) if (x.tod != null) x.t = d + x.tod; day = d; lastTod = nmeaTod(p[1]); }
    else if (ty === "GGA") { const tod = nmeaTod(p[1]), q = +p[6]; if (!(q > 0)) return;
      if (day != null && lastTod != null && tod != null && tod < lastTod - 43200000) day += 86400000; if (tod != null) lastTod = tod;
      const alt = p[9] !== "" ? +p[9] : null, sep = p[11] !== "" ? +p[11] : null;
      const e = { tod, t: day != null && tod != null ? day + tod : null, lat: nmeaDeg(p[2], p[3]), lon: nmeaDeg(p[4], p[5]), h: alt != null && sep != null ? alt + sep : alt, q: NMEA_Q[q] || "q " + q, sats: +p[7], ell: sep != null };
      pend.push(e); }
    else if (ty === "GST" && p.length >= 9) gst.set(p[1], { sN: +p[6], sE: +p[7], sV: +p[8] });
  }, o);
  for (const e of pend) { const g = gst.size && e.tod != null ? [...gst.entries()].find(x => nmeaTod(x[0]) === e.tod) : null; if (g) Object.assign(e, g[1]); }
  L.trajectory = pend.map(e => ({ t: e.t, lat: e.lat, lon: e.lon, h: e.h, q: e.q }));
  for (const p of L.trajectory) span(L, p.t);
  L.timeSource = day != null ? "NMEA UTC (date from RMC/ZDA)" : null; if (pend.length && day == null) L.notes.push("nmea-no-date");
  fact(L, "fFormat", "NMEA 0183"); fact(L, "fTalkers", Object.keys(talkers).join(", ")); fact(L, "fSentences", n); fact(L, "fCrcBad", bad || null);
  if (pend.length) { fact(L, "fGnssFix", Object.entries(countBy(pend, e => e.q)).map(([k, v]) => k + ": " + v).join(", ")); fact(L, "fSats", median(pend.map(e => e.sats))); fact(L, "fHeight", pend.some(e => e.ell) ? "ellipsoid (GGA altitude + geoid separation)" : "above mean sea level (GGA, no geoid separation)"); }
  if (gst.size) fact(L, "fSigma", median(pend.map(e => e.sN)) != null ? [median(pend.map(e => e.sN)), median(pend.map(e => e.sE)), median(pend.map(e => e.sV))].map(x => x != null ? x.toFixed(3) : "–").join(" / ") + " m" : null);
}

/* ---------------------------------------------------------------- GPX 1.0 / 1.1: track points; waypoints named like image files are taken as exposures */
async function pGPX(src, L) {
  const s = await text(src), num = v => v != null && v !== "" && isFinite(+v) ? +v : null;
  const attr = (a, k) => { const m = new RegExp("\\b" + k + "\\s*=\\s*[\"']([^\"']*)[\"']").exec(a); return m ? m[1] : null; };
  const tag = (b, k) => { const m = new RegExp("<(?:\\w+:)?" + k + "[^>]*>([^<]*)<").exec(b); return m ? m[1].trim() : null; };
  const pt = (a, b) => ({ lat: num(attr(a, "lat")), lon: num(attr(a, "lon")), h: num(tag(b, "ele")), t: tag(b, "time") ? Date.parse(tag(b, "time")) : null });
  const re = /<(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g; let m; const wpt = [], cnt = { trkpt: 0, rtept: 0, wpt: 0 };
  while ((m = re.exec(s))) { cnt[m[1]]++; const p = pt(m[2], m[3] || ""); if (isNaN(p.t)) p.t = null;
    if (m[1] === "trkpt") L.trajectory.push({ t: p.t, lat: p.lat, lon: p.lon, h: p.h, q: "log" }); else if (m[1] === "wpt") wpt.push(Object.assign(p, { name: tag(m[3] || "", "name") })); }
  const imgs = wpt.filter(w => w.name && /\.(jpe?g|tiff?|dng)$/i.test(w.name));
  L.exposures = imgs.map((w, k) => ({ n: k + 1, name: w.name, t: w.t, lat: w.lat, lon: w.lon, h: w.h, q: "log" }));
  for (const p of L.trajectory) span(L, p.t); for (const e of L.exposures) span(L, e.t);
  const ver = /<gpx[^>]*\bversion\s*=\s*["']([\d.]+)/.exec(s), cr = /<gpx[^>]*\bcreator\s*=\s*["']([^"']*)/.exec(s);
  L.device.make = cr ? cr[1] : null; L.timeSource = L.startMs != null ? "GPX <time> (UTC)" : null;
  fact(L, "fFormat", "GPX " + (ver ? ver[1] : "")); fact(L, "fProgram", cr && cr[1]);
  fact(L, "fPoints", "trkpt " + cnt.trkpt + " · rtept " + cnt.rtept + " · wpt " + cnt.wpt + (imgs.length ? " (" + imgs.length + " images)" : ""));
  fact(L, "fHeight", L.trajectory.length || imgs.length ? "<ele>: usually above mean sea level (GPX does not define the datum)" : null);
}

/* ---------------------------------------------------------------- CSV / TXT geotags from processing software (Pix4D, Metashape, Emlid Studio, eMotion, own exports)
   Columns are found by name; the delimiter (, ; tab) is detected; projected coordinates are recognised and not converted. */
const CSV_COL = {
  name: /^(label|image ?name|imagename|image|file ?name|filename|photo|photo ?name|name|camera|#?label)$/,
  lat: /^(lat|latitude|y\/latitude|gps ?lat(itude)?|latitude ?\(?deg.*|lat ?\(?deg.*|lat_deg)$/,
  lon: /^(lon|lng|long|longitude|x\/longitude|gps ?lon(gitude)?|longitude ?\(?deg.*|lon ?\(?deg.*|lon_deg)$/,
  h: /^(alt|altitude|height|ele|elevation|h|z|z\/altitude|ellipsoidal ?height|alt(itude)? ?\(?m.*|height ?\(?m.*|h_m|altitude_wgs84|gps ?alt(itude)?)$/,
  sH: /^(accuracy ?(xy|horizontal|h)|acc(uracy)?_?xy|sigma ?(xy|h)|horizontal ?accuracy|h_?acc|std ?(xy|horizontal)|sigma_h(_m)?|x\/y ?accuracy)$/,
  sV: /^(accuracy ?(z|vertical|v)|acc(uracy)?_?z|sigma ?(z|v)|vertical ?accuracy|v_?acc|std ?(z|vertical)|sigma_v(_m)?|z ?accuracy)$/,
  t: /^(time|timestamp|utc|time ?utc|time_utc|gps ?time|datetime|date ?time|date_time)$/,
  q: /^(solution|quality|q|fix|status|rtk ?status|solution ?status)$/
};
function csvSplit(line, d) { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === d) { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out.map(x => x.trim()); }
const csvDelim = l => [",", ";", "\t"].sort((a, b) => l.split(b).length - l.split(a).length)[0];
const csvCols = (l, d) => csvSplit(l, d).map(c => c.toLowerCase().replace(/\s*\[[^\]]*\]\s*/g, "").replace(/\s+/g, " ").trim());
// map: { lat, lon, name?, t?, h? } column names assigned by the user; without it columns are found by name
function csvHeader(s, map) {
  const lines = s.split(/\r?\n/).slice(0, 30);
  for (let i = 0; i < lines.length; i++) { const l = lines[i].replace(/^\uFEFF/, "").replace(/^#\s*(?=label|name|image)/i, ""); if (!l.trim() || /^#/.test(l)) continue;
    const d = csvDelim(l), cols = csvCols(l, d);
    const idx = {}; for (const k in CSV_COL) idx[k] = map ? (map[k] != null ? cols.indexOf(map[k]) : -1) : cols.findIndex(c => CSV_COL[k].test(c));
    if (idx.lat >= 0 && idx.lon >= 0) return { line: i, d, idx, cols };
    return null; }
  return null;
}
// a CSV whose column names are not recognised, but whose first data row has at least two values that look like degrees (5+ decimals):
// its columns are offered for assignment by hand (guess: the first two such columns as latitude and longitude)
function csvColumns(s) {
  const lines = s.split(/\r?\n/).slice(0, 30); let H = null;
  for (let i = 0; i < lines.length; i++) { const l = lines[i].replace(/^\uFEFF/, ""); if (!l.trim() || /^#/.test(l)) continue;
    if (!H) { const d = csvDelim(l), cols = csvCols(l, d); if (cols.length < 2) return null; H = { line: i, d, cols }; continue; }
    const deg = csvSplit(l, H.d).map((v, k) => /^-?\d{1,3}[.,]\d{5,}$/.test(v) ? k : -1).filter(k => k >= 0);
    if (deg.length < 2) return null; H.guess = { lat: deg[0], lon: deg[1] }; return H; }
  return null;
}
async function pCSVCols(src, L) {
  const H = csvColumns(await text(src)); if (!H) return;
  L.csv = { cols: H.cols, guess: H.guess }; L.notes.push("csv-unmapped");
  fact(L, "fFormat", "CSV, coordinate columns not recognised by name"); fact(L, "fColumns", H.cols.join(", "));
}
async function pCSV(src, L, h, o) {
  const map = o && o.csvMap, s = await text(src), H = csvHeader(s, map); if (!H) return; if (map) L.notes.push("csv-mapped"); const { d, idx } = H; let proj = 0, row = 0;
  const num = v => { if (v == null || v === "") return null; const x = +String(v).replace(d === ";" ? "," : /(?!)/, "."); return isFinite(x) ? x : null; };
  s.split(/\r?\n/).slice(H.line + 1).forEach(l => { if (!l.trim() || /^#/.test(l)) return; const p = csvSplit(l, d); row++;
    const lat = num(p[idx.lat]), lon = num(p[idx.lon]); if (lat == null || lon == null) return; if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { proj++; return; }
    const tq = idx.q >= 0 ? String(p[idx.q] || "").toLowerCase() : "", t = idx.t >= 0 && p[idx.t] ? Date.parse(String(p[idx.t]).replace(" ", "T").replace(/(\d\d:\d\d:\d\d(\.\d+)?)$/, "$1Z")) : null;
    L.exposures.push({ n: L.exposures.length + 1, name: idx.name >= 0 ? p[idx.name] || null : null, t: isNaN(t) ? null : t, lat, lon, h: idx.h >= 0 ? num(p[idx.h]) : null, sH: idx.sH >= 0 ? num(p[idx.sH]) : null, sV: idx.sV >= 0 ? num(p[idx.sV]) : null,
      q: /fix/.test(tq) ? "fixed" : /float/.test(tq) ? "float" : /single|autonom|3d/.test(tq) ? "single" : /ppk/.test(tq) ? "ppk" : "log" }); });
  for (const e of L.exposures) span(L, e.t); if (L.startMs != null) L.timeSource = "time column (read as UTC)";
  if (proj) L.notes.push("csv-projected");
  fact(L, "fFormat", "CSV geotags (" + ({ ",": "comma", ";": "semicolon", "\t": "tab" })[d] + ")"); fact(L, "fColumns", Object.entries(idx).filter(x => x[1] >= 0).map(([k, v]) => k + " = " + H.cols[v]).join(", ") + (map ? " (assigned by hand)" : ""));
  fact(L, "fImages", L.exposures.length); fact(L, "fProjected", proj || null);
  fact(L, "fHeight", idx.h >= 0 ? "column " + H.cols[idx.h] + ": datum not stated in the file" : null);
}


/* ---------------------------------------------------------------- DJI FlightRecord decoded to CSV by dji-log-parser (`dji-log --api-key … --csv`)
   FlightRecord v13+ is encrypted; its keys come from the DJI API with the user's own App Key, so decoding happens outside the browser.
   This reads the CSV that the open-source decoder writes (columns CUSTOM.*, OSD.*, BATTERY.*, HOME.*, DETAILS.*). */
async function pDjiCsv(src, L, h, o) {
  let cols = null, ix = {}, n = 0, warn = 0, prevPh = null, phOn = 0; const det = {}, bat = [], gpsN = [], warns = new Set(), shots = [], times = [];
  const g = (p, k) => ix[k] >= 0 ? p[ix[k]] : undefined, num = v => v != null && v !== "" && isFinite(+v) ? +v : null;
  await eachLine(src, l => {
    if (!l.trim()) return; const p = csvSplit(l.replace(/^﻿/, ""), ",");
    if (!cols) { cols = p; cols.forEach((c, i) => { ix[c] = i; }); return; } n++;
    const t = Date.parse(g(p, "CUSTOM.dateTime")), lat = num(g(p, "OSD.latitude")), lon = num(g(p, "OSD.longitude"));
    if (lat != null && Math.abs(lat) > 1e-6) L.trajectory.push({ t: isNaN(t) ? null : t, lat, lon, h: num(g(p, "OSD.altitude")), q: g(p, "OSD.isGPSUsed") === "true" ? "single" : "none" });
    if (!isNaN(t)) times.push(t);
    const ph = g(p, "CAMERA.isPhoto"); if (ph != null) { const on = ph === "true"; if (on) phOn++; if (prevPh === false && on) shots.push({ t: isNaN(t) ? null : t, lat, lon, hRel: num(g(p, "OSD.height")), pitch: num(g(p, "GIMBAL.pitch")), roll: num(g(p, "GIMBAL.roll")), yaw: num(g(p, "GIMBAL.yaw")) }); prevPh = on; }
    const b = num(g(p, "BATTERY.chargeLevel")); if (b != null) bat.push(b); const gn = num(g(p, "OSD.gpsNum")); if (gn != null) gpsN.push(gn);
    const w = g(p, "APP.warn"); if (w) { warn++; if (warns.size < 6) warns.add(w); }
    if (n === 1) for (const k of ["DETAILS.aircraftName", "DETAILS.aircraftSerial", "DETAILS.cameraSerial", "DETAILS.appPlatform", "DETAILS.appVersion", "DETAILS.totalTime", "DETAILS.totalDistance", "DETAILS.maxHeight", "DETAILS.photoNum", "OSD.droneType", "HOME.latitude", "HOME.longitude", "HOME.altitude"]) det[k] = g(p, k);
  }, o);
  // a few rows carry a nonsense date (seen: 2017 and 2043 in a 2026 flight); times more than 12 h from the median are dropped
  const tm = median(times), odd = tm == null ? 0 : times.filter(t => Math.abs(t - tm) > 432e5).length;
  for (const t of times) if (Math.abs(t - tm) <= 432e5) span(L, t);
  if (odd) { fact(L, "fTimesDropped", odd); for (const q of L.trajectory) if (q.t != null && Math.abs(q.t - tm) > 432e5) q.t = null; for (const e of shots) if (e.t != null && Math.abs(e.t - tm) > 432e5) e.t = null; }
  // exposures: rising edges of CAMERA.isPhoto (camera state is logged about once per second, so times are good to about ±1 s)
  // one shot can show as two edges about 1 s apart (the flag drops for one sample); merged when that brings the count closer to DETAILS.photoNum
  const pn = num(det["DETAILS.photoNum"]), merged = []; for (const e of shots) { const m = merged[merged.length - 1]; if (m && e.t != null && m.t != null && e.t - m.t < 1500) continue; merged.push(e); }
  const useM = pn ? Math.abs(merged.length - pn) < Math.abs(shots.length - pn) : false, sel = useM ? merged : shots;
  L.exposures = sel.filter(e => e.lat != null && Math.abs(e.lat) > 1e-6).map((e, i) => ({ n: i + 1, t: e.t, lat: e.lat, lon: e.lon, h: null, hRel: e.hRel, q: "single", pitch: e.pitch, roll: e.roll, yaw: e.yaw }));
  if (useM && shots.length !== merged.length) fact(L, "fShotsMerged", shots.length - merged.length);
  if (L.exposures.length) fact(L, "fShotTime", "CAMERA.isPhoto is logged about once per second: times within about ±1 s");
  if (pn && L.exposures.length < 0.9 * pn) { L.notes.push("shots-missed"); fact(L, "fShotsMissed", L.exposures.length + " / " + pn); }
  // some apps (seen with Mavic 3M, app platform 6) never set CAMERA.isPhoto; the shots are then in the camera's isDdrStoring flag, which the CSV of dji-log does not carry
  if (pn && !phOn) fact(L, "fShotFlag", "CAMERA.isPhoto never set: exposures are not in this CSV (rising edges of the camera record isDdrStoring match the photo count)");
  L.device.make = "DJI"; L.device.model = (det["DETAILS.aircraftName"] && !/^dji aircraft$/i.test(det["DETAILS.aircraftName"]) ? det["DETAILS.aircraftName"] : null) || det["OSD.droneType"] || null; L.device.serial = det["DETAILS.aircraftSerial"] || null; L.device.camera = det["DETAILS.cameraSerial"] || null;
  L.timeSource = L.startMs != null ? "CUSTOM.dateTime (UTC, from the decoded FlightRecord)" : null;
  fact(L, "fFormat", "DJI FlightRecord → CSV (dji-log-parser)"); fact(L, "fVehicle", [L.device.model, L.device.serial].filter(Boolean).join(" · ")); fact(L, "fCameraSerial", L.device.camera);
  fact(L, "fSoftware", [det["DETAILS.appPlatform"], det["DETAILS.appVersion"]].filter(Boolean).join(" ")); fact(L, "fFrames", n);
  fact(L, "fDuration", num(det["DETAILS.totalTime"]) != null ? (+det["DETAILS.totalTime"]).toFixed(0) + " s" : null); // totalDistance: metres from the iOS/Android apps, kilometres from platform 6 (named DJIFly by dji-log-parser); checked against the track length
  const pl = String(det["DETAILS.appPlatform"] || "").toLowerCase(), td = num(det["DETAILS.totalDistance"]), tdm = td == null ? null : /^(ios|android)$/.test(pl) ? td : pl === "djifly" ? td * 1000 : null;
  fact(L, "fDistance", tdm != null ? tdm.toFixed(0) + " m" : null);
  fact(L, "fMaxHeight", num(det["DETAILS.maxHeight"]) != null ? (+det["DETAILS.maxHeight"]).toFixed(1) + " m" : null); fact(L, "fPhotos", det["DETAILS.photoNum"]);
  fact(L, "fBattery", bat.length ? bat[0] + " → " + bat[bat.length - 1] + " %" : null); fact(L, "fSats", median(gpsN));
  fact(L, "fHome", num(det["HOME.latitude"]) ? (+det["HOME.latitude"]).toFixed(6) + ", " + (+det["HOME.longitude"]).toFixed(6) + (num(det["HOME.altitude"]) != null ? ", " + det["HOME.altitude"] + " m" : "") : null);
  fact(L, "fHeight", "OSD.altitude (DJI: barometric, relative to take-off reference), not ellipsoid"); fact(L, "fWarnings", warn ? warn + ": " + [...warns].join(" | ") : null);
  L.notes.push("height-amsl");
}

/* ---------------------------------------------------------------- DJI FlightRecord, binary (DJIFlightRecord_*.txt from DJI GO 4, DJI Pilot, Pix4Dcapture and other MSDK apps)
   Layout after the open-source dji-log-parser (MIT, github.com/lvauvillier/dji-log-parser): a 100-byte prefix (details offset u64,
   details length u16, version u8), records [type u8][length][data][0xFF] up to the details block. Versions 7–12 scramble each record
   with an 8-byte XOR key = CRC-64 (Jones, reflected) of 0x123456789ABCDEF0 × data[0], seeded with (data[0] + type) & 0xFF;
   versions 13+ add AES with keys from the DJI API (App Key of the user), so the browser reports them as encrypted.
   Record type 57 starts the JPEG thumbnails, which end the record stream. */
let DJIFR_T = null;
function djiFrKey(rt, first, cache) {
  const id = rt << 8 | first; let k = cache.get(id); if (k) return k;
  if (!DJIFR_T) { DJIFR_T = []; const P = 0x95AC9329AC4BC9B5n; for (let i = 0; i < 256; i++) { let c = BigInt(i); for (let j = 0; j < 8; j++) c = c & 1n ? (c >> 1n) ^ P : c >> 1n; DJIFR_T.push(c); } }
  let crc = BigInt((first + rt) & 0xff), v = (0x123456789ABCDEF0n * BigInt(first)) & 0xFFFFFFFFFFFFFFFFn;
  for (let i = 0; i < 8; i++) { const x = Number((v >> BigInt(8 * i)) & 0xffn); crc = DJIFR_T[Number((crc ^ BigInt(x)) & 0xffn)] ^ (crc >> 8n); }
  k = new Uint8Array(8); for (let i = 0; i < 8; i++) k[i] = Number((crc >> BigInt(8 * i)) & 0xffn); cache.set(id, k); return k;
}
const DJI_PRODUCT = { 0: "", 1: "Inspire 1", 2: "Phantom 3 Standard", 3: "Phantom 3 Advanced", 4: "Phantom 3 Professional", 5: "Osmo", 6: "Matrice 100", 7: "Phantom 4", 8: "LB2", 9: "Inspire 1 Pro", 10: "A3", 11: "Matrice 600", 12: "Phantom 3 4K", 13: "Mavic Pro", 14: "Zenmuse XT", 16: "N3", 17: "Inspire 2", 18: "Phantom 4 Pro", 20: "Spark", 23: "Matrice 600 Pro", 24: "Mavic Air", 25: "Matrice 200", 26: "Phantom 4 Advanced", 27: "Matrice 210", 28: "Phantom 3 SE", 29: "Matrice 210 RTK", 36: "Phantom 4 Pro V2", 38: "Mavic 2", 41: "Mavic 2 Enterprise", 44: "Phantom 4 RTK", 51: "Mavic 2 Enterprise Dual", 118: "Mavic 3 Enterprise series" };
async function pDjiFR(src, L, h) {
  L.device.make = "DJI";
  const size = sizeOf(src); if (size < 100) { fact(L, "fFormat", "DJI FlightRecord (truncated)"); L.notes.push("empty"); return; }
  const dv0 = new DataView(h.buffer, h.byteOffset, h.length), off = Number(dv0.getBigUint64(0, true)), dlen = dv0.getUint16(8, true), ver = h[10];
  fact(L, "fFormat", "DJI FlightRecord v" + ver);
  if (!(off > 100 && off <= size)) { L.notes.push("parse-error"); L.error = "details offset outside the file"; return; }
  const b = await slice(src, 0, size), dv = new DataView(b.buffer, b.byteOffset, b.length), cache = new Map(), xor = ver >= 7;
  // details block (layout of version 6+). Version 13+ keeps it in the first auxiliary block after the prefix
  // ([type 0][length u16][seed u8][XOR data]: version u8, info length u16, info), scrambled like a record of type 0; only the records use AES.
  let D = b.subarray(off, Math.min(size, off + dlen));
  if (ver >= 13) {
    D = new Uint8Array(0);
    if (b[100] === 0 && size > 104) { const al = dv.getUint16(101, true); if (al > 4 && 103 + al <= size) { const k = djiFrKey(0, b[103], cache), x = new Uint8Array(al - 1);
      for (let i = 0; i < x.length; i++) x[i] = b[104 + i] ^ k[i & 7]; const il = x[1] | x[2] << 8; if (il >= 380 && 3 + il <= x.length) D = x.subarray(3, 3 + il); } }
    L.encrypted = true; L.notes.push("encrypted");
    fact(L, "fNeedsKey", "DJI FlightRecord v13+: records are AES-encrypted (keys from the DJI API with your own App Key) → decode with dji-log-parser to CSV and load the CSV" + (D.length ? "; summary read from the unencrypted details" : ""));
  }
  const dd = new DataView(D.buffer, D.byteOffset, D.length), str = (a, n) => new TextDecoder("latin1").decode(D.subarray(a, a + n)).split("\0")[0].trim();
  const det = {};
  if (ver >= 6 && D.length >= 380) {
    det.city = str(40, 20); det.start = Number(dd.getBigInt64(91, true)); det.lon = dd.getFloat64(99, true); det.lat = dd.getFloat64(107, true);
    det.time = dd.getInt32(119, true) / 1000; det.maxH = dd.getFloat32(123, true); det.capture = dd.getInt32(135, true);
    det.takeoff = dd.getFloat32(267, true); det.product = D[271]; det.name = str(280, 32); det.sn = str(312, 16); det.camSn = str(328, 16); det.rcSn = str(344, 16); det.batSn = str(360, 16);
    det.plat = D[376]; det.dist = dd.getFloat32(115, true);
    det.app = ({ 1: "iOS", 2: "Android" }[D[376]] || (D[376] ? "platform " + D[376] + "," : "")) + " " + [D[377], D[378], D[379]].join(".");
  }
  if (ver >= 13) {                            // records stay encrypted: summary from the details only
    const nm = det.name && !/^dji aircraft$/i.test(det.name) ? det.name : null, model = nm || DJI_PRODUCT[det.product] || null;
    L.device.model = model; L.device.serial = det.sn || null; L.device.camera = det.camSn || null;
    if (det.start > 1e12) { span(L, det.start); if (det.time > 0) span(L, det.start + det.time * 1000); L.timeSource = "details start time (app clock)"; }
    fact(L, "fVehicle", [model, det.sn].filter(Boolean).join(" · ") || null); fact(L, "fCameraSerial", det.camSn || null);
    fact(L, "fSoftware", det.app && det.app.trim() !== "0.0.0" ? det.app.trim() : null);
    fact(L, "fDuration", det.time > 0 ? det.time.toFixed(0) + " s" : null); fact(L, "fMaxHeight", det.maxH > 0 ? det.maxH.toFixed(1) + " m" : null);
    fact(L, "fPhotos", det.capture > 0 ? det.capture : null);
    // total distance: metres for the iOS/Android apps, kilometres for platform 6 (both checked against the track length of decoded logs); other platforms are left out
    const dm = det.plat === 1 || det.plat === 2 ? det.dist : det.plat === 6 ? det.dist * 1000 : null;
    fact(L, "fDistance", dm > 0 ? dm.toFixed(0) + " m" : null);
    fact(L, "fHome", isFinite(det.lat) && Math.abs(det.lat) > 1e-6 ? det.lat.toFixed(6) + ", " + det.lon.toFixed(6) + (det.city && !/^map loading$/i.test(det.city) ? " (" + det.city + ")" : "") : null);
    return;
  }
  // records
  let p = 100, n = 0, bad = null, osd = null, gim = null, ts = null, remain = null, prevShoot = null, sats = [], bat = [], pts = [];
  const byRemain = [], byShoot = [], counts = {};
  while (p + 3 < off) {
    const rt = b[p], len = b[p + 1], s = p + 2;
    if (rt === 57) break;                       // JPEG thumbnails follow
    if (s + len >= off || b[s + len] !== 0xff) { bad = p; break; }
    let d;
    if (xor) { if (!len) { p = s + len + 1; continue; } const k = djiFrKey(rt, b[s], cache); d = new Uint8Array(len - 1); for (let i = 1; i < len; i++) d[i - 1] = b[s + i] ^ k[(i - 1) & 7]; }
    else d = b.subarray(s, s + len);
    const q = new DataView(d.buffer, d.byteOffset, d.length); n++; counts[rt] = (counts[rt] || 0) + 1;
    if (rt === 1 && d.length >= 44) {          // OSD
      const lon = q.getFloat64(0, true) * R2D, lat = q.getFloat64(8, true) * R2D, hr = q.getInt16(16, true) / 10;
      osd = { lat, lon, hr }; sats.push(d[36]);                                  // gps_num
      if (Math.abs(lat) > 1e-6 || Math.abs(lon) > 1e-6) pts.push({ t: ts, lat, lon, h: null, q: "single" });
    } else if (rt === 3 && d.length >= 6) gim = { pitch: q.getInt16(0, true) / 10, roll: q.getInt16(2, true) / 10, yaw: q.getInt16(4, true) / 10 };
    else if (rt === 5 && d.length >= 18) { const t = Number(q.getBigInt64(10, true)); if (t > 1e12) { ts = t; span(L, t); }
      const cs = d[0]; if (prevShoot != null && cs && !prevShoot) byShoot.push({ t: ts, o: osd, g: gim }); prevShoot = cs; }   // Custom.camera_shoot rising edge
    else if (rt === 8 && d.length >= 27) { const lv = d[26]; if (lv <= 100) bat.push(lv); }   // SmartBattery: charge %
    else if (rt === 25 && d.length >= 17) { const r = q.getUint32(13, true); if (remain != null && r < remain && remain - r <= 3) byRemain.push({ t: ts, o: osd, g: gim }); remain = r; }   // remaining-photo counter drops
    p = s + len + 1;
  }
  if (bad != null) { L.notes.push("partial"); fact(L, "fStopped", bad + " / " + off + " B"); }
  L.trajectory = pts;
  // two signals for a shot; which one works depends on the app (Pix4Dcapture: camera_shoot; DJI GO 4: only the counter). With the capture count from the details, the closer one wins.
  const cap = det.capture > 0 ? det.capture : null; let shots, how;
  if (cap) [shots, how] = Math.abs(byShoot.length - cap) <= Math.abs(byRemain.length - cap) ? [byShoot, "shoot"] : [byRemain, "remain"];
  else [shots, how] = byShoot.length ? [byShoot, "shoot"] : [byRemain, "remain"];
  L.exposures = shots.map((x, i) => ({ n: i + 1, t: x.t, lat: x.o ? x.o.lat : null, lon: x.o ? x.o.lon : null, h: null, hRel: x.o ? x.o.hr : null, q: "single",
    pitch: x.g ? x.g.pitch : null, roll: x.g ? x.g.roll : null, yaw: x.g ? x.g.yaw : null }));
  const model = det.name || DJI_PRODUCT[det.product] || null;
  L.device.model = model; L.device.serial = det.sn || null; L.device.camera = det.camSn || null;
  if (L.startMs == null && det.start > 1e12) span(L, det.start);
  L.timeSource = ts != null ? "CUSTOM.update_timestamp (clock of the phone or tablet running the app)" : det.start ? "details start time (app clock)" : null;
  fact(L, "fVehicle", [model, det.sn].filter(Boolean).join(" · ")); fact(L, "fCameraSerial", det.camSn);
  fact(L, "fSoftware", det.app && det.app.trim() !== "0.0.0" ? det.app.trim() : null); fact(L, "fFrames", n);
  fact(L, "fDuration", det.time > 0 ? det.time.toFixed(0) + " s" : null); fact(L, "fMaxHeight", det.maxH > 0 ? det.maxH.toFixed(1) + " m" : null);
  fact(L, "fPhotos", shots.length ? shots.length + (how === "shoot" ? " (camera shoot flag)" : " (from the camera's remaining-photo counter)") + (cap ? "; DJI capture count " + cap : "") : cap);
  if (shots.length) fact(L, "fShotTime", "app record rate (about 10 Hz for OSD, camera state slower): times within about ±1 s");
  fact(L, "fBattery", bat.length ? bat[0] + " → " + bat[bat.length - 1] + " %" : null); fact(L, "fSats", median(sats));
  fact(L, "fHome", isFinite(det.lat) && Math.abs(det.lat) > 1e-6 ? det.lat.toFixed(6) + ", " + det.lon.toFixed(6) + (det.city && !/^map loading$/i.test(det.city) ? " (" + det.city + ")" : "") : null);
  fact(L, "fHeight", "OSD height (DJI: barometric, relative to take-off), not ellipsoid; exposures carry it as hRel");
  L.notes.push("height-amsl");
}

/* ---------------------------------------------------------------- senseFly eMotion console transcript (<drone>_transcript_<n>.txt, eBee Classic / Plus)
   Lines "hh:mm:ss : message" in the clock of the ground-station PC; the session header gives the same moment in local time and UTC,
   so the offset is taken from it. "Taking photo #n" marks a trigger command (1 s resolution, no position). */
async function pEmTranscript(src, L, h, o) {
  let day = null, off = 0, prevS = null, dayAdd = 0, n = 0, rep = 0, robot = "", iface = "", climb = [], warn = new Map(), ev = {};
  const shots = new Map(), mark = (k, t) => { if (ev[k] == null) ev[k] = t; };
  await eachLine(src, l => {
    const m = /^(\d\d):(\d\d):(\d\d) : (.*)$/.exec(l.replace(/\r$/, "")); if (!m) return; n++;
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3], msg = m[4];
    const hd = /=== New session : .* (\d\d):(\d\d):(\d\d) \d{4} \(UTC (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\)/.exec(msg);
    if (hd) { const utc = Date.UTC(+hd[4], +hd[5] - 1, +hd[6], +hd[7], +hd[8], +hd[9]); let d = (+hd[1] * 3600 + +hd[2] * 60 + +hd[3]) - (+hd[7] * 3600 + +hd[8] * 60 + +hd[9]); if (d > 43200) d -= 86400; if (d < -43200) d += 86400;
      off = d; day = Date.UTC(+hd[4], +hd[5] - 1, +hd[6]); dayAdd = 0; prevS = s; }
    if (prevS != null && s < prevS - 3600) dayAdd += 86400; prevS = s;
    const t = day != null ? day + (s + dayAdd - off) * 1000 : null; span(L, t);
    let x;
    if ((x = /^Robot (\S+) created from interface (\S+)(?: \((\w+)\))?/.exec(msg))) { robot = x[1]; iface = x[2] + (x[3] ? " (" + x[3] + ")" : ""); }
    else if ((x = /^Taking photo #(\d+)/.exec(msg))) { const k = +x[1]; if (shots.has(k)) rep++; shots.set(k, t); }   // a repeated number keeps the time of the last command
    else if ((x = /^(Climbing|Descending) to (-?\d+) m\/ATO/.exec(msg))) climb.push(+x[2]);
    else if (/^Taking off/.test(msg)) mark("takeoff", t); else if (/^Touching down|^Landed/.test(msg)) mark("landing", t);
    else if (/^(Poor GPS coverage|Data downlink lost|Ground proximity not detected|Drone not horizontal|Low battery|Strong wind)/.test(msg)) { const k = msg.replace(/\s*\(.*$/, ""); warn.set(k, (warn.get(k) || 0) + 1); }
  }, o);
  const list = [...shots.entries()].sort((a, b) => a[0] - b[0]);
  L.exposures = list.map(([photo, t], i) => ({ n: i + 1, photo, t, lat: null, lon: null, h: null, q: null }));
  L.device.make = "senseFly"; L.device.model = /^eBee_EB-/.test(iface) ? "eBee" : /^eBee_EP-/.test(iface) ? "eBee Plus" : null; L.device.serial = (/_(E[BP]-\d\d-\d+)/.exec(iface) || [])[1] || null;
  L.timeSource = day != null ? "ground-station PC clock, converted to UTC with the session header" + (off ? " (offset " + (off / 3600) + " h)" : "") : null;
  fact(L, "fFormat", "eMotion console transcript"); fact(L, "fVehicle", [L.device.model, L.device.serial].filter(Boolean).join(" · ")); fact(L, "fFrames", n);
  fact(L, "fPhotos", list.length ? list.length + " photo numbers" + (rep ? " (" + rep + " commands repeated a number; the last one is kept)" : "") + "; no positions in this file" : null);
  fact(L, "fFlight", ev.takeoff != null && ev.landing != null ? iso(ev.takeoff).slice(11, 19) + " – " + iso(ev.landing).slice(11, 19) + " UTC (" + Math.round((ev.landing - ev.takeoff) / 1000) + " s)" : null);
  fact(L, "fMaxHeight", climb.length ? Math.max(...climb) + " m above take-off (planned)" : null);
  fact(L, "fWarnings", warn.size ? [...warn].map(([a, b]) => a + (b > 1 ? " ×" + b : "")).join(" | ") : null);
  if (day == null) L.notes.push("no-date");
  L.notes.push("exposures-no-position");
}

/* ---------------------------------------------------------------- senseFly eBee X payload/computer debug log (log_<n>.txt, "afpu")
   Lines "YYYYMMDD-hhmmss.sssZ:LEVEL module: text". The clock starts at 1970 and is set from GNSS during the session
   ("System date/time set to …"); lines before that have no usable date. Read here: firmware, flight session (name of the .bb3/.bbz logs),
   payload and serial numbers, the thermal camera calibration written to XMP, and the time synchronisation. */
async function pAfpu(src, L, h, o) {
  let n = 0, fw = "", session = [], payload = new Set(), serial = new Set(), units = {}, calib = {}, sync = null, ignored = 0, warns = 0, errs = 0, hw = "";
  await eachLine(src, l => {
    const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.(\d{3})Z:(DBG|INFO|WRN|ERR|CRIT|FATAL) ([^:]*): ?(.*)$/.exec(l.replace(/\r$/, "")); if (!m) return; n++;
    const y = +m[1], t = Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]), msg = m[10];
    if (y >= 2000) span(L, t);
    if (/^pm\.cam\.soda$/.test(m[9])) payload.add("S.O.D.A."); else if (/^flir\./.test(m[9])) payload.add("FLIR thermal");
    if (m[8] === "WRN") warns++; else if (m[8] === "ERR" || m[8] === "CRIT" || m[8] === "FATAL") errs++;
    let x;
    if ((x = /^FW version: (.+)$/.exec(msg))) fw = x[1].trim();
    else if ((x = /^Hardware revision is (\S+)/.exec(msg))) hw = x[1];
    else if ((x = /^Starting new flight session "([^"]+)"/.exec(msg))) session.push(x[1]);
    else if ((x = /payload detected: "([^"]+)"/.exec(msg))) payload.add(x[1]);
    else if ((x = /Firmware changed: "([^"]+)" btld: "([^"]*)" fw: "([^"]*)"/.exec(msg))) units[x[1]] = x[3].trim();
    else if ((x = /does not need update \w+ (\S+) (\S+)/.exec(msg)) && /"(\w+)"/.test(msg)) { const u = /"(\w+)"/.exec(msg)[1]; if (!units[u]) units[u] = ""; }
    else if ((x = /Serial number:\s*([\w-]+)/.exec(m[9] + ": " + msg))) serial.add(x[1]);
    else if ((x = /"serialNumber\\?":\\?"([^"\\]+)/.exec(msg))) serial.add(x[1]);
    else if ((x = /found XMP tag :\s+Xmp\.Camera\.(\w+)\s+=\s+(.+)$/.exec(msg))) calib[x[1]] = x[2].trim();
    else if ((x = /System date\/time set to\s+QDateTime\((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?) UTC/.exec(msg))) { if (!sync) sync = x[1]; }
    else if (/Ignoring UTC time from AP/.test(msg)) ignored++;
  }, o);
  L.device.make = "senseFly"; L.device.model = session.length && /^IX-/.test(session[0]) ? "eBee X" : null; L.device.serial = session.length ? session[0].replace(/_\d+$/, "") : null; L.device.fw = fw || null;
  L.timeSource = sync ? "payload computer clock, set from GNSS at " + sync + " UTC" : null;
  fact(L, "fFormat", "eBee X payload computer log (afpu)"); fact(L, "fVehicle", [L.device.model, L.device.serial].filter(Boolean).join(" · ")); fact(L, "fFirmware", fw + (hw ? " (HW " + hw + ")" : ""));
  fact(L, "fSession", session.join(", ")); fact(L, "fPayload", [...payload].join(", ")); fact(L, "fSerials", [...serial].join(", "));
  fact(L, "fUnits", Object.keys(units).length ? Object.entries(units).map(([a, b]) => a + (b ? " " + b : "")).join(", ") : null);
  fact(L, "fThermCalib", Object.keys(calib).length ? Object.entries(calib).map(([a, b]) => a + " = " + b).join("; ") : null);
  fact(L, "fTimeSync", sync ? sync + " UTC" + (ignored ? " (" + ignored + "× UTC from the autopilot ignored, too close to the time pulse)" : "") : "not in this file (clock still at 1970)");
  fact(L, "fFrames", n); fact(L, "fLogLevels", warns + " warnings, " + errs + " errors");
  if (Object.keys(calib).length) L.calib = calib;
  L.notes.push("no-positions");
}

/* ---------------------------------------------------------------- Pix4Dcapture app log (com.pix4d.pix4dmapper.capture <date>--<time>-<ms>.log, iOS)
   Lines "YYYY-MM-DD hh:mm:ss [level]…" in the device's local time; the file name carries the same start in UTC, which gives the offset.
   The log holds the app version, the connected drone and camera, the mission types opened and the app's stored settings per mission type
   (overlaps, camera angle). Those settings are the defaults the app keeps, not necessarily the plan that was flown. */
async function pP4dCaptureLog(src, L, h, o) {
  let n = 0, ver = "", first = null, last = null, drone = "", cam = "", intended = "", types = [], sect = null, depth = 0, cur = null, settings = {}, errs = 0;
  await eachLine(src, l => {
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[(\w)\]/.exec(l);
    if (m) { n++; const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); if (first == null) first = t; last = t; if (m[7] === "E") errs++; sect = null; }
    let x;
    if ((x = /\*\*\* Pix4Dcapture version ([\w.()]+) \*\*\*/.exec(l))) ver = x[1];
    else if ((x = /Drone model correction, overriding the specs\. Intended: (.+), Actual: (.+)$/.exec(l))) { intended = x[1].trim(); drone = x[2].trim(); }
    else if ((x = /setSelectedDroneModel: ([^,]+),/.exec(l))) drone = x[1].trim();
    else if ((x = /camera name is (.+) is connected/.exec(l))) cam = x[1].trim();
    else if (!drone && (x = /drone:(.+?) framework:/.exec(l))) drone = x[1].trim();
    else if ((x = /\*{6} (GRID|DOUBLE GRID|POLYGON|CIRCULAR|FREE FLIGHT|ELLIPSE|CORRIDOR)\b/i.exec(l))) { if (!types.includes(x[1])) types.push(x[1]); }
    // settings dictionary (NSDictionary description): settingsMissionAuto<Type> = { "key" = value; … };
    if ((x = /^\s*settingsMissionAuto(\w+) =\s+\{/.exec(l))) { cur = x[1]; settings[cur] = {}; return; }
    if (cur) { if (/^\s*\};/.test(l)) { cur = null; return; } if ((x = /^\s*"?([\w ]+)"? = "?([^";]*)"?;/.exec(l))) settings[cur][x[1]] = x[2]; }
  }, o);
  const fm = /(\d{4})-(\d\d)-(\d\d)--(\d\d)-(\d\d)-(\d\d)-\d+\.log$/.exec(L.name || "");
  let off = null; if (fm && first != null) { const u = Date.UTC(+fm[1], +fm[2] - 1, +fm[3], +fm[4], +fm[5], +fm[6]); off = Math.round((first - u) / 900000) * 900000; if (Math.abs(off) > 14 * 3600000) off = null; }
  if (off != null) { span(L, first - off); span(L, last - off); }
  L.device.make = drone ? "DJI" : null; L.device.model = drone || null; L.device.camera = cam || null; L.device.fw = ver || null;
  L.timeSource = off != null ? "device local time, converted to UTC with the start time in the file name (offset " + (off >= 0 ? "+" : "") + off / 3600000 + " h)" : null;
  fact(L, "fFormat", "Pix4Dcapture app log"); fact(L, "fSoftware", ver ? "Pix4Dcapture " + ver : null); fact(L, "fVehicle", drone + (intended && intended !== drone ? " (selected in the app: " + intended + ")" : ""));
  fact(L, "fCamera", cam); fact(L, "fMission", types.join(", "));
  const show = Object.entries(settings).filter(([k]) => !types.length || types.some(t => t.replace(/\s/g, "").toLowerCase() === k.toLowerCase())).map(([k, s]) => k + ": " + ["grid_overlap", "side_overlap", "camera_angle", "speed_level"].filter(q => s[q] != null).map(q => q + " " + s[q]).join(", ")).filter(s => /\d/.test(s));
  fact(L, "fAppSettings", show.length ? show.join(" | ") + " (app defaults, not necessarily the flown plan)" : null);
  fact(L, "fFrames", n); if (errs) fact(L, "fLogLevels", errs + " errors");
  L.notes.push("no-positions");
}

/* ---------------------------------------------------------------- senseFly eBee X flight archive (.bbz)
   A ZIP with stored (uncompressed) members: syslog, version, skynet.zip.gpg (encrypted), log_<n>.txt (payload computer log)
   and one .bb3 per onboard device (<session>_1.bb3 = autopilot with the GNSS stream; _8, _10, _15, _43, _45 other devices).
   Read through the local file headers, so an archive still being written (no central directory) is read as far as it goes. */
const subSrc = (src, a, b) => isBlob(src) ? src.slice(a, b) : src.subarray(a, Math.min(b, src.length));
async function pBBZ(src, L, h, o) {
  const size = sizeOf(src), mem = []; let p = 0, cut = false;
  while (p + 30 <= size) {
    const hd = await slice(src, p, p + 30), dv = new DataView(hd.buffer, hd.byteOffset, 30);
    if (dv.getUint32(0, true) !== 0x04034b50) break;
    const flags = dv.getUint16(6, true), method = dv.getUint16(8, true), cs = dv.getUint32(18, true), nl = dv.getUint16(26, true), xl = dv.getUint16(28, true);
    const name = new TextDecoder().decode(await slice(src, p + 30, p + 30 + nl)), a = p + 30 + nl + xl;
    if (flags & 8 && !cs) { mem.push({ name, method, a, n: null }); cut = true; break; }   // size only in a trailing descriptor
    if (a + cs > size) { mem.push({ name, method, a, n: size - a, cut: true }); cut = true; break; }
    mem.push({ name, method, a, n: cs }); p = a + cs;
  }
  const ok = m => m.method === 0 && m.n != null;
  const bb3 = mem.filter(m => /\.bb3$/i.test(m.name) && ok(m)).sort((x, y) => (/_1\.bb3$/.test(y.name) - /_1\.bb3$/.test(x.name)) || y.n - x.n)[0];
  if (bb3) { const s = subSrc(src, bb3.a, bb3.a + bb3.n); await pBB3(s, L, await slice(s, 0, 65536), o); }
  L.kind = "bbz";
  const lg = mem.find(m => /^log_\d+\.txt$/.test(m.name) && ok(m));
  if (lg) { const A = newLog("ebeex-afpu", lg.name, lg.n); await pAfpu(subSrc(src, lg.a, lg.a + lg.n), A, null, {});
    for (const k of ["fSession", "fPayload", "fSerials", "fUnits", "fThermCalib", "fTimeSync"]) { const f = A.facts.find(x => x[0] === k); if (f) fact(L, k, f[1]); }
    if (!L.device.fw && A.device.fw) L.device.fw = A.device.fw; if (A.calib) L.calib = A.calib; }
  const ver = mem.find(m => m.name === "version" && ok(m));
  if (ver) { const t = new TextDecoder().decode(await slice(src, ver.a, ver.a + Math.min(ver.n, 4096))), v = /Build version\s*:\s*(\S+)/.exec(t), d = /Build date\s*:\s*(.+)/.exec(t); fact(L, "fBuild", v ? v[1] + (d ? " (" + d[1].trim() + ")" : "") : null); }
  fact(L, "fArchive", mem.map(m => m.name + (m.n != null ? " " + (m.n / 1048576).toFixed(1) + " MB" : "") + (m.method ? " [compressed, not read]" : "") + (/\.gpg$/i.test(m.name) ? " [encrypted]" : "") + (m.cut ? " [cut]" : "")).join(", "));
  if (cut) L.notes.push("archive-cut");
  if (!bb3) L.notes.push("bbz-no-bb3");
}

/* ---------------------------------------------------------------- Pix4Dcapture mission (Mission<n>/mission.pix4dcapture-mission, lastMissionPlan_*.pix4dcapture-mission-plan; JSON)
   The flight plan: mission type, overlaps, altitude above take-off, camera pitch (Pix4D: 90 = nadir), trigger type, survey region,
   the planned waypoints and the camera model. Who created or changed the mission (e-mail in metaData) is personal data and is not read. */
async function pP4dMission(src, L, h, o) {
  const j = JSON.parse(new TextDecoder().decode(await slice(src, 0, sizeOf(src)))), mp = j.missionPlan || j, cd = j.captureDevice || {}, cam = cd.camera || {}, cp = cam.parameters || {};
  const num = v => typeof v === "number" && isFinite(v) ? v : null, pct = v => num(v) != null ? Math.round(v <= 1 ? v * 100 : v) : null;
  const type = mp.missionType || null, alt = num(mp.altitude), pitch = num(mp.cameraPitch);
  const gsd = alt != null && num(cp.sensorWidth) && num(cp.focalLength) && num(cp.imageWidth) ? alt * cp.sensorWidth / cp.focalLength / cp.imageWidth * 100 : null;
  const wps = ((j.flightPlan || {}).waypoints || []).filter(w => Array.isArray(w.location) && w.location.length >= 2);
  L.plan = { software: j.appInfo && j.appInfo.version ? "Pix4Dcapture " + String(j.appInfo.version).replace(/^iOS-|^Android-/, "") + (/^iOS/.test(j.appInfo.version) ? " (iOS)" : /^Android/.test(j.appInfo.version) ? " (Android)" : "") : "Pix4Dcapture",
    type, pattern: { Grid: "single_grid", DoubleGrid: "double_grid", "Double Grid": "double_grid", Polygon: "single_grid", Circular: "circular", Corridor: "linear", FreeFlight: "manual", Free: "manual" }[type] || null,
    agl: alt, front: pct(mp.frontOverlap), side: pct(mp.sideOverlap), gimbalPitch: pitch != null ? -pitch : null, gsd: gsd != null ? +gsd.toFixed(2) : null, trigger: mp.photoTriggerType || null,
    photos: j.expected && num(j.expected.photoCount), flightTime: j.expected && num(j.expected.flightTime),
    region: mp.surveyRegion ? { type: mp.surveyRegion.regionType || null, width: num((mp.surveyRegion.size || {}).width), height: num((mp.surveyRegion.size || {}).height), rotation: num(mp.surveyRegion.rotation) } : null,
    waypoints: wps.map(w => ({ lon: w.location[0], lat: w.location[1], h: num(w.location[2]), photo: (w.flags || []).includes("TakePhoto") })) };
  L.device.make = cd.vendor || null; L.device.model = cd.name || null; L.device.camera = cam.name || null; L.device.fw = j.appInfo && j.appInfo.version || null;
  const ts = Date.parse((j.metaData || {}).createdAt); if (isFinite(ts)) L.planCreated = ts;
  fact(L, "fFormat", j.missionPlan ? "Pix4Dcapture mission" : "Pix4Dcapture mission plan (last used settings)"); fact(L, "fSoftware", L.plan.software); fact(L, "fVehicle", cd.name);
  fact(L, "fCamera", cam.name ? cam.name + (cp.focalLength ? " · f " + cp.focalLength + " mm" : "") + (cp.imageWidth ? " · " + cp.imageWidth + " × " + cp.imageHeight + " px" : "") + (cp.sensorWidth ? " · sensor " + cp.sensorWidth + " mm" : "") : null);
  fact(L, "fMission", type); fact(L, "fPlanAgl", alt != null ? alt + " m above take-off" : null);
  fact(L, "fPlanOverlap", L.plan.front != null || L.plan.side != null ? (L.plan.front != null ? L.plan.front : "–") + " / " + (L.plan.side != null ? L.plan.side : "–") + " %" : null);
  fact(L, "fPlanPitch", pitch != null ? pitch + "° (Pix4D, 90 = nadir) = gimbal " + (-pitch) + "°" : null); fact(L, "fPlanGsd", gsd != null ? gsd.toFixed(2) + " cm (from altitude and camera)" : null);
  fact(L, "fPlanTrigger", L.plan.trigger); fact(L, "fPlanPhotos", L.plan.photos); fact(L, "fPlanTime", L.plan.flightTime ? Math.round(L.plan.flightTime) + " s" : null);
  fact(L, "fPlanRegion", L.plan.region && L.plan.region.width ? L.plan.region.type + " " + L.plan.region.width.toFixed(0) + " × " + L.plan.region.height.toFixed(0) + " m, rotation " + (L.plan.region.rotation || 0).toFixed(1) + "°" : null);
  fact(L, "fPlanWaypoints", wps.length || null);
  L.notes.push("plan");
}

/* ---------------------------------------------------------------- senseFly eBee / eBee Plus autopilot black box (.bbx, eMotion 2)
   Self-describing: the first record (id 0xFFFF) declares groups (id u16, name, members: type u8, name, count u16); every record is
   [1E 8A 9A 5E][group u16][time u32][u16][payload][u16]. Member types: 0 i8, 1 u8 (char[] when count > 1), 2 i16, 3 u16, 4 i32, 5 u32,
   6 i64 (degrees × 1e14), 7 u64, 8 f32. Read here: identification, u-blox position (NAV-POSLLH), GPS time, take-off altitude and the
   photo tags (cam_PhotoTag_bb: UTC, position, WGS 84 height, accuracy, attitude). */
const BBX_MAGIC = [0x1e, 0x8a, 0x9a, 0x5e], BBX_SZ = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 8, 7: 8, 8: 4 };
async function pBBX(src, L, h, o) {
  const b = await slice(src, 0, sizeOf(src)), dv = new DataView(b.buffer, b.byteOffset, b.length), isM = p => p + 4 <= b.length && b[p] === 0x1e && b[p + 1] === 0x8a && b[p + 2] === 0x9a && b[p + 3] === 0x5e;
  if (!isM(0) || dv.getUint16(4, true) !== 0xffff) { L.notes.push("undocumented"); fact(L, "fFormat", "senseFly .bbx (header not recognised)"); return; }
  const G = {}, ng = dv.getUint16(12, true), td = new TextDecoder("latin1"); let p = 14;
  for (let g = 0; g < ng && p < b.length; g++) {
    const id = dv.getUint16(p, true), nl = b[p + 2], name = td.decode(b.subarray(p + 3, p + 3 + nl)); p += 3 + nl;
    const nm = dv.getUint16(p, true); p += 2; const mem = []; let off = 0;
    for (let k = 0; k < nm; k++) { const ty = b[p], l = b[p + 1], mn = td.decode(b.subarray(p + 2, p + 2 + l)); p += 2 + l; const c = dv.getUint16(p, true); p += 2; mem.push({ mn, ty, c, off }); off += (BBX_SZ[ty] || 0) * c; }
    G[id] = { name, mem, size: off, by: Object.fromEntries(mem.map(m => [m.mn, m])) };
  }
  const byName = {}; for (const id in G) byName[G[id].name] = +id;
  const rd = (g, q, mn) => { const m = g.by[mn]; if (!m) return null; const a = q + m.off;
    switch (m.ty) { case 0: return dv.getInt8(a); case 1: return m.c > 1 ? td.decode(b.subarray(a, a + m.c)).split("\0")[0].trim() : b[a]; case 2: return dv.getInt16(a, true); case 3: return dv.getUint16(a, true); case 4: return dv.getInt32(a, true); case 5: return dv.getUint32(a, true);
      case 6: return Number(dv.getBigInt64(a, true)) * 1e-14; case 7: return Number(dv.getBigUint64(a, true)); case 8: return dv.getFloat32(a, true); } return null; };
  const want = new Set(["id_bb", "mhc_serial", "ubx_serial_bb", "ubx_bbPosLLH", "gpsglue_bbTimeUTC", "alt_Param_bb", "cam_PhotoTag_bb"].map(n => byName[n]).filter(x => x != null));
  let n = 0, bad = 0, weekOff = null; const id = {}, pos = [], tags = [];
  // walk the records; after damage, search for the next magic
  p = 0; while (p + 14 <= b.length) {
    if (!isM(p)) { bad++; let q = p + 1; while (q + 4 <= b.length && !isM(q)) q++; p = q; continue; }
    const gid = dv.getUint16(p + 4, true), g = G[gid]; if (gid === 0xffff) { const q2 = (() => { let q = p + 4; while (q + 4 <= b.length && !isM(q)) q++; return q; })(); p = q2; continue; }
    if (!g) { bad++; p += 4; continue; }
    const q = p + 12; if (q + g.size + 2 > b.length) break; n++;
    if (want.has(gid)) {
      if (g.name === "id_bb") { id.name = rd(g, q, "name"); id.sn = rd(g, q, "sn"); id.fw = rd(g, q, "firmwareVersion"); }
      else if (g.name === "mhc_serial") { id.modemSn = rd(g, q, "sn"); id.modemVer = rd(g, q, "ver"); }
      else if (g.name === "ubx_serial_bb") id.gps = rd(g, q, "ver");
      else if (g.name === "alt_Param_bb") { id.toWgs = rd(g, q, "takeOffAltitudeWgs84"); id.toMsl = rd(g, q, "takeOffAltitudeAmsl"); }
      else if (g.name === "gpsglue_bbTimeUTC") { const v = rd(g, q, "valid"), y = rd(g, q, "year"); if (weekOff == null && (v & 4) && y >= 2000) { const utc = Date.UTC(y, rd(g, q, "month") - 1, rd(g, q, "day"), rd(g, q, "hour"), rd(g, q, "min"), rd(g, q, "sec")) + Math.round(rd(g, q, "nano") / 1e6); weekOff = utc - rd(g, q, "itow"); } }
      else if (g.name === "ubx_bbPosLLH") { const lat = rd(g, q, "lat") * 1e-7, lon = rd(g, q, "lon") * 1e-7; if (Math.abs(lat) > 1e-6) pos.push({ itow: rd(g, q, "itow"), lat, lon, h: rd(g, q, "height") / 1000, sH: rd(g, q, "hAcc") / 1000 }); }
      else if (g.name === "cam_PhotoTag_bb") { const s = rd(g, q, "utcSec"), y = rd(g, q, "utcYear");
        tags.push({ id: rd(g, q, "id"), t: y >= 2000 ? Date.UTC(y, rd(g, q, "utcMonth") - 1, rd(g, q, "utcDay"), rd(g, q, "utcHour"), rd(g, q, "utcMin")) + Math.round(s * 1000) : null,
          lat: rd(g, q, "latitude"), lon: rd(g, q, "longitude"), h: rd(g, q, "altitudeWgs84"), hMsl: rd(g, q, "altitudeMsl"), sH: rd(g, q, "accXY"), sV: rd(g, q, "accZ"), sol: rd(g, q, "gpsSolType"), pitch: rd(g, q, "pitch"), roll: rd(g, q, "roll"), yaw: rd(g, q, "yaw") }); }
    }
    p = q + g.size + 2;
  }
  L.trajectory = pos.map(x => ({ t: weekOff != null ? weekOff + x.itow : null, lat: x.lat, lon: x.lon, h: x.h, q: "single" })); for (const x of L.trajectory) span(L, x.t);
  L.exposures = tags.map((x, i) => ({ n: i + 1, photo: x.id, t: x.t, lat: x.lat, lon: x.lon, h: x.h, sH: x.sH, sV: x.sV, q: "single", bodyPitch: x.pitch, bodyRoll: x.roll, bodyYaw: x.yaw }));   // aircraft attitude, not camera angles for (const x of tags) span(L, x.t);
  L.device.make = "senseFly"; L.device.model = /^EB-/.test(id.name || "") ? "eBee" : /^EP-/.test(id.name || "") ? "eBee Plus" : "eBee"; L.device.serial = id.name || null; L.device.fw = id.fw || null;
  L.timeSource = tags.some(x => x.t != null) ? "UTC from the GPS receiver (photo tags)" : weekOff != null ? "GPS time of week + UTC from the receiver" : null;
  fact(L, "fFormat", "senseFly .bbx (eBee autopilot black box)"); fact(L, "fVehicle", [L.device.model, id.name, id.sn].filter(Boolean).join(" · ")); fact(L, "fFirmware", id.fw);
  fact(L, "fSerials", [id.modemSn ? "modem " + id.modemSn + (id.modemVer ? " (" + id.modemVer + ")" : "") : null, id.gps ? "GPS " + id.gps : null].filter(Boolean).join(", "));
  fact(L, "fFrames", n); fact(L, "fGroups", Object.keys(G).length); fact(L, "fPhotos", tags.length || null);
  fact(L, "fGnssFix", tags.length ? Object.entries(countBy(tags, x => "gpsSolType " + x.sol)).map(([k, v]) => k + ": " + v).join(", ") : null);
  fact(L, "fHacc", tags.length ? median(tags.map(x => x.sH)).toFixed(2) + " m (accXY, median)" : null);
  fact(L, "fHome", id.toWgs != null ? "take-off point: " + id.toWgs.toFixed(1) + " m WGS 84, " + id.toMsl.toFixed(1) + " m AMSL" : null);
  fact(L, "fHeight", "ellipsoid (altitudeWgs84)");
  if (bad) { L.notes.push("partial"); fact(L, "fStopped", bad + " damaged records skipped"); }
}

/* ---------------------------------------------------------------- DJI app flight events (<date> <time>-<aircraft SN>.dat, DJI GO 4 / DJI Fly)
   Groups of JSON arrays ["YYYY-MM-DD hh:mm:ss", level, message] in the phone's local time (no time zone): Home Point and RTH height,
   flight mode changes, warnings. Useful for the mission notes; times are not converted to UTC. */
async function pDjiEvents(src, L, h, o) {
  const s = new TextDecoder().decode(await slice(src, 0, sizeOf(src))); let ev = [];
  try { ev = JSON.parse("[" + s.trim().replace(/^\[|\]$/g, "").replace(/\]\s*,\s*\[(?=\[)/g, "],[") + "]").flat().filter(e => Array.isArray(e) && e.length >= 3); } catch (e) { ev = []; }
  if (!ev.length) { const re = /\["(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)","([^"]*)","((?:[^"\\]|\\.)*)"\]/g; let m; while ((m = re.exec(s))) ev.push([m[1], m[2], m[3]]); }
  const sn = (/-([0-9A-Z]{10,})\.dat$/i.exec(L.name || "") || [])[1];
  L.device.make = "DJI"; L.device.serial = sn || null;
  const rth = ev.map(e => (/RTH Altitude:\s*(\d+)\s*m/i.exec(e[2]) || [])[1]).filter(Boolean), modes = ev.filter(e => /^Switched to /.test(e[2])).map(e => e[2].replace(/^Switched to |-mode\.?$/g, ""));
  const warn = ev.filter(e => e[1] || /Warning|returning|Zone|Full|Avoided/i.test(e[2]));
  fact(L, "fFormat", "DJI app flight events"); fact(L, "fVehicle", sn ? "SN " + sn : null);
  fact(L, "fLocalSpan", ev.length ? ev[0][0] + " – " + ev[ev.length - 1][0] + " (phone local time, zone not stated)" : null);
  fact(L, "fAppEvents", ev.length); fact(L, "fRth", rth.length ? rth[rth.length - 1] + " m" : null); fact(L, "fModes", modes.length ? modes.join(" → ") : null);
  fact(L, "fWarnings", warn.length ? [...new Set(warn.map(e => e[2]))].slice(0, 6).join(" | ") : null);
  L.notes.push("no-positions"); if (!ev.length) L.notes.push("empty");
}

/* ---------------------------------------------------------------- DJI aircraft internal log (FLYnnn.DAT, *_MSDK.DAT): header "BUILD <date>" at byte 16.
   The records (0x55, length, type, tick) are scrambled per record; decoding needs DatCon-type work and is not done here. Recognised and reported only. */
async function pDjiDat(src, L, h) {
  const b = new TextDecoder("latin1").decode(h.subarray(16, 48)).split("\0")[0].replace(/^BUILD\s+/, "").replace(/\s+/g, " ").trim();
  // newer firmware (build 2024 on Mavic 3M) marks "DJI_LOG_V3" after the header; its frames (0x55, length, …) carry encrypted content, no public decoder
  const v3 = /DJI_LOG_V3/.test(new TextDecoder("latin1").decode(h.subarray(64, 1024)));
  L.device.make = "DJI"; fact(L, "fFormat", /_MSDK\.DAT$/i.test(L.name) ? "DJI MSDK flight controller log (.DAT)" : "DJI aircraft log (FLY.DAT" + (v3 ? ", DJI_LOG_V3)" : ")")); fact(L, "fBuild", b || null);
  const e = entropy(h.subarray(64, 65536)); fact(L, "fEntropy", e.toFixed(2) + " bit/B"); // entropy alone does not tell: older DJI_LOG_V3 files (builds 2017–2021) are only XOR-scrambled and also score 7.5–7.8; builds from 2023 on are encrypted
  const by = +(/\b(20\d\d)\b/.exec(b) || [])[1]; L.encrypted = e > 7.9 || (v3 && by >= 2023 && e > 7.5);
  L.notes.push(L.encrypted ? "encrypted" : "undocumented");
}
/* ---------------------------------------------------------------- Jeti Duplex transmitter telemetry log (<hh-mm-ss>.log; "# <model>", then ";"-separated lines)
   Lines with time 0 declare a sensor value (device id; index; label; unit); data lines give, per device, groups of (index; type; decimals; value).
   Times are milliseconds from switching the transmitter on; the date is not in the file. Positions (Jeti GPS sensors) are not read. */
async function pJeti(src, L, h, o) {
  let model = "", n = 0, last = 0; const lab = {}, rng = {};
  await eachLine(src, l => {
    if (/^#/.test(l)) { model = l.slice(1).trim(); return; }
    const p = l.split(";"); if (p.length < 4) return; const t = +p[0], dev = p[1];
    if (t === 0) { lab[dev + ":" + p[2]] = (p[3] || "").trim() + (p[4] && p[4].trim() ? " [" + p[4].trim() + "]" : ""); return; }
    n++; last = t;
    for (let i = 2; i + 3 < p.length; i += 4) { const k = dev + ":" + p[i], ty = +p[i + 1], dec = +p[i + 2], v = +p[i + 3]; if (ty === 9 || !isFinite(v)) continue; const x = v / Math.pow(10, dec || 0), r = rng[k] || (rng[k] = [x, x]); if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
  }, o);
  L.device.make = "Jeti"; L.device.model = model || null;
  fact(L, "fFormat", "Jeti transmitter telemetry log"); fact(L, "fVehicle", model); fact(L, "fFrames", n); fact(L, "fDuration", last ? (last / 1000).toFixed(0) + " s from transmitter start" : null);
  fact(L, "fChannels", Object.keys(rng).filter(k => lab[k]).map(k => lab[k] + " " + rng[k][0] + "–" + rng[k][1]).slice(0, 12).join(", "));
  L.notes.push("no-positions");
}
/* ---------------------------------------------------------------- senseFly eMotion logbook (.efl): variable declarations (u32 id) and snapshots; the value layout is not resolved, only the variables are listed */
async function pEfl(src, L, h) {
  const s = new TextDecoder("latin1").decode(h), names = [...new Set((s.match(/[a-z][\w]*\.[\w.]+/g) || []))];
  fact(L, "fFormat", "senseFly eMotion logbook (.efl)"); fact(L, "fVariables", names.length + (names.length ? " (e.g. " + names.filter(x => /geo|gps|robot/.test(x)).slice(0, 6).join(", ") + ")" : ""));
  L.device.make = "senseFly"; L.notes.push("undocumented");
}

/* ---------------------------------------------------------------- processing projects: Pix4Dmapper .p4d (XML) and Agisoft Metashape
   (.psx pointer, doc.xml of a chunk or of a document, chunk.zip / project.zip / frame.zip / .psz).
   What a project records about the processing: software and version, the steps with their settings, image and GCP counts,
   reference systems and accuracies, the camera models and the products. Read into L.proc (see procRecord); a project is not a
   flight log, so it gives no positions. Image paths in a project are paths on the processing computer and are not reported. */
function xmlTree(s) {
  const root = { tag: "#root", a: {}, c: [], t: "" }, stack = [root];
  const ent = x => x.indexOf("&") < 0 ? x : x.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e.toLowerCase()] || (/^#x/i.test(e) ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(+e.slice(1))));
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.t += m[1];
    else if (m[2]) { if (stack.some(e => e.tag === m[2])) while (stack.length > 1 && stack.pop().tag !== m[2]); }
    else if (m[3]) { const e = { tag: m[3], a: {}, c: [], t: "" }; for (const x of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) e.a[x[1]] = ent(x[2] != null ? x[2] : x[3]); top.c.push(e); if (!m[5]) stack.push(e); }
    else if (m[6] && stack.length > 1) top.t += ent(m[6]);
  }
  return root;
}
const xKid = (e, tag) => (e && e.c.find(x => x.tag === tag)) || null;
const xKids = (e, tag) => e ? e.c.filter(x => x.tag === tag) : [];
const xPath = (e, ...tags) => tags.reduce((x, t) => xKid(x, t), e);
const xTxt = (e, ...tags) => { const k = xPath(e, ...tags); return k ? k.t.trim() : ""; };
function xAll(e, tag, out) { out = out || []; if (!e) return out; for (const x of e.c) { if (x.tag === tag) out.push(x); xAll(x, tag, out); } return out; }
const xNum = v => v === "" || v == null || !isFinite(+v) ? null : +v;
const xVal = v => { v = String(v).trim(); return v === "true" ? true : v === "false" ? false : v !== "" && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v) ? +v : v; };
/* WKT 1 or 2: name and the EPSG code of the whole system (the last authority, closing the outermost bracket) */
function wktInfo(w) {
  w = String(w || "").trim(); if (!w) return null;
  const name = (/^\w+\["([^"]*)"/.exec(w) || [])[1] || "", epsg = (/(?:AUTHORITY|ID)\["EPSG",\s*"?(\d+)"?\]\]\s*$/.exec(w) || [])[1] || null;
  const vert = (/VERT_?CS\["([^"]*)"/.exec(w) || [])[1] || null;
  return { name, epsg: epsg ? "EPSG:" + epsg : null, vertical: vert };
}
const crsTxt = c => c ? (c.name || "?") + (c.epsg ? " (" + c.epsg + ")" : "") : "";
async function inflateRaw(u8) {
  if (typeof DecompressionStream !== "undefined") { const ds = new DecompressionStream("deflate-raw"); const r = new Blob([u8]).stream().pipeThrough(ds); return new Uint8Array(await new Response(r).arrayBuffer()); }
  if (typeof require === "function") return new Uint8Array(require("zlib").inflateRawSync(u8));
  throw new Error("no inflate available");
}
/* members of a ZIP from its central directory; a cut archive (no directory) is walked by its local headers */
async function zipList(src) {
  const n = sizeOf(src), tail = await slice(src, Math.max(0, n - 65558), n), out = [];
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b || tail[i + 2] !== 5 || tail[i + 3] !== 6) continue;
    const dv = dvOf(tail), cnt = dv.getUint16(i + 10, true), cdSize = dv.getUint32(i + 12, true), cdOff = dv.getUint32(i + 16, true);
    if (cdOff + cdSize > n) break;
    const cd = await slice(src, cdOff, cdOff + cdSize), cv = dvOf(cd); let p = 0;
    for (let k = 0; k < cnt && p + 46 <= cd.length; k++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
      out.push({ name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl)), method: cv.getUint16(p + 10, true), cs: cv.getUint32(p + 20, true), us: cv.getUint32(p + 24, true), off: cv.getUint32(p + 42, true) });
      p += 46 + nl + xl + cl;
    }
    return { members: out, cut: false };
  }
  let p = 0;
  while (p + 30 <= n) {
    const dv = dvOf(await slice(src, p, p + 30)); if (dv.getUint32(0, true) !== 0x04034b50) break;
    const flags = dv.getUint16(6, true), cs = dv.getUint32(18, true), nl = dv.getUint16(26, true), xl = dv.getUint16(28, true);
    if (flags & 8 && !cs) break;
    out.push({ name: new TextDecoder().decode(await slice(src, p + 30, p + 30 + nl)), method: dv.getUint16(8, true), cs, us: dv.getUint32(22, true), off: p });
    p += 30 + nl + xl + cs;
  }
  return { members: out, cut: true };
}
async function zipRead(src, m, max) {
  if (m.cs > (max || 64 * 1048576) || m.us > 4 * (max || 64 * 1048576)) return null;
  const dv = dvOf(await slice(src, m.off, m.off + 30)); if (dv.getUint32(0, true) !== 0x04034b50) return null;
  const a = m.off + 30 + dv.getUint16(26, true) + dv.getUint16(28, true); if (a + m.cs > sizeOf(src)) return null;
  const b = await slice(src, a, a + m.cs);
  return m.method === 0 ? b : m.method === 8 ? inflateRaw(b) : null;
}

/* ---- Pix4Dmapper .p4d: options per processing step (1 initial, 2 point cloud and mesh, 3 DSM, orthomosaic and index), inputs.
   The project keeps the settings and whether each step is switched on, not whether or when it ran; the quality report holds that. */
function p4dOpts(e) {
  const o = {}; if (!e) return o;
  for (const x of e.c) {
    if (!x.c.length && !Object.keys(x.a).length) o[x.tag] = xVal(x.t);
    else if (x.c.length && x.c.every(y => y.a.name != null && !y.c.length)) o[x.tag] = x.c.map(y => y.a.name);
  }
  return o;
}
const projBase = n => String(n || "").split(/[\\/]/).pop().replace(/\.[^.]*$/, "").toLowerCase();
async function pP4D(src, L) {
  const R = xKid(xmlTree(await text(src)), "pix4dmapper");
  if (!R) { L.notes.push("not-a-project"); return; }
  const ver = xTxt(R, "software", "projectVersion"), O = xKid(R, "options"), I = xKid(R, "inputs");
  const sw = { name: "Pix4Dmapper", version: ver || "" };
  fact(L, "fFormat", "Pix4Dmapper project (.p4d)" + (xTxt(R, "software", "p4dVersion") ? ", file version " + xTxt(R, "software", "p4dVersion") : ""));
  fact(L, "fSoftware", "Pix4Dmapper " + (ver || "?"));
  // images: count, groups, prior accuracy (from EXIF/XMP), EXIF time span; paths are not reported
  const imgs = xKids(xKid(I, "images"), "image"), on = imgs.filter(x => x.a.enabled !== "false");
  const groups = countBy(imgs, x => x.a.group || "–"), accXY = median(on.map(x => xNum(xTxt(x, "accuracyXY")))), accZ = median(on.map(x => xNum(xTxt(x, "accuracyZ"))));
  const times = imgs.map(x => xTxt(x, "time")).filter(Boolean).sort();
  fact(L, "fImages", imgs.length + (on.length !== imgs.length ? " (" + on.length + " enabled)" : "") + (Object.keys(groups).length ? " · " + Object.entries(groups).map(([k, v]) => k + ": " + v).join(", ") : ""));
  if (accXY != null) fact(L, "fPriorAcc", "XY " + accXY.toFixed(3) + " m, Z " + (accZ != null ? accZ.toFixed(3) : "?") + " m (median of the image values)");
  if (times.length) fact(L, "fLocalSpan", times[0] + " … " + times[times.length - 1] + " (image time, zone not stated)");
  // camera models as entered in the project (initial values; the optimised ones are in the calibrated parameter files)
  const cams = xKids(xKid(I, "cameras"), "camera").map(c => ({ name: c.a.name || "", w: xNum(xTxt(c, "imageWidth")), h: xNum(xTxt(c, "imageHeight")), f: xNum(xTxt(c, "focalLengthmm")), px: xNum(xTxt(c, "pixelSize")),
    source: xTxt(c, "cameraModelSource"), bands: xKids(c, "band").map(b => b.a.name).filter(Boolean) }));
  fact(L, "fCamera", cams.map(c => c.name + (c.f != null ? " · f " + c.f.toFixed(3) + " mm" : "") + (c.source ? " (" + c.source + ")" : "")).join("; "));
  const rig = xKid(xKid(I, "cameras"), "rig");
  let rigO = null;
  if (rig) { const ref = xKid(rig, "referenceCamera"), proc = xKid(rig, "processing");
    rigO = { name: rig.a.name || "", reference_camera: ref ? +ref.a.id : null, optimisation: proc ? proc.a.mode : null,
      cameras: xKids(rig, "camera").map(c => ({ id: +c.a.id, rotation_deg: [c.a.rotX, c.a.rotY, c.a.rotZ].map(xNum), translation_mm: [c.a.translX, c.a.translY, c.a.translZ].map(xNum) })) };
    fact(L, "fRig", rigO.name + ": " + rigO.cameras.map(c => "camera " + c.id + " rotation " + c.rotation_deg.join(" / ") + "°, offset " + c.translation_mm.join(" / ") + " mm").join("; ") + (rigO.optimisation ? " · optimisation " + rigO.optimisation : "")); }
  // reference systems
  const C = xKid(I, "coordinateSystems"), crs = {};
  for (const k of ["output", "gcp", "image"]) { const e = xKid(C, k); if (!e) continue; crs[k] = wktInfo(xTxt(e, "WKT")); const v = xKid(e, "verticalDef"); if (crs[k] && v) crs[k].verticalDef = Object.assign({}, v.a); }
  fact(L, "fCoordSys", Object.entries(crs).filter(([, v]) => v).map(([k, v]) => k + ": " + crsTxt(v) + (v.verticalDef ? ", heights " + Object.entries(v.verticalDef).map(([a, b]) => a + " " + b).join(" ") : "")).join(" · "));
  // ground control
  const gcps = xKids(xKid(I, "gcps"), "gcp"), gt = countBy(gcps, g => String(g.a.type || "GCP").toLowerCase());
  const control = (gt.gcp || 0) + (gt["3dgcp"] || 0), check = (gt.checkpoint || 0) + (gt["3dcheckpoint"] || 0);
  fact(L, "fGcp", gcps.length ? Object.entries(gt).map(([k, v]) => k + ": " + v).join(", ") : "none in the project");
  // steps
  const sec = k => p4dOpts(xKid(O, k)), ini = sec("initial"), den = sec("dense"), mesh = sec("mesh"), ort = sec("ortho"), idx = xKid(O, "index");
  const idxO = p4dOpts(idx), indices = xKids(xKid(idx, "indices"), "index").filter(x => x.a.enabled === "true").map(x => x.a.name);
  const rad = xKids(xKid(idx, "radiometry"), "camera").map(c => ({ camera: +c.a.id, correction: xTxt(c, "radiometricCorrection") }));
  if (indices.length) idxO.indices = indices; if (rad.length) idxO.radiometric_correction = rad;
  const run = o => o.runStep !== false;
  const steps = [];
  if (run(ini)) steps.push({ order: 1, id: "initial", name: "Initial processing", parameters: ini });
  if (run(den)) steps.push({ order: 2, id: "dense", name: "Point cloud and mesh", parameters: Object.assign({}, den, mesh) });
  if (run(ort)) steps.push({ order: 3, id: "ortho", name: "DSM, orthomosaic and index", parameters: Object.assign({}, ort, Object.keys(idxO).length ? { index: idxO } : {}) });
  for (const s of steps) delete s.parameters.runStep;
  fact(L, "fSteps", steps.map(s => s.order + " " + s.name).join(", ") + " (switched on in the project)");
  // products the settings ask for
  const P = [], fm = (o, re) => Object.keys(o).filter(k => re.test(k) && o[k] === true).map(k => k.replace(re, "$1"));
  if (run(den)) { const f = fm(den, /^pclExport(LAS|LAZ|PLY|XYZ)$/); if (f.length) P.push({ type: "point cloud", format: f.join(", "), step: 2 });
    if (mesh.meshGenerate3dTexturedMesh) P.push({ type: "3D textured mesh", format: fm(mesh, /^meshExport(PLY|FBX|DXF|OBJ|PDF3D)$/).join(", "), step: 2 }); }
  if (run(ort)) { if (ort.dsmTIFF) P.push({ type: "DSM", format: "GeoTIFF", step: 3 }); if (ort.mosaicTIFF) P.push({ type: "orthomosaic", format: "GeoTIFF", step: 3 });
    if (ort.dtmTIFF) P.push({ type: "DTM", format: "GeoTIFF", step: 3 }); for (const n of indices) P.push({ type: "index map (" + n + ")", format: "GeoTIFF", step: 3 }); }
  fact(L, "fProducts", P.map(p => p.type + (p.format ? " (" + p.format + ")" : "")).join(", "));
  const gsd = xNum(ort.meanResolution);
  if (gsd != null) fact(L, "fGsd", gsd.toFixed(2) + " cm (mean of the project)");
  const out = crs.output, vd = out && out.verticalDef;
  L.proc = { software: [sw], steps: steps.map(s => Object.assign(s, { method: "Pix4Dmapper, step " + s.order })), source: "p4d",
    photogrammetry_settings: Object.assign({}, ini, rigO ? { rig: rigO } : {}),
    adjustment_quality: Object.assign({ images: imgs.length, images_enabled: on.length }, accXY != null ? { prior_accuracy_xy_m: +accXY.toFixed(3), prior_accuracy_z_m: accZ != null ? +accZ.toFixed(3) : null } : {},
      { gcp_control: control, gcp_check: check }, gsd != null ? { mean_gsd_cm: +gsd.toFixed(2) } : {}),
    output_crs: out && out.epsg, crs, vertical: vd ? (vd.model === "constShift" && +vd.geoidHeight === 0 ? "ellipsoidal heights (Pix4D: constant geoid height 0 m)" : "Pix4D vertical definition: " + Object.entries(vd).map(([a, b]) => a + " " + b).join(", ")) : null,
    gcp: gcps.length ? { control, check } : { control: 0, check: 0 }, products: P, geometry: [], saved_local: null, images: imgs.map(x => projBase(x.a.path)) };
  L.notes.push("processing");
}

/* ---- ThermoTIFF (J. Rous, MIT): conversion_log.csv and processing_record.json. ThermoTIFF converts DJI R-JPEGs to float32 TIFF in degrees Celsius
   with the DJI Thermal SDK. Both files describe one conversion run: read as a processing record (software, the conversion step and its parameters).
   File paths in them (input and output folders, full source paths) are not copied: only file names are kept, to match the loaded images. */
const TT_PARAMS = [["distance", "object_distance_m"], ["humidity", "relative_humidity_pct"], ["emissivity", "emissivity"], ["reflection", "reflected_temperature_c"], ["ambient_temp", "ambient_temperature_c"]];
const TT_METHOD = "DJI Thermal SDK: raw values of the R-JPEG to temperature in degrees Celsius (float32 TIFF), with the measurement parameters below";
const TT_ATM = "DJI Thermal SDK built-in correction (method not published; inputs: object distance, relative humidity, ambient and reflected temperature)";
const baseName = p => String(p || "").split(/[\\/]/).pop();
function ttProc(L, sw, step, settings, images, extra) {
  L.proc = Object.assign({ software: sw, steps: [step], source: "thermotiff", photogrammetry_settings: {}, adjustment_quality: {}, thermal_settings: settings, atmospheric_model: TT_ATM,
    products: [{ type: "temperature images (degrees Celsius)", format: "TIFF float32", step: 1 }], geometry: [], gcp: null, saved_local: null, images: images.map(projBase) }, extra || {});
  L.notes.push("processing");
}
async function pThermoLog(src, L) {
  const lines = (await text(src)).replace(/^﻿/, "").split(/\r?\n/).filter(x => x.trim()), head = csvSplit(lines[0], ","), ix = n => head.indexOf(n);
  const rows = lines.slice(1).map(l => csvSplit(l, ",")).filter(r => r.length >= head.length - 1);
  const st = {}, combos = new Map(), api = new Set(), over = new Set(), names = [], tmin = [], tmax = [], tmean = [], clip = []; let secs = 0;
  for (const r of rows) {
    const s = r[ix("status")] || ""; st[s] = (st[s] || 0) + 1; names.push(baseName(r[ix("source")]));
    const t = +r[ix("seconds")]; if (isFinite(t)) secs += t;
    if (s !== "ok") continue;
    const p = {}; for (const [c, k] of TT_PARAMS) { const v = r[ix(c)]; if (v !== "" && v != null && isFinite(+v)) p[k] = +v; }
    const key = JSON.stringify(p); combos.set(key, (combos.get(key) || 0) + 1);
    if (r[ix("dji_api_version")]) api.add(r[ix("dji_api_version")]); if (r[ix("overridden")]) over.add(r[ix("overridden")]);
    const a = parseFloat(r[ix("t_min_C")]), b = parseFloat(r[ix("t_max_C")]), m = parseFloat(r[ix("t_mean_C")]);
    if (isFinite(a)) tmin.push(a); if (isFinite(b)) tmax.push(b); if (isFinite(m)) tmean.push(m);
    // the DJI Thermal SDK clips to the camera's measuring range: a minimum or maximum exactly at a DJI range limit marks clipped pixels (e.g. sky below −20 °C on the M3T)
    if ([a, b].some(v => [-40, -20, 150, 500, 550].includes(v))) clip.push(baseName(r[ix("source")]) + " (" + [a, b].filter(v => [-40, -20, 150, 500, 550].includes(v)).join(", ") + " °C)");
  }
  fact(L, "fFormat", "ThermoTIFF conversion_log.csv");
  fact(L, "fImages", rows.length + " (" + Object.entries(st).map(([k, v]) => k + " " + v).join(", ") + ")");
  const sets = [...combos.entries()].sort((a, b) => b[1] - a[1]), P = sets.length ? JSON.parse(sets[0][0]) : {};
  const ov = [...over].join("; "), src0 = ov ? "set by the user for " + ov.replace(/=[^,;]*/g, "") + "; other values stored in the images" : "stored in the images";
  fact(L, "fThermalParams", Object.entries(P).map(([k, v]) => k + " " + v).join(", ") + (sets.length > 1 ? " (" + sets.length + " different sets; the most frequent shown)" : ""));
  if (ov) fact(L, "fOverridden", ov);
  if (tmin.length) fact(L, "fTempRange", Math.min(...tmin).toFixed(2) + " … " + Math.max(...tmax).toFixed(2) + " °C" + (tmean.length ? " (image means " + Math.min(...tmean).toFixed(2) + " … " + Math.max(...tmean).toFixed(2) + " °C)" : ""));
  if (clip.length) { fact(L, "fTempClipped", clip.length + " · " + clip.slice(0, 5).join(", ") + (clip.length > 5 ? " …" : "")); L.notes.push("thermal-clipped"); }
  const settings = Object.assign({ method: TT_METHOD }, P, { parameter_source: src0 }, sets.length > 1 ? { parameter_sets: sets.map(([k, n]) => Object.assign(JSON.parse(k), { images: n })) } : {});
  ttProc(L, [{ name: "ThermoTIFF", version: "", note: "the version is not in conversion_log.csv (it is in the TIFF and in processing_record.json)" }, { name: "DJI Thermal SDK", version: api.size ? "API " + [...api].join(", ") : "" }],
    { order: 1, name: "Convert R-JPEG to temperature TIFF", method: TT_METHOD, parameters: Object.assign({}, P, { parameter_source: src0, images: rows.length, converted: st.ok || 0, errors: (st.error || 0) + (st.not_radiometric || 0), skipped: st.skipped || 0 }), duration_s: +secs.toFixed(2) },
    settings, names);
}
async function pThermoRecord(src, L) {
  let J; try { J = JSON.parse((await text(src)).replace(/^﻿/, "")); } catch (e) { L.notes.push("not-a-project"); return; }
  const s = J.software || {}, p = J.parameters || null, out = J.output || {}, inp = J.input || {}, qc = J.quality_control || null;
  const sw = [{ name: "ThermoTIFF", version: s.version || "" }, { name: "DJI Thermal SDK", version: s.dji_thermal_sdk_api ? "API " + s.dji_thermal_sdk_api : "" }];
  if (s.exiftool) sw.push({ name: "ExifTool", version: String(s.exiftool) });
  const P = {}; if (p) { if (p.distance_m != null) P.object_distance_m = p.distance_m; if (p.humidity_pct != null) P.relative_humidity_pct = p.humidity_pct; if (p.emissivity != null) P.emissivity = p.emissivity; if (p.reflected_C != null) P.reflected_temperature_c = p.reflected_C; }
  const srcP = p && p.source ? p.source : null;
  fact(L, "fFormat", "ThermoTIFF processing record " + (s.version || ""));
  fact(L, "fSoftware", sw.map(x => x.name + " " + x.version).join(", "));
  if (J.created) fact(L, "fCreated", J.created);
  if (J.camera && J.camera.model) L.device = { model: J.camera.model };
  fact(L, "fImages", (inp.images != null ? inp.images : "?") + (out.converted != null ? " (converted " + out.converted + ", errors " + (out.errors || 0) + ")" : ""));
  if (p) fact(L, "fThermalParams", Object.entries(P).map(([k, v]) => k + " " + v).join(", ") + (srcP ? " (" + srcP + ")" : ""));
  if (qc) fact(L, "fQc", (qc.flagged || 0) + " flagged" + (qc.reasons && Object.keys(qc.reasons).length ? ": " + Object.entries(qc.reasons).map(([k, v]) => k + " " + v).join(", ") : ""));
  const steps = [{ order: 1, name: "Convert R-JPEG to temperature TIFF", method: TT_METHOD, parameters: Object.assign({}, P, srcP ? { parameter_source: srcP } : {}, { images: inp.images, converted: out.converted, errors: out.errors, output_format: out.format, record_created: J.created }) }];
  if (qc) steps.push({ order: 2, name: "Quality control of the temperature images", method: "ThermoTIFF rules", parameters: { flagged: qc.flagged, reasons: qc.reasons, rules: qc.rules } });
  ttProc(L, sw, steps[0], Object.assign({ method: TT_METHOD }, P, srcP ? { parameter_source: srcP } : {}), [], {});
  L.proc.steps = steps;
}

/* ---- Agisoft Metashape: the .psx file only points to {name}.files/project.zip; the content is in doc.xml files inside the zips
   (document → chunks → chunk.zip → frames → frame.zip). Each step leaves its settings, duration and memory in a <meta> block
   ("AlignCameras/…"); Info/LastSavedSoftwareVersion is the version that last saved the file, not necessarily the one that ran each step. */
const MS_STEPS = [["MatchPhotos", "Match photos"], ["AlignCameras", "Align photos"], ["OptimizeCameras", "Optimize cameras"], ["BuildDepthMaps", "Build depth maps"], ["BuildDenseCloud", "Build dense cloud"],
  ["BuildPointCloud", "Build point cloud"], ["ClassifyGroundPoints", "Classify ground points"], ["ClassifyPoints", "Classify points"], ["BuildModel", "Build mesh"], ["BuildUV", "Build UV"],
  ["BuildTexture", "Build texture"], ["BuildTiledModel", "Build tiled model"], ["BuildDem", "Build DEM"], ["BuildOrthomosaic", "Build orthomosaic"]];
async function msDocs(src, members, prefix, docs, depth) {
  for (const m of members) {
    if (/(^|\/)doc\.xml$/i.test(m.name)) { const b = await zipRead(src, m, 32 * 1048576); if (b) docs.push({ path: prefix + m.name, x: xmlTree(new TextDecoder().decode(b)) }); }
    else if (/\.zip$/i.test(m.name) && depth < 3 && m.us <= 64 * 1048576) { const b = await zipRead(src, m); if (b) { const z = await zipList(b); await msDocs(b, z.members, prefix + m.name + "/", docs, depth + 1); } }
  }
}
async function pMetashape(src, L, h) {
  const docs = []; let cut = false;
  if (h[0] === 0x50 && h[1] === 0x4b) { const z = await zipList(src); cut = z.cut; await msDocs(src, z.members, "", docs, 0); if (cut) L.notes.push("archive-cut"); }
  else docs.push({ path: "", x: xmlTree(await text(src)) });
  const roots = docs.map(d => ({ path: d.path, e: d.x.c.find(x => x.tag !== "#root") })).filter(d => d.e);
  const docEl = roots.find(d => d.e.tag === "document");
  // a .psx (or project.zip doc.xml) that only points elsewhere
  if (roots.length === 1 && docEl && !xAll(docEl.e, "chunk").some(c => c.c.length) && !xAll(docEl.e, "meta").length) {
    fact(L, "fFormat", "Agisoft Metashape project file (document " + (docEl.e.a.version || "?") + ")");
    const ptr = docEl.e.a.path || xAll(docEl.e, "chunk").map(c => c.a.path).filter(Boolean).join(", ");
    fact(L, "fPointsTo", (ptr || "?") + ": load chunk.zip (or the .psz) for the processing record");
    L.notes.push("project-pointer"); return;
  }
  const chunks = roots.filter(d => d.e.tag === "chunk").map(d => d.e).concat(docEl ? xAll(docEl.e, "chunk").filter(c => c.c.length) : []);
  const ch = chunks[0] || null, frames = roots.filter(d => d.e.tag === "frame").map(d => d.e);
  if (!ch && !frames.length && !roots.some(d => xAll(d.e, "meta").length)) { L.notes.push("not-a-project"); return; }
  fact(L, "fFormat", "Agisoft Metashape " + (ch ? "chunk" : roots[0].e.tag) + " (format " + ((ch || roots[0].e).a.version || "?") + ")" + (docs.length > 1 ? ", " + docs.length + " doc.xml read" : ""));
  if (chunks.length > 1) fact(L, "fChunks", chunks.length + " chunks; the first is read");
  // steps from every <meta> block found
  const meta = {}, info = {};
  // only the <meta> of the document, chunk, frame or component itself (cameras carry their own Exif <meta>)
  const metaEls = [...new Set(roots.map(d => d.e).concat(chunks).flatMap(e => xKids(e, "meta")))];
  for (const mb of metaEls) for (const p of xKids(mb, "property")) {
    const nm = p.a.name || "", i = nm.indexOf("/"); if (i < 0) continue;
    const st = nm.slice(0, i), key = nm.slice(i + 1), v = xVal(p.a.value != null ? p.a.value : p.t);
    if (st === "Info") { if (!(key in info)) info[key] = v; continue; }
    const o = meta[st] || (meta[st] = {}); if (!(key in o)) o[key] = v;
  }
  const order = s => { const i = MS_STEPS.findIndex(x => x[0] === s); return i < 0 ? 99 : i; };
  const steps = Object.keys(meta).sort((a, b) => order(a) - order(b)).map((s, i) => {
    const p = Object.assign({}, meta[s]), st = { order: i + 1, id: s, name: (MS_STEPS.find(x => x[0] === s) || [, s.replace(/([a-z])([A-Z])/g, "$1 $2")])[1], method: "Metashape " + s };
    if (p.duration != null) { st.duration_s = +p.duration; delete p.duration; }
    if (p.ram_used != null) { st.memory_bytes = +p.ram_used; delete p.ram_used; }
    const vk = Object.keys(p).find(k => /software_?version/i.test(k)); if (vk) { st.software_version = String(p[vk]); delete p[vk]; }
    st.parameters = p; return st;
  });
  const swv = info.LastSavedSoftwareVersion ? String(info.LastSavedSoftwareVersion) : "";
  fact(L, "fSoftware", "Agisoft Metashape " + (swv || "?") + (swv ? " (last saved" + (info.LastSavedDateTime ? " " + info.LastSavedDateTime + ", local time" : "") + ")" : ""));
  fact(L, "fSteps", steps.map(s => s.order + " " + s.name + (s.duration_s != null ? " (" + (s.duration_s < 120 ? s.duration_s.toFixed(0) + " s" : (s.duration_s / 60).toFixed(1) + " min") + ")" : "")).join(", "));
  // sensors and their calibration
  const geometry = [], sensors = ch ? xKids(xKid(ch, "sensors"), "sensor") : [];
  for (const s of sensors) {
    const res = xKid(s, "resolution"), w = res ? xNum(res.a.width) : null, hh = res ? xNum(res.a.height) : null, prop = n => { const p = xKids(s, "property").find(x => x.a.name === n); return p ? xNum(p.a.value) : null; };
    const cals = xKids(s, "calibration"), cal = cals.find(c => c.a.class === "adjusted") || null, px = prop("pixel_width");
    const g = { label: s.a.label || "", type: s.a.type || "", w, h: hh, focal_mm: prop("focal_length"), pixel_mm: px, bands: xAll(s, "band").map(b => b.a.label).filter(Boolean), adjusted: !!cal };
    if (cal) { const c = k => xNum(xTxt(cal, k)); g.cal = { f: c("f"), cx: c("cx"), cy: c("cy"), b1: c("b1"), b2: c("b2"), k: ["k1", "k2", "k3", "k4"].map(c).filter(v => v != null), p: ["p1", "p2", "p3", "p4"].map(c).filter(v => v != null) }; }
    geometry.push(g);
  }
  if (geometry.length) fact(L, "fCamera", geometry.map(g => g.label + " " + g.w + "×" + g.h + (g.cal && g.cal.f != null ? " · f " + g.cal.f.toFixed(2) + " px" + (g.pixel_mm ? " = " + (g.cal.f * g.pixel_mm).toFixed(3) + " mm" : "") + " (adjusted)" : " (not calibrated)")).join("; "));
  // cameras (images): aligned = has an estimated transform
  const camEls = ch ? xAll(xKid(ch, "cameras"), "camera") : [], aligned = camEls.filter(c => xKid(c, "transform")).length, enabled = camEls.filter(c => c.a.enabled !== "false").length;
  if (camEls.length) fact(L, "fImages", camEls.length + " · aligned " + aligned + (enabled !== camEls.length ? " · enabled " + enabled : ""));
  // markers: with reference coordinates and enabled = control; disabled = check points (when projected in a frame) or unused
  const marks = ch ? xAll(xKid(ch, "markers"), "marker") : [], proj = {};
  for (const fr of frames) for (const m of xAll(xKid(fr, "markers"), "marker")) proj[m.a.marker_id] = xKids(m, "location").length;
  const known = Object.keys(proj).length > 0, withRef = marks.filter(m => xKid(m, "reference"));
  const ctrl = withRef.filter(m => xKid(m, "reference").a.enabled !== "false"), dis = withRef.filter(m => xKid(m, "reference").a.enabled === "false");
  const chk = known ? dis.filter(m => proj[m.a.id] > 0) : null;
  if (marks.length) fact(L, "fGcp", marks.length + " markers · " + ctrl.length + " control" + (known ? " · " + chk.length + " check" + (dis.length - chk.length ? " · " + (dis.length - chk.length) + " disabled without projections" : "") : " · " + dis.length + " disabled (check points or unused; projections are in frame.zip)") + (marks.length - withRef.length ? " · " + (marks.length - withRef.length) + " without coordinates" : ""));
  else if (ch) fact(L, "fGcp", "none in the project");
  // reference systems and accuracies
  const crs = ch ? { chunk: wktInfo(xTxt(ch, "reference")), cameras: wktInfo(xTxt(ch, "camera_reference")), markers: wktInfo(xTxt(ch, "marker_reference")) } : {};
  fact(L, "fCoordSys", Object.entries(crs).filter(([, v]) => v).map(([k, v]) => k + ": " + crsTxt(v)).join(" · "));
  const acc = {}; if (ch) for (const p of xKids(xKid(ch, "settings"), "property")) if (/^accuracy_/.test(p.a.name)) acc[p.a.name] = xNum(p.a.value);
  if (Object.keys(acc).length) fact(L, "fRefAcc", Object.entries(acc).map(([k, v]) => k.replace(/^accuracy_/, "") + " " + v).join(", ") + " (m, °, px)");
  // products present in the chunk
  const P = [], lab = e => e.a.label || "";
  if (ch) {
    for (const e of xAll(xKid(ch, "dense_clouds"), "dense_cloud").concat(xAll(xKid(ch, "point_clouds"), "point_cloud"))) P.push({ type: "point cloud", label: lab(e) });
    for (const e of xAll(xKid(ch, "models"), "model")) P.push({ type: "3D model (mesh)", label: lab(e) });
    for (const e of xAll(xKid(ch, "tiled_models"), "tiled_model")) P.push({ type: "tiled model", label: lab(e) });
    for (const e of xAll(xKid(ch, "elevations"), "elevation")) P.push({ type: /DTM|terrain/i.test(lab(e)) ? "DTM" : /DSM|surface/i.test(lab(e)) ? "DSM" : "DEM", label: lab(e) });
    for (const e of xAll(xKid(ch, "orthomosaics"), "orthomosaic")) P.push({ type: "orthomosaic", label: lab(e) });
  }
  const dms = ch ? xAll(xKid(ch, "depth_map_sets"), "depth_maps").length : 0;
  fact(L, "fProducts", P.map(p => p.type + (p.label && p.label !== p.type ? " “" + p.label + "”" : "")).join(", ") + (dms ? (P.length ? ", " : "") + dms + " depth map set(s)" : ""));
  const opt = meta.OptimizeCameras || {};
  L.proc = { software: [{ name: "Agisoft Metashape", version: swv }], software_note: swv ? "version that last saved the project" : "", steps, source: "metashape",
    photogrammetry_settings: Object.assign({}, Object.keys(acc).length ? { reference_accuracy: acc } : {}, ...["MatchPhotos", "AlignCameras", "OptimizeCameras"].filter(s => meta[s]).map(s => { const p = Object.assign({}, meta[s]); delete p.duration; delete p.ram_used; return { [s]: p }; })),
    adjustment_quality: Object.assign({}, camEls.length ? { images: camEls.length, images_aligned: aligned } : {}, marks.length ? { gcp_control: ctrl.length } : {}, chk ? { gcp_check: chk.length } : dis.length ? { markers_disabled: dis.length } : {},
      opt.sigma0 != null ? { sigma0: +opt.sigma0 } : {}),
    output_crs: crs.chunk && crs.chunk.epsg, crs, vertical: crs.chunk && crs.chunk.vertical, gcp: marks.length || ch ? { control: ctrl.length, check: chk ? chk.length : null } : null,
    products: P, geometry, saved_local: info.LastSavedDateTime ? String(info.LastSavedDateTime) : null, images: camEls.map(c => projBase(c.a.label)) };
  L.notes.push("processing");
}

const PARSERS = { "dji-mrk": pMRK, rinex: pRINEX, rtcm3: pRTCM, ulog: pULog, sbf: pSBF, bb3: pBB3, "sf-geoinfo": pGeoinfo, kml: pKML, jxl: pJXL,
  "wingtra-geotaglog": pWGeotaglog, "wingtra-json": pWJson, "wingtra-ini": pWIni, "wingtra-geotags": pWGeotags, "mica-paramlog": pParamlog, "mica-gpslog": pGpslog,
  tlmb: pTLMB, ubx: pUBX, novatel: pNovatel, "lidar-service": pService, "lidar-data": pLidarData, "wingtra-obc": pObc, pcmp: pPcmp, encrypted: pEncrypted,
  "ardupilot-bin": pDataFlash, "ardupilot-log": pAPText, tlog: pTlog, nmea: pNMEA, gpx: pGPX, "csv-geotags": pCSV, "csv-columns": pCSVCols, "dji-fr-csv": pDjiCsv, "thermotiff-log": pThermoLog, "thermotiff-record": pThermoRecord, "dji-fr": pDjiFR, "emotion-transcript": pEmTranscript, "ebeex-afpu": pAfpu, "pix4dcapture-log": pP4dCaptureLog, bbz: pBBZ, "pix4dcapture-mission": pP4dMission, bbx: pBBX, "dji-events": pDjiEvents, "dji-dat": pDjiDat, jeti: pJeti, efl: pEfl, "pix4d-project": pP4D, metashape: pMetashape };

/* ---------------------------------------------------------------- joining images with logs, checks */
/* images: [{ name, S (reader summary), captureId, c2pa }] */
// one shot, several files: MicaSense _1…_10, Sequoia _GRE/_RED…, DJI _D/_T/_V/_W/_S and DJI multispectral _MS_G/_MS_R/_MS_RE/_MS_NIR
function shotKey(n) { return String(n || "").replace(/\.(jpe?g|tiff?|dng)$/i, "").replace(/_MS_(G|R|RE|NIR|B)$/i, "").replace(/_(\d{1,2}|THM|RGB|GRE|RED|REG|NIR|[DTVWSZ])$/i, ""); }
function djiIndex(n) { const m = /^DJI_\d{14}_(\d{4})_/i.exec(n) || /^DJI_(\d{4})/i.exec(n); return m ? +m[1] : null; }
function headingBins(ex) {
  const pts = ex.filter(e => e.lat != null && isFinite(e.lat)), out = { n: 0, opp: 0 }; const hs = [];
  for (let k = 1; k < pts.length; k++) { const a = pts[k - 1], b = pts[k], dy = (b.lat - a.lat) * 111320, dx = (b.lon - a.lon) * 111320 * Math.cos(a.lat / R2D); if (Math.hypot(dx, dy) > 2) hs.push((Math.atan2(dx, dy) * R2D + 360) % 360); }
  if (hs.length < 6) return null;
  const bins = new Array(8).fill(0); for (const h of hs) bins[Math.floor(((h + 22.5) % 360) / 45)]++;
  const top = bins.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]); const main = top[0][1], opp = (main + 4) % 8;
  return { bins, main: main * 45, share: bins[main] / hs.length, oppShare: bins[opp] / hs.length, opposite: bins[opp] >= 0.15 * hs.length };
}
function combine(logs, images, solar) {
  logs = (logs || []).filter(Boolean); images = images || [];
  const F = { version: VERSION, logs: logs.map(l => ({ kind: l.kind, name: l.name, device: l.device, startMs: l.startMs, endMs: l.endMs, verify: l.verify })), checks: [], exposures: [], matches: [], startMs: null, endMs: null };
  const add = (state, key, det, val) => F.checks.push({ state, key, det: det || "", val });
  // processing projects only: nothing to join or check (they are read by oslFromFlight and procRecord)
  if (logs.length && logs.every(l => l.proc || l.notes.includes("project-pointer"))) return F;
  // primary exposure source: geotags with names > events with positions > anything with exposures
  const rank = l => l.listOnly ? 0 : { "wingtra-geotags": 9, "wingtra-geotaglog": 8, "dji-mrk": 8, "sf-geoinfo": 7, sbf: 6, bb3: 6, "mica-paramlog": 5, "csv-geotags": 5, kml: 4, jxl: 4, gpx: 4, "ardupilot-bin": 3, "ardupilot-log": 3, tlog: 3, tlmb: 3, ulog: 2 }[l.kind] || 1;
  const src = logs.filter(l => l.exposures.length && !l.listOnly).sort((a, b) => rank(b) - rank(a));
  // matching: by file name, DJI file index (MRK), MicaSense CaptureId, then by time; a match far away in time or space is rejected
  const used = new Set(), timed = src.filter(l => l.exposures.some(e => e.t != null));
  const sane = (S, e) => (S.lat == null || e.lat == null || Math.hypot((S.lat - e.lat) * 111320, (S.lon - e.lon) * 111320 * Math.cos(S.lat / R2D)) < 200) && (S.utcMs == null || e.t == null || Math.abs(S.utcMs - e.t) < 120000);
  // every match is audited: method, candidates, the ones rejected and why, and a status. Two candidates that fit about equally well
  // are not resolved by guessing: the image stays unmatched with status "ambiguous".
  const distM = (S, e) => S.lat == null || e.lat == null ? null : Math.hypot((S.lat - e.lat) * 111320, (S.lon - e.lon) * 111320 * Math.cos(S.lat / R2D));
  const whyNot = (S, e) => { const d = distM(S, e), t = S.utcMs != null && e.t != null ? Math.abs(S.utcMs - e.t) / 1000 : null;
    return d != null && d >= 200 ? d.toFixed(0) + " m from the image" : t != null && t >= 120 ? t.toFixed(0) + " s from the image" : null; };
  const short = c => ({ log: c.l.name, n: c.e.n, dt: S0 => S0.utcMs != null && c.e.t != null ? +((S0.utcMs - c.e.t) / 1000).toFixed(2) : null });
  for (const im of images) {
    const S = im.S || {}; let m = null, how = null, status = "unmatched", reason = null; const cands = [], rejected = [];
    // 1) identifiers (file name, DJI index, Tetracam index, MicaSense CaptureId): candidates from the best-ranked source that has any, plus sources of the same rank (several flights)
    let r0 = null;
    for (const l of src) {
      if (r0 != null && rank(l) !== r0) break;
      let es = [], h = null;
      if (l.exposures[0].name) { es = l.exposures.filter(e => e.name === im.name); if (!es.length) { es = l.exposures.filter(e => e.name && shotKey(e.name) === shotKey(im.name));
        // band files of one shot listed separately (same time, or no time) count as one candidate
        if (es.length > 1 && es.every(e => e.t == null || Math.abs(e.t - es[0].t) < 1000)) es = es.slice(0, 1); } h = "name"; }
      if (!es.length && l.kind === "dji-mrk") { const k = djiIndex(im.name); es = k != null ? l.exposures.filter(e => e.n === k) : []; h = "index"; }
      if (!es.length && l.kind === "tlmb") { const k = /_(\d{4})_(GRE|RED|REG|NIR|RGB)\.(TIF|JPG)$/i.exec(im.name); es = k ? l.exposures.filter(e => e.n === +k[1]) : []; h = "index"; }
      if (!es.length && l.kind === "mica-paramlog" && im.captureId) { es = l.exposures.filter(e => e.captureId === im.captureId); h = "captureId"; }
      for (const e of es) { const w = whyNot(S, e); if (w) rejected.push({ log: l.name, n: e.n, why: w }); else cands.push({ l, e, h }); }
      if (cands.length && r0 == null) r0 = rank(l);
    }
    if (cands.length === 1) { m = cands[0]; how = m.h; status = "unique"; }
    else if (cands.length > 1) {
      // several candidates (e.g. two flights with the same numbering): decided by time, else by position, only when one is clearly closer
      const score = c => S.utcMs != null && c.e.t != null ? Math.abs(S.utcMs - c.e.t) / 1000 : null, sc = cands.map(score);
      const by = sc.every(x => x != null) ? sc : (() => { const d = cands.map(c => distM(S, c.e)); return d.every(x => x != null) ? d : null; })();
      if (by) { const o = by.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const [b0, b1] = [o[0][0], o[1][0]];
        if (b1 - b0 > Math.max(sc === by ? 1 : 5, b0)) { m = cands[o[0][1]]; how = m.h; status = "unique"; reason = "closest of " + cands.length + (sc === by ? " in time" : " in position"); } }
      if (!m) { status = "ambiguous"; reason = cands.length + " candidates fit about equally"; }
    }
    // 2) time, when no identifier matched: the nearest exposure within 3 s, unless a second one is within 0.5 s of it
    if (!m && status !== "ambiguous" && S.utcMs != null) for (const l of timed) {
      const arr = l.exposures.filter(e => e.t != null); if (!arr.length) continue; const e = nearest(arr, S.utcMs); if (!e || Math.abs(e.t - S.utcMs) >= 3000) continue;
      const w = whyNot(S, e); if (w) { if (!rejected.some(x => x.log === l.name && x.n === e.n)) rejected.push({ log: l.name, n: e.n, why: w }); continue; }
      const i = arr.indexOf(e), nb = [arr[i - 1], arr[i + 1]].filter(Boolean).filter(x => Math.abs(x.t - S.utcMs) < 3000 && Math.abs(x.t - S.utcMs) - Math.abs(e.t - S.utcMs) < 500);
      cands.push({ l, e, h: "time" }); for (const x of nb) cands.push({ l, e: x, h: "time" });
      if (nb.length) { status = "ambiguous"; reason = "exposures " + [e, ...nb].map(x => "#" + x.n).join(", ") + " within 0.5 s of each other"; break; }
      m = { l, e }; how = "time"; status = "unique"; break;
    }
    const audit = { status, candidates: cands.length, alternatives: cands.filter(c => !m || c.e !== m.e).slice(0, 4).map(c => { const x = short(c); return { log: x.log, n: x.n, dt: x.dt(S) }; }), rejected: rejected.slice(0, 4), reason };
    if (!m && !reason && rejected.length) audit.reason = "only candidates rejected as too far";
    if (m) { used.add(m.l);
      // time of the exposure: from the matched record, else the same image in another timed log, else the nearest camera event
      let et = m.e.t, tl = m.l.name;
      if (et == null) for (const l of timed) { const e = m.e.name && l.exposures.find(x => x.name === m.e.name && x.t != null); if (e) { et = e.t; tl = l.name; break; } }
      if (et == null && S.utcMs != null) for (const l of timed.filter(l => /sbf|bb3|mica-paramlog/.test(l.kind))) { const e = nearest(l.exposures.filter(e => e.t != null), S.utcMs); if (e && Math.abs(e.t - S.utcMs) < 3000) { et = e.t; tl = l.name; break; } }
      const dt = S.utcMs != null && et != null ? (S.utcMs - et) / 1000 : null; const dxy = distM(S, m.e);
      F.matches.push(Object.assign({ image: im.name, log: m.l.name, how, n: m.e.n, dt, timeLog: dt != null ? tl : null, dxy, dz: S.altAbs != null && m.e.h != null ? S.altAbs - m.e.h : null, q: m.e.q, sH: m.e.sH != null ? m.e.sH : m.e.sN != null ? Math.max(m.e.sN, m.e.sE) : null, sV: m.e.sV, c2pa: !!im.c2pa }, audit)); }
    else F.matches.push(Object.assign({ image: im.name, log: null }, audit));
  }
  // two different shots claiming one exposure (a renamed or duplicated file): both keep the match but are marked as a conflict
  { const byExp = new Map(); for (const x of F.matches) if (x.log) { const k = x.log + "#" + x.n; if (!byExp.has(k)) byExp.set(k, []); byExp.get(k).push(x); }
    for (const g of byExp.values()) if (new Set(g.map(x => shotKey(x.image))).size > 1) for (const x of g) { x.status = "conflict"; x.reason = "exposure also matched by " + g.filter(y => y !== x).map(y => y.image).slice(0, 3).join(", "); } }
  const main = src[0];
  F.exposures = main ? main.exposures : [];
  // 1 counts
  if (main) {
    const shots = main.exposures[0] && main.exposures[0].name ? new Set(main.exposures.map(e => shotKey(e.name))).size : main.exposures.length;
    add("info", "cCount", main.name + ": " + shots + (images.length ? " · " + images.length : ""), shots);
    const cen = l => { const v = l.exposures.filter(e => e.lat != null && isFinite(e.lat)); return v.length ? { lat: median(v.map(e => e.lat)), lon: median(v.map(e => e.lon)) } : null; }, c0 = cen(main);
    const keys0 = main.exposures[0] && main.exposures[0].name ? new Set(main.exposures.map(e => shotKey(e.name))) : null;
    // two files of one kind naming entirely different images belong to different flights (e.g. the RGB and the multispectral geotags.csv of one day)
    // exposure windows that do not overlap in time belong to different flights (two WingtraOne flights of one day, each with its own ULog)
    const win = l => { const t = l.exposures.map(e => e.t).filter(x => x != null && isFinite(x)); return t.length ? [Math.min(...t), Math.max(...t)] : null; }, w0 = win(main);
    const apart = l => { const w = w0 && win(l); return !!w && (w[0] > w0[1] + 60000 || w[1] < w0[0] - 60000); };
    const disjoint = l => keys0 && l.kind === main.kind && l.exposures.length && l.exposures[0].name && !l.exposures.some(e => keys0.has(shotKey(e.name)));
    for (const l of src.slice(1)) {
      const c = cen(l), far = c && c0 && Math.hypot((c.lat - c0.lat) * 111320, (c.lon - c0.lon) * 111320 * Math.cos(c0.lat / R2D)) > 5000;
      const other = far || (l.session && main.session && l.session !== main.session) || (l.startMs != null && main.startMs != null && (l.startMs > main.endMs + 3600000 || l.endMs < main.startMs - 3600000)) || (l.kind === main.kind && (l.startMs == null) !== (main.startMs == null)) || disjoint(l) || apart(l);
      if (other) { add("info", "cOtherFlight", l.name + (l.startMs != null ? " · " + isoS(l.startMs) : "")); l._other = true; continue; } const n2 = l.exposures[0] && l.exposures[0].name ? new Set(l.exposures.map(e => shotKey(e.name))).size : l.exposures.length; if (Math.abs(n2 - shots) > Math.max(2, 0.01 * shots)) add("warn", "cCountMismatch", main.name + " " + shots + " ≠ " + l.name + " " + n2); }
  } else add("info", "cNoExposures", "");
  if (images.length && src.length) { const ok = F.matches.filter(m => m.log).length; add(ok === images.length ? "ok" : ok ? "warn" : "bad", "cMatched", ok + " / " + images.length + (ok ? " · " + Object.entries(countBy(F.matches.filter(m => m.log), m => m.how)).map(([k, v]) => k + ": " + v).join(", ") : ""));
    const amb = F.matches.filter(m => m.status === "ambiguous"), con = F.matches.filter(m => m.status === "conflict"), far = F.matches.filter(m => !m.log && m.status === "unmatched" && m.rejected && m.rejected.length);
    if (amb.length) add("warn", "cAmbiguous", amb.length + " · " + amb.slice(0, 3).map(m => m.image + " (" + m.reason + ")").join("; ") + (amb.length > 3 ? " …" : ""), amb.length);
    if (con.length) add("warn", "cMatchConflict", con.length + " · " + con.slice(0, 3).map(m => m.image + ": " + m.reason).join("; ") + (con.length > 3 ? " …" : ""), con.length);
    if (far.length) add("info", "cMatchRejected", far.length + " · " + far.slice(0, 3).map(m => m.image + ": " + m.rejected[0].log + " #" + m.rejected[0].n + ", " + m.rejected[0].why).join("; ") + (far.length > 3 ? " …" : ""), far.length); }
  // 2 clock offset camera vs GNSS log
  const dts = F.matches.map(m => m.dt).filter(x => x != null && Math.abs(x) < 86400);
  if (dts.length) { const md = median(dts), sp = Math.max(...dts) - Math.min(...dts), tl = [...new Set(F.matches.map(m => m.timeLog).filter(Boolean))]; add(Math.abs(md) <= 2 ? "ok" : "warn", "cClock", (md >= 0 ? "+" : "") + md.toFixed(2) + " s · " + (sp).toFixed(2) + " s · " + tl.join(", "), md); }
  // 3 position agreement image vs log
  const dxy = F.matches.map(m => m.dxy).filter(x => x != null);
  if (dxy.length) { const md = median(dxy); add(md <= 1 ? "ok" : md <= 10 ? "info" : "warn", "cPosDiff", md.toFixed(2) + " m (max " + Math.max(...dxy).toFixed(Math.max(...dxy) < 10 ? 2 : 0) + " m)", md); }
  // 4 solution quality of exposures
  const solQ = e => e.q && e.q !== "log" && e.q !== "event";   // "event": the receiver logged only the event time, no solution at it (raw rover)
  if (main && main.exposures.some(solQ)) {
    const c = countBy(main.exposures, e => e.q || "–"), n = main.exposures.length, good = (c.fixed || 0) + (c.ppk || 0);
    add(good === n ? "ok" : good > 0.95 * n ? "info" : "warn", "cSolution", Object.entries(c).map(([k, v]) => k + ": " + v).join(", "), good / n);
    const sH = median(main.exposures.map(e => e.sH != null ? e.sH : e.sN != null ? Math.max(e.sN, e.sE) : null)); if (sH != null) add(sH <= 0.05 ? "ok" : sH <= 0.5 ? "info" : "warn", "cSigma", sH.toFixed(3) + " m", sH);
  }
  // 4b flight state at the exposures (atExposure), from the main log or else the first log of this flight that records it
  const ax = [main].concat(src).find(l => l && !l._other && l.atExp);
  if (ax) { const S = ax.atExp, parts = [], sts = [], P = (state, txt) => { sts.push(state); parts.push(txt); };
    if (S.gnss) { const g = S.gnss; P(g.low ? "warn" : "ok", "GNSS " + [g.svMed != null ? g.svMed + " satellites (min " + g.svMin + ")" : null, g.hdopMax != null ? "HDOP max " + g.hdopMax : null, g.ephMax != null ? "eph max " + g.ephMax + " m" : null, "below 3D fix: " + g.low].filter(Boolean).join(", ")); }
    if (S.vib) { const v = S.vib; P(v.over60 || v.clip >= 100 ? "warn" : v.over30 || v.clip ? "info" : "ok", "vibration max " + v.max + " m/s² (over 30: " + v.over30 + ", over 60: " + v.over60 + "), clipping +" + v.clip); }
    if (S.modes) { const m = S.modes; P(m.out ? "warn" : m.unknown ? "info" : "ok", m.out ? "outside the automatic mission: " + m.out + " (" + m.outNames.join(", ") + ")" : "mode " + m.names.join(", ")); }
    if (S.ev) P(S.ev.err ? "warn" : "info", "autopilot errors and warnings: " + S.ev.n + " (" + S.ev.first.join("; ") + (S.ev.kinds > 3 ? "; …" : "") + ")");
    if (S.interp) P("info", "interpolated positions: " + S.interp);
    const R = { ok: 0, info: 1, warn: 2, bad: 3 }; if (parts.length) add(sts.reduce((a, b) => R[b] > R[a] ? b : a, "ok"), "cAtExposure", ax.name + ": " + parts.join(" · ")); }
  const ini = logs.find(l => l.kind === "wingtra-ini"); if (ini && ini.rtkFix != null) add(ini.rtkFix >= 95 ? "ok" : "warn", "cPpkFix", ini.rtkFix + " %");
  // flight window: logs of this flight that overlap the images (other flights and base stations left out)
  const imT = images.map(i => i.S && i.S.utcMs).filter(x => x != null);
  const win = imT.length ? [Math.min(...imT) - 3600000, Math.max(...imT) + 3600000] : null;
  for (const l of logs) { if (l.startMs != null && !l._other && !(l.raw && l.raw.role === "base") && (!win || (l.endMs >= win[0] && l.startMs <= win[1]))) { if (F.startMs == null || l.startMs < F.startMs) F.startMs = l.startMs; if (F.endMs == null || l.endMs > F.endMs) F.endMs = l.endMs; } }
  if (F.startMs == null && imT.length) { F.startMs = Math.min(...imT); F.endMs = Math.max(...imT); }
  // 5 raw GNSS for PPK, base coverage
  const rover = logs.filter(l => l.raw && l.raw.epochs && l.raw.role !== "base" && !(l.raw.format === "RINEX" && l.raw.type === "nav"));
  const bases = logs.filter(l => l.base && l.base.startMs != null);
  add(rover.length ? "ok" : "info", rover.length ? "cRawRover" : "cNoRawRover", rover.map(l => l.name + " (" + l.raw.epochs + (l.raw.interval ? " × " + l.raw.interval + " s" : "") + ")").join(", "));
  if (bases.length) {
    // files of one station (same marker and interval, for example 15-minute 1 s files) are joined when they follow each other
    const groups = new Map(); for (const b of bases) { const k = (b.base.marker || b.name) + "|" + (b.base.interval || ""); (groups.get(k) || groups.set(k, []).get(k)).push(b); }
    const cen = (() => { const p = (main && main.exposures.filter(e => e.lat != null)) || []; const t = p.length ? p : logs.filter(l => !l._other && !(l.raw && l.raw.role === "base")).flatMap(l => l.trajectory.filter(q => q.lat != null)); return t.length ? { lat: median(t.map(q => q.lat)), lon: median(t.map(q => q.lon)) } : null; })();
    for (const g of groups.values()) {
      g.sort((x, y) => x.base.startMs - y.base.startMs); const tol = Math.max(2000, 2.5 * 1000 * (g[0].base.interval || 1)), segs = [];
      for (const b of g) { const z = segs[segs.length - 1]; if (z && b.base.startMs <= z[1] + tol) z[1] = Math.max(z[1], b.base.endMs); else segs.push([b.base.startMs, b.base.endMs]); }
      const cov = F.startMs != null && segs.some(z => z[0] <= F.startMs && z[1] >= F.endMs), nm = g.length > 1 ? (g[0].base.marker || g[0].name) + " (" + g.length + " files" + (g[0].base.interval ? ", " + g[0].base.interval + " s" : "") + ")" : g[0].name + (g[0].base.interval ? " (" + g[0].base.interval + " s)" : "");
      add(cov ? "ok" : "warn", cov ? "cBaseCovers" : "cBaseGap", nm + ": " + segs.map(z => isoS(z[0]) + " – " + isoS(z[1])).join(", "));
      const a = g[0].base.approx, mk = g[0].base.marker || g[0].name; if (a && cen && !F.checks.some(c => c.key === "cBaseDist" && c.det.startsWith(mk + ":"))) { const d = Math.hypot((a.lat - cen.lat) * 111320, (a.lon - cen.lon) * 111320 * Math.cos(cen.lat / R2D)) / 1000; add(d <= 10 ? "ok" : d <= 30 ? "info" : "warn", "cBaseDist", mk + ": " + d.toFixed(d < 10 ? 1 : 0) + " km", d); }
    }
  }
  else if (logs.some(l => l.base)) add("info", "cBaseKnown", logs.filter(l => l.base).map(l => l.name).join(", "));
  else add("info", "cNoBase", "");
  // 6 flight lines
  const hb = main && headingBins(main.exposures.filter((e, k, a) => !e.name || k === 0 || shotKey(e.name) !== shotKey(a[k - 1].name)));
  if (hb) add(hb.opposite ? "ok" : "info", hb.opposite ? "cOpposite" : "cOneWay", Math.round(hb.main) + "° " + Math.round(100 * hb.share) + " % · " + ((hb.main + 180) % 360) + "° " + Math.round(100 * hb.oppShare) + " %");
  // 7 panels
  const pj = logs.find(l => l.panels); const pImg = images.filter(i => i.S && i.S.panel).map(i => i.name);
  if (pj) add(pj.panels.preflight.length || pj.panels.postflight.length ? "ok" : "info", "cPanels", "preflight " + pj.panels.preflight.length + " · postflight " + pj.panels.postflight.length);
  else if (pImg.length) add("ok", "cPanelImages", pImg.join(", "));
  // 8 time span, sun
  if (F.startMs != null) { add("info", "cSpan", isoS(F.startMs) + " – " + isoS(F.endMs) + " (" + ((F.endMs - F.startMs) / 60000).toFixed(1) + " min)");
    const p = (main && main.exposures.find(e => e.lat != null)) || (logs.find(l => l.trajectory.length) || { trajectory: [] }).trajectory[0];
    if (p && solar) { const mid = (F.startMs + F.endMs) / 2, s = solar(mid, p.lat, p.lon); const thermal = images.length && images.every(i => i.S && /thermal/i.test(i.S.sensorType || "")) || logs.some(l => /thermo|duet|thermal/i.test(JSON.stringify(l.device)));
      add(s.elevation >= 30 ? "ok" : s.elevation >= 15 || thermal ? "info" : "warn", thermal ? "cSunThermal" : "cSun", s.elevation.toFixed(1) + "° · az " + s.azimuth.toFixed(0) + "°", s.elevation); } }
  // 9 originality
  const c2 = images.filter(i => i.c2pa).length; if (c2) add("warn", "cC2pa", c2 + " / " + images.length);
  // 10 logs that could not be read
  // Wingtra LiDAR: the recordings that service.log wrote against the .data files that ppk.pcmp processes
  { const rec = logs.filter(l => l.lidar && l.lidar.recorded), prj = logs.filter(l => l.lidar && l.lidar.data);
    if (rec.length && prj.length) { const a = new Set(rec.flatMap(l => l.lidar.recorded)), b = new Set(prj.flatMap(l => l.lidar.data)), miss = [...b].filter(x => !a.has(x)), extra = [...a].filter(x => !b.has(x));
      add(miss.length || extra.length ? "warn" : "ok", "cLidarFiles", a.size + " / " + b.size + (miss.length ? " · not recorded: " + miss.join(", ") : "") + (extra.length ? " · not in project: " + extra.join(", ") : "")); } }
  // Wingtra LiDAR .data parts: each part must begin with exactly the bytes of the record cut at the end of the previous one
  { const parts = logs.filter(l => l.lidar && l.lidar.file && l.lidar.part != null), groups = {};
    for (const l of parts) (groups[l.lidar.file.replace(/-\d{3}\.data$/i, "")] = groups[l.lidar.file.replace(/-\d{3}\.data$/i, "")] || []).push(l);
    for (const [base, g] of Object.entries(groups)) { if (g.length < 2 && g[0].lidar.part === 1 && g[0].lidar.need == null) continue;
      g.sort((x, y) => x.lidar.part - y.lidar.part); const bad = [];
      if (g[0].lidar.part !== 1) bad.push("first part " + String(g[0].lidar.part).padStart(3, "0"));
      for (let k = 1; k < g.length; k++) { const a = g[k - 1].lidar, b = g[k].lidar; if (b.part !== a.part + 1) bad.push("missing " + String(a.part + 1).padStart(3, "0")); else if ((a.need || 0) !== (b.lead || 0)) bad.push(String(a.part).padStart(3, "0") + " → " + String(b.part).padStart(3, "0") + ": " + (a.need || 0) + " ≠ " + (b.lead || 0) + " B"); }
      const last = g[g.length - 1].lidar; if (last.need != null) bad.push("after " + String(last.part).padStart(3, "0") + " a further part is expected");
      add(bad.length ? "warn" : "ok", "cLidarParts", base.split("/").pop() + " · " + g.length + (bad.length ? " · " + bad.join("; ") : "")); } }
  for (const l of logs) { const v = l.verify || {};
    if (v.state === "new") add(v.standard ? "info" : "warn", "cUnverified", l.name + ": " + (v.key || "?") + (v.known ? " · ✓ " + v.known : ""));
    if (l.notes.includes("implausible")) add("warn", "cImplausible", l.name + ": " + factOf(l, "fImplausible"));
    if (l.notes.includes("nothing-read")) add("warn", "cNothingRead", l.name);
    if (l.notes.includes("csv-unmapped")) add("warn", "cCsvMap", l.name + ": " + l.csv.cols.join(", "));
    if (l.encrypted) add("info", l.device && (l.device.serial || l.device.model) || l.startMs != null ? "cEncryptedSum" : "cEncrypted", l.name); if (l.error) add("bad", "cParseError", l.name + ": " + l.error); if (l.notes.includes("clock-jump")) add("info", "cClockJump", l.name); if (l.notes.includes("kml-geoid")) add("info", "cKmlGeoid", l.name); }
  return F;
}

/* ---------------------------------------------------------------- survey geometry (works from log exposures or from image positions alone) */
// pts: [{lat, lon, t (ms), yaw (camera heading, deg)}]; cam: {agl (m), foot: [across-image width, along-image height] in m on the ground, gsd (m), exposure (s), speeds: [m/s per image]}
function geometry(pts, cam) {
  cam = cam || {}; const P = (pts || []).filter(p => p && p.lat != null && isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) > 0.01).slice().sort((a, b) => (a.t == null || b.t == null) ? 0 : a.t - b.t);
  const G = { n: P.length, source: cam.source || "" }; if (P.length < 3) return G;
  const lat0 = median(P.map(p => p.lat)), lon0 = median(P.map(p => p.lon)), kx = 111320 * Math.cos(lat0 / R2D);
  const xy = P.map(p => [(p.lon - lon0) * kx, (p.lat - lat0) * 111320]);
  const steps = []; for (let k = 1; k < P.length; k++) { const dx = xy[k][0] - xy[k - 1][0], dy = xy[k][1] - xy[k - 1][1], d = Math.hypot(dx, dy); steps.push({ k, d, h: (Math.atan2(dx, dy) * R2D + 360) % 360, dt: P[k].t != null && P[k - 1].t != null ? (P[k].t - P[k - 1].t) / 1000 : null }); }
  // flight lines: runs of steps that keep their heading within 20 degrees
  const adiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const lines = []; let curL = null;
  for (const s of steps) { if (s.d < 0.5) continue; if (curL && adiff(s.h, curL.h) <= 20) { curL.steps.push(s); curL.idx.push(s.k); } else { curL = { h: s.h, steps: [s], idx: [s.k - 1, s.k] }; lines.push(curL); } }
  const good = lines.filter(l => l.steps.length >= 2); G.lines = good.length;
  if (!good.length) return G;
  const inLine = good.flatMap(l => l.steps), sp = inLine.map(s => s.d), dts = inLine.map(s => s.dt).filter(x => x != null && x > 0);
  G.spacing = median(sp);
  if (dts.length) { G.interval = median(dts); const v = inLine.filter(s => s.dt > 0).map(s => s.d / s.dt); G.speed = median(v); }
  const cv = a => { if (a.length < 4) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return m ? Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length) / m : null; };
  const cvD = cv(sp), cvT = cv(dts); G.cvSpacing = cvD; G.cvInterval = cvT;
  // trigger: only when one of distance and time is clearly steadier than the other (at constant speed both are steady and the mode cannot be told)
  if (cvD != null && cvT != null) G.trigger = cvD < 0.05 && cvT > 3 * cvD && cvT > 0.05 ? "distance" : cvT < 0.05 && cvD > 3 * cvT && cvD > 0.05 ? "time" : null;
  // main direction from the longest lines; line spacing from cross-track offsets of lines parallel to it
  const lineH = l => { const a = l.idx[0], b = l.idx[l.idx.length - 1]; return (Math.atan2(xy[b][0] - xy[a][0], xy[b][1] - xy[a][1]) * R2D + 360) % 360; };
  const byLen = good.slice().sort((a, b) => b.steps.length - a.steps.length), h0 = lineH(byLen[0]) % 180;
  G.heading = h0;
  const par = good.filter(l => adiff(lineH(l) % 180, h0) <= 15 || adiff(lineH(l) % 180, h0) >= 165), perp = good.filter(l => Math.abs(adiff(lineH(l) % 180, h0) - 90) <= 15);
  const nx = Math.cos(h0 / R2D), ny = -Math.sin(h0 / R2D); // unit vector across the track (heading measured from north, clockwise)
  const offs = par.map(l => median(l.idx.map(i => xy[i][0] * nx + xy[i][1] * ny))).sort((a, b) => a - b);
  const gaps = []; for (let k = 1; k < offs.length; k++) { const g = offs[k] - offs[k - 1]; if (g > Math.max(1, 0.2 * G.spacing)) gaps.push(g); }
  if (gaps.length) G.lineSpacing = median(gaps);
  const nPar = par.reduce((x, l) => x + l.steps.length, 0), nPerp = perp.reduce((x, l) => x + l.steps.length, 0);
  G.pattern = par.length >= 2 && perp.length >= 2 && nPerp >= 0.25 * nPar ? "double_grid" : par.length >= 2 && gaps.length ? "single_grid" : good.length === 1 ? "linear" : null;
  // footprint along and across the track: the image height lies along the camera heading
  if (cam.foot && cam.foot[0] > 0 && cam.foot[1] > 0) {
    const yaws = P.map(p => p.yaw).filter(x => x != null && isFinite(x)), rel = yaws.length ? median(yaws.map(y => adiff(y % 180, h0))) : null;
    const across = rel != null && rel > 45 && rel < 135; G.orient = rel == null ? "assumed" : across ? "rotated" : "along";
    const along = across ? cam.foot[0] : cam.foot[1], side = across ? cam.foot[1] : cam.foot[0];
    G.footAlong = along; G.footAcross = side;
    G.overlapForward = Math.round(100 * (1 - G.spacing / along));
    if (G.lineSpacing != null) G.overlapSide = Math.round(100 * (1 - G.lineSpacing / side));
  }
  // motion blur in pixels: ground speed x exposure time / GSD
  const vs = (cam.speeds || []).filter(x => x != null && isFinite(x)), v = vs.length >= 3 ? median(vs) : G.speed; // speed at exposure from the images when there are enough, else from the spacing
  if (v != null && cam.exposure > 0 && cam.gsd > 0) { G.blurPx = v * cam.exposure / cam.gsd; G.blurSpeed = v; }
  return G;
}
function geometryChecks(G) {
  const out = [], add = (state, key, det, val) => out.push({ state, key, det: det || "", val });
  if (!G || G.n < 3 || !G.lines) return out;
  const f1 = x => x == null ? "–" : x.toFixed(1);
  add("info", "gLines", G.lines + " · " + f1(G.spacing) + " m" + (G.interval != null ? " · " + f1(G.interval) + " s" : "") + (G.speed != null ? " · " + f1(G.speed) + " m/s" : "") + (G.pattern ? " · " + G.pattern : ""));
  if (G.overlapForward != null) add(G.overlapForward >= 70 ? "ok" : G.overlapForward >= 60 ? "info" : "warn", "gForward", G.overlapForward + " % (" + f1(G.spacing) + " m / " + f1(G.footAlong) + " m)" + (G.orient === "assumed" ? " *" : ""), G.overlapForward);
  if (G.overlapSide != null) add(G.overlapSide >= 60 ? "ok" : G.overlapSide >= 50 ? "info" : "warn", "gSide", G.overlapSide + " % (" + f1(G.lineSpacing) + " m / " + f1(G.footAcross) + " m)" + (G.orient === "assumed" ? " *" : ""), G.overlapSide);
  if (G.blurPx != null) add(G.blurPx <= 0.5 ? "ok" : G.blurPx <= 1.5 ? "info" : "warn", "gBlur", G.blurPx.toFixed(2) + " px (" + f1(G.blurSpeed) + " m/s)", G.blurPx);
  return out;
}

// camera angles for SfM software (Pix4D, Metashape: yaw from north to the image top, pitch 0 = nadir, roll 0 = level)
// from DJI-style gimbal angles (pitch −90 = nadir). DJI may write a nadir shot as roll 180 with yaw turned by 180;
// (yaw, pitch, roll) and (yaw + 180, 180 − pitch, roll + 180) are the same rotation, so roll is brought back to ±90.
function sfmAngles(yaw, pitch, roll) {
  if (![yaw, pitch].every(x => x != null && isFinite(x))) return null;
  roll = roll != null && isFinite(roll) ? +roll : 0; yaw = +yaw; pitch = +pitch;
  const w = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
  if (Math.abs(w(roll)) > 90) { yaw += 180; pitch = 180 - pitch; roll += 180; }
  const r = x => +x.toFixed(3);
  return { yaw: r(((yaw % 360) + 360) % 360), pitch: r(w(pitch) + 90), roll: r(w(roll)) };
}

/* the processing record of each loaded project, in the shape of metadata.json (processing[], products[]) plus what provenance.json needs */
const MS_PRODUCT_STEP = { "point cloud": /^Build(Point|Dense)Cloud$/, "3D model (mesh)": /^BuildModel$/, "tiled model": /^BuildTiledModel$/, DTM: /^BuildDem$/, DSM: /^BuildDem$/, DEM: /^BuildDem$/, orthomosaic: /^BuildOrthomosaic$/ };
// conversion_log.csv and processing_record.json of the same ThermoTIFF run are one workflow: joined here
function ttMerge(list) {
  const tt = list.filter(l => l.proc.source === "thermotiff"); if (tt.length < 2) return list;
  const log = tt.find(l => l.kind === "thermotiff-log"), rec = tt.find(l => l.kind === "thermotiff-record"); if (!log || !rec) return list;
  const a = log.proc, b = rec.proc, s1 = Object.assign({}, b.steps[0], { parameters: Object.assign({}, b.steps[0].parameters, a.steps[0].parameters, { record_created: b.steps[0].parameters.record_created }), duration_s: a.steps[0].duration_s });
  const m = { name: rec.name, kind: rec.kind, logs: [log.name, rec.name], proc: Object.assign({}, b, { steps: [s1].concat(b.steps.slice(1)), thermal_settings: a.thermal_settings, images: a.images }) };
  return list.filter(l => l !== log && l !== rec).concat([m]);
}
function procRecord(logs) {
  return ttMerge((logs || []).filter(l => l && l.proc)).map((l, i) => {
    const p = l.proc, wf = "WF" + (i + 1);
    const steps = p.steps.map(s => ({ order: s.order, name: s.name, method: s.method, parameters: Object.assign({}, s.parameters, s.duration_s != null ? { duration_s: s.duration_s } : {}, s.memory_bytes != null ? { memory_bytes: s.memory_bytes } : {}, s.software_version ? { software_version: s.software_version } : {}) }));
    const processing = { workflow_id: wf, software: p.software.map(s => Object.assign({ name: s.name, version: s.version }, s.note ? { note: s.note } : p.software_note ? { note: p.software_note } : {})), steps,
      photogrammetry_settings: p.photogrammetry_settings || {}, adjustment_quality: p.adjustment_quality || {} };
    if (p.thermal_settings) processing.thermal_settings = p.thermal_settings; if (p.atmospheric_model) processing.atmospheric_model = p.atmospheric_model;
    if (p.source === "thermotiff") { delete processing.photogrammetry_settings; delete processing.adjustment_quality; }
    if (p.output_crs) processing.output_crs = p.output_crs;
    const products = p.products.map(x => Object.assign({ product_type: x.type }, x.format ? { format: x.format } : {}, p.output_crs ? { crs: p.output_crs } : {}, { workflow_id: wf }, p.vertical && /^(DSM|DTM|DEM|point cloud|3D)/.test(x.type) ? { vertical_crs: p.vertical } : {}));
    // which step made which product (Pix4D: by step number; Metashape: by step name)
    const stepOf = x => p.source === "p4d" || p.source === "thermotiff" ? p.steps.find(s => s.order === x.step) : p.steps.find(s => MS_PRODUCT_STEP[x.type] && MS_PRODUCT_STEP[x.type].test(s.id));
    const made = p.products.map(stepOf).map(s => s ? s.order : null);
    return { log: l.name, logs: l.logs || [l.name], kind: l.kind, wf, processing, products, made, steps: p.steps, software: p.software, vertical: p.vertical, gcp: p.gcp, geometry: p.geometry || [], saved_local: p.saved_local, source: p.source, images: p.images || [] };
  });
}
/* ---------------------------------------------------------------- values for the OpenSkyLab check taken from the flight logs */
function exposureOf(logs, m) { const l = m && m.log && logs.find(x => x.name === m.log); return l ? l.exposures.find(e => e.n === m.n) || null : null; }
function oslFromFlight(logs, F) {
  logs = (logs || []).filter(Boolean); const out = { mission: {}, images: {} }; if (!F || !logs.length) return out;
  const own = logs.filter(l => !l._other), names = own.map(l => l.name);
  const set = (k, val, src, note) => { if (val != null && val !== "" && !(typeof val === "number" && !isFinite(val))) out.mission[k] = { val, src, note: note || "" }; };
  const main = own.find(l => l.exposures.length && l.exposures === F.exposures) || null;
  const flightLogs = own.filter(l => !(l.raw && l.raw.role === "base"));
  if (F.startMs != null) { set("mission.start_utc", iso(F.startMs), flightLogs.map(l => l.name).join(", "), "nLogSpan"); set("mission.end_utc", iso(F.endMs), flightLogs.map(l => l.name).join(", "), "nLogSpan"); }
  set("mission.flight_log_ref", names.join("; "), "File:FileName", "nLogRef");
  for (const l of logs) { const P = l.plan; if (!P) continue; const src = l.name + " (plan)";
    set("mission.planning_software", P.software, src, "nPlan"); set("mission.flight_pattern", P.pattern, src, "nPlan"); set("mission.nominal_agl", P.agl, src, "nPlanAgl");
    set("mission.overlap_forward", P.front, src, "nPlan"); set("mission.overlap_side", P.side, src, "nPlan"); set("mission.gimbal_pitch_nominal", P.gimbalPitch, src, "nPlan"); set("mission.gsd_nominal", P.gsd, src, "nPlanGsd"); break; }
  if (main) {
    set("mission.n_images", main.exposures[0] && main.exposures[0].name ? new Set(main.exposures.map(e => shotKey(e.name))).size : main.exposures.length, main.name, "nLogCount");
    const c = countBy(main.exposures.filter(e => e.q), e => e.q), n = main.exposures.filter(e => e.q).length;
    if (n) { const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0], mode = top === "ppk" ? "PPK" : /^(fixed|float|int|rtk)$/.test(top) ? "RTK" : top === "single" ? "single" : top === "dgps" ? "DGNSS" : null;
      set("mission.gnss_mode", mode, main.name + " (" + Object.entries(c).map(([k, v]) => k + ": " + v).join(", ") + ")", "nLogGnss"); }
  }
  const clk = F.checks.find(x => x.key === "cClock"); if (clk && clk.val != null) set("mission.time_sync_offset", +clk.val.toFixed(3), "image − log, median", "nLogClock");
  const bases = own.filter(l => l.base && (l.base.marker || l.base.approx));
  if (bases.length) { const b = bases[0].base, a = b.approx; set("mission.gnss_correction_source", (b.marker ? "base " + b.marker : "base") + (a ? " (approx. " + a.lat.toFixed(5) + ", " + a.lon.toFixed(5) + ", RINEX header)" : ""), bases.map(l => l.name).join(", "), "nLogBase"); }
  // processing project (Pix4D, Metashape): the processing block, the products and the GCP counts; calibration per sensor (matched by image size)
  const PR = procRecord(logs)[0];
  if (PR) {
    const setp = (k, val, note) => { if (val == null || (typeof val === "object" && !Object.keys(val).length)) return; set(k, val, PR.logs.join(" + "), note); if (out.mission[k]) out.mission[k].log = PR.log; };
    const p = PR.processing;
    setp("processing.workflow_id", p.workflow_id, "nProcWf"); setp("processing.software", p.software, "nProcSw"); setp("processing.steps", p.steps, "nProc");
    setp("processing.thermal_settings", p.thermal_settings, "nProcTt"); setp("processing.atmospheric_model", p.atmospheric_model, "nProcTt");
    setp("processing.photogrammetry_settings", p.photogrammetry_settings, "nProc"); setp("processing.adjustment_quality", p.adjustment_quality, "nProc"); setp("processing.output_crs", p.output_crs, "nProcCrs");
    if (PR.products.length) { setp("product.product_type", [...new Set(PR.products.map(x => x.product_type))].join(", "), "nProcProd"); setp("product.crs", p.output_crs, "nProcCrs");
      setp("product.workflow_id", p.workflow_id, "nProcWf"); setp("product.vertical_crs", PR.vertical, "nProc"); }
    if (PR.gcp) { setp("mission.gcp_count", PR.gcp.control, "nProcGcp"); if (PR.gcp.check != null) setp("mission.checkpoint_count", PR.gcp.check, "nProcGcp"); }
    out.procGeom = PR.geometry.filter(g => g.cal && g.w && g.h).map(g => { const c = g.cal, v = {}, put = (k, val) => { if (val != null && !(Array.isArray(val) && !val.length)) v[k] = { val, src: PR.log + " (" + g.label + ", adjusted)", note: "nProcCal", log: PR.log }; };
      put("geometry.calibrated_focal_length", c.f != null && g.pixel_mm ? +(c.f * g.pixel_mm).toFixed(4) : null);
      put("geometry.calibrated_optical_centre", c.cx != null && c.cy != null ? [+(g.w / 2 + c.cx).toFixed(3), +(g.h / 2 + c.cy).toFixed(3)] : null);
      put("geometry.radial_distortion", c.k); put("geometry.tangential_distortion", c.p); put("geometry.nonorthogonality", c.b1 != null || c.b2 != null ? [c.b1 || 0, c.b2 || 0] : null);
      put("geometry.distortion_model", "Brown (Agisoft Metashape frame model: f, cx, cy, b1, b2, k1–k4, p1–p4)");
      return { w: g.w, h: g.h, label: g.label, vals: v }; });
  }
  // per image: the matched exposure, with the image's own value kept for comparison
  for (const m of F.matches || []) {
    const e = exposureOf(logs, m); if (!e) continue; const l = logs.find(x => x.name === m.log), ell = /^ellipsoid/.test(factOf(l, "fHeight"));
    const r = {}, put = (col, val, note) => { if (val != null && val !== "" && !(typeof val === "number" && !isFinite(val))) r[col] = { val, src: l.name + " #" + e.n, note: note || "" }; };
    const ip = e.interp ? "nInterp" : "";   // interpolated from the trajectory: an estimate
    put("timestamp_utc", iso(e.t)); put("lat_deg", e.lat != null ? +e.lat.toFixed(9) : null, ip); put("lon_deg", e.lon != null ? +e.lon.toFixed(9) : null, ip);
    if (e.h != null) { if (ell) put("alt_ellipsoid_m", +(+e.h).toFixed(3), ip); else r._hNote = factOf(l, "fHeight"); }
    if (e.q && /^(fixed|int|float|single|ppk)$/.test(e.q)) put("rtk_flag", e.q);
    const sx = e.sE != null ? e.sE : e.sH, sy = e.sN != null ? e.sN : e.sH; put("sigma_x_m", sx); put("sigma_y_m", sy); put("sigma_z_m", e.sV);
    out.images[m.image] = { log: m.log, n: e.n, how: m.how, status: m.status, candidates: m.candidates, dt: m.dt, dxy: m.dxy, dz: ell ? m.dz : null, cols: r };
  }
  return out;
}
// agreement of an image value with the log value of the same column; null when they cannot be compared
function agree(col, imgVal, logVal, match) {
  if (imgVal == null || imgVal === "" || logVal == null || logVal === "") return null;
  if (col === "lat_deg" || col === "lon_deg") return match && match.dxy != null ? (match.dxy <= 1 ? "same" : "differ") : null;
  if (col === "alt_ellipsoid_m") return Math.abs(+imgVal - +logVal) <= 1 ? "same" : "differ";
  if (col === "timestamp_utc") { const a = Date.parse(imgVal), b = Date.parse(logVal); return isFinite(a) && isFinite(b) ? (Math.abs(a - b) <= 500 ? "same" : "differ") : null; }
  if (col === "rtk_flag") return String(imgVal) === String(logVal) ? "same" : "differ";
  if (/^sigma_/.test(col)) return Math.abs(+imgVal - +logVal) <= Math.max(0.01, 0.2 * Math.abs(+logVal)) ? "same" : "differ";
  return null;
}

/* ---------------------------------------------------------------- exports */
const EXP_COLS = ["source", "n", "name", "capture_id", "time_utc", "lat", "lon", "h_m", "sigma_h_m", "sigma_v_m", "solution", "image", "match", "dt_s", "dxy_m", "position", "satellites", "hdop", "eph_m", "vibration_m_s2", "flight_mode"];
function csvCell(v) { const s = v == null ? "" : String(v); return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exposuresCSV(logs, F) {
  const lines = [EXP_COLS.join(",")], byLog = new Map(); for (const m of (F && F.matches) || []) if (m.log) byLog.set(m.log + "#" + m.n, m);
  for (const l of logs) { if (l.listOnly) continue; for (const e of l.exposures) { const m = byLog.get(l.name + "#" + e.n) || {};
    lines.push([l.name, e.n, e.name || "", e.captureId || "", iso(e.t) || "", e.lat != null ? e.lat.toFixed(9) : "", e.lon != null ? e.lon.toFixed(9) : "", e.h != null ? (+e.h).toFixed(3) : "", e.sH != null ? e.sH : e.sN != null ? Math.max(e.sN, e.sE) : "", e.sV != null ? e.sV : "", e.q || "", m.image || "", m.how || "", m.dt != null ? m.dt.toFixed(3) : "", m.dxy != null ? m.dxy.toFixed(3) : "",
      e.interp ? "interpolated" : e.lat != null ? "log" : "", e.sv != null ? e.sv : "", e.hdop != null ? e.hdop : "", e.eph != null ? e.eph : "", e.vib != null ? e.vib : "", e.mode || ""].map(csvCell).join(",")); } }
  return lines.join("\r\n") + "\r\n";
}
function flightJSON(logs, F) {
  return JSON.stringify({ generator: "OpenSkyLab flight reader " + VERSION, start_utc: iso(F.startMs), end_utc: iso(F.endMs),
    logs: logs.map(l => ({ file: l.name, kind: l.kind, bytes: l.size, device: l.device, start_utc: iso(l.startMs), end_utc: iso(l.endMs), time_source: l.timeSource, facts: Object.fromEntries(l.facts.map(f => [f[0], f[1]])), raw: l.raw, base: l.base, exposures: l.exposures.length, notes: l.notes, encrypted: l.encrypted || undefined, version_check: l.verify ? { state: l.verify.state, version: l.verify.key, verified: l.verify.known } : undefined, implausible: l.sanity && Object.keys(l.sanity).length ? l.sanity : undefined })),
    checks: F.checks.map(c => ({ state: c.state, check: c.key, detail: c.det })), matches: F.matches }, null, 2) + "\n";
}

return { VERSION, VERIFIED, sniff, parse, combine, geometry, geometryChecks, oslFromFlight, procRecord, agree, sfmAngles, exposuresCSV, flightJSON, LOGNAME, gpsToUtc, ecefToGeo, _internal: { PARSERS, xmlTree, wktInfo, zipList, sanity, verify, versionKey, crc16, crc24, sbfState, ubxScan, BB3_ESC, headingBins, shotKey, djiIndex } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = OSLFlight;
/*OSL-FLIGHT-END*/
