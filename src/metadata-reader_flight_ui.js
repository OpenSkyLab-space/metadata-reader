/* ---------------------------------------------------------------- tab: flight (logs read by OSLFlight; function declarations only, this part follows the UI) */
function flightImages() { return batchFiles().map(f => ({ name: f.name, S: f.res.summary, captureId: tv(f, "CaptureId") != null ? String(tv(f, "CaptureId")) : null, c2pa: !!f.res.summary.c2pa })); }
function flightLogs() { return (st.logs || []).filter(l => l.L).map(l => l.L); }
function fltT(group, k) { const o = T[L][group] || T.cs[group] || {}; return o[k] != null ? o[k] : (T.cs[group] || {})[k] != null ? T.cs[group][k] : k; }
function fltVal(v) { let s = String(v == null ? "" : v); if (L === "cs") for (const [a, b] of T.cs.fltV) s = typeof a === "string" ? s.split(a).join(b) : s.replace(a, b); return dec(s); }
function fltTime(ms) { return ms == null ? "–" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$|Z$/, ""); }
async function addLogs(list) {
  st.logs = st.logs || [];
  for (const it of list) { const e = { id: ++uid, name: it.name, size: it.src.size != null ? it.src.size : it.src.length, busy: true, L: null, src: it.src, sha: null, readAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }; st.logs.push(e); }
  renderFiles(); afterLogs();
  for (const it of list) {
    const e = st.logs.find(x => x.name === it.name && x.busy);
    try { e.L = await OSLFlight.parse(it.src, it.name, {}); if (!e.L) e.err = "unknown"; } catch (err) { e.err = String(err && err.message || err); }
    e.busy = false; renderFiles(); afterLogs();
  }
}
function afterLogs() { renderSteps(); if (st.tab === "flt" || st.tab === "osl") renderTab(); }
// logs joined with the loaded images; recomputed only when the set of logs or images changes
function flightState() {
  const logs = flightLogs(), imgs = flightImages(), key = logs.map(l => l.name).join("|") + "#" + imgs.map(i => i.name).join("|");
  if (st._fk === key && st._fs) return st._fs;
  const F = logs.length ? OSLFlight.combine(logs, imgs, M.solarPosition) : null;
  st._fk = key; st.flight = F; st._fs = { logs, imgs, F, O: F ? OSLFlight.oslFromFlight(logs, F) : { mission: {}, images: {} } };
  st._fs.G = geomOf(st._fs); return st._fs;
}
// survey geometry from the main log's exposures, else from the image positions; camera from the images
function geomOf(FS) {
  const S = FS.imgs.map(i => i.S), S0 = S.find(s => s.footprint) || {}, main = FS.F && FS.F.exposures.filter(e => e.lat != null);
  const fromLog = !!(main && main.length >= 3), cam = { foot: S0.footprint, gsd: S0.gsd, exposure: S0.exposureTime, speeds: S.map(s => s.groundSpeed), source: fromLog ? "log" : "images" };
  // several bands or cameras per exposure: keep one position per shot
  const pts = fromLog ? main.filter((e, k, a) => !e.name || k === 0 || OSLFlight._internal.shotKey(e.name) !== OSLFlight._internal.shotKey(a[k - 1].name)).map(e => ({ lat: e.lat, lon: e.lon, t: e.t }))
    : FS.imgs.filter((x, k, a) => k === 0 || OSLFlight._internal.shotKey(x.name) !== OSLFlight._internal.shotKey(a[k - 1].name)).map(x => ({ lat: x.S.lat, lon: x.S.lon, t: x.S.utcMs, yaw: x.S.gimbal && x.S.gimbal.yaw != null ? x.S.gimbal.yaw : x.S.flight && x.S.flight.yaw }));
  const G = OSLFlight.geometry(pts, cam); G.source = cam.source; G.checks = OSLFlight.geometryChecks(G); return G;
}
function logListItems() {
  return (st.logs || []).map((l, i) => '<li><button class="fsel" data-lg="' + i + '" aria-pressed="false"><b>' + esc(l.name) + "</b><span>" + esc(l.busy ? t("fltReading") : l.L ? t("fltLog") + " · " + fltT("fltK", l.L.kind) + " · " + fmtBytes(l.size) : (l.err === "unknown" ? t("fltUnknown") : t("fltFailed")) + " · " + fmtBytes(l.size)) + '</span></button><button class="frm" data-rml="' + i + '" aria-label="' + esc(t("remove", l.name)) + '" title="' + esc(t("remove", l.name)) + '">×</button></li>').join("");
}
function fltChip(state) { return state === "ok" ? chip("s-file", "✓", t("ok")) : state === "warn" ? chip("s-missing", "!", t("check")) : state === "bad" ? chip("s-bad", "✕", t("check")) : chip("s-derived", "i", "info"); }
function renderFlight() {
  const P = $("#p-flt"); if (!P) return;
  const logs = flightLogs(), busy = (st.logs || []).some(l => l.busy);
  // files that look like logs but were not recognised, or failed outright, are listed first
  const unread = (st.logs || []).filter(l => !l.busy && !l.L).map(l => ({ state: l.err === "unknown" ? "warn" : "bad", key: l.err === "unknown" ? "cUnknownFile" : "cParseError", det: l.name + (l.err && l.err !== "unknown" ? ": " + l.err : "") }));
  const chk = c => "<li>" + fltChip(c.state) + "<span>" + esc(fltT("fltC", c.key)) + (c.det ? "<small>" + esc(fltVal(c.det)) + "</small>" : "") + "</span></li>";
  if (!logs.length) { P.innerHTML = (unread.length ? '<h3 class="sub">' + esc(t("fltChecksH")) + '</h3><ul class="checks">' + unread.map(chk).join("") + "</ul>" : "") + '<div class="empty">' + esc(busy ? t("fltReading") : t("fltEmpty")) + (busy ? "" : '<br><button class="btn primary" id="pick2b" style="margin-top:10px">' + esc(t("pickLog")) + "</button>") + "</div>" + geomHtml(flightState().G); return; }
  const FS = flightState(), imgs = FS.imgs, F = FS.F, checks = unread.concat(F.checks);
  const main = logs.find(l => l.exposures === F.exposures) || null;
  let h = '<p class="note small">' + esc(t("fltIntro", logs.length, imgs.length)) + (busy ? " " + esc(t("fltReading")) : "") + "</p>";
  h += '<h3 class="sub">' + esc(t("fltChecksH")) + '</h3><ul class="checks">' + checks.map(chk).join("") + "</ul>" + geomHtml(FS.G);
  h += '<h3 class="sub">' + esc(t("fltMapH")) + '</h3><div class="plot"><canvas id="fltCv" role="img" aria-label="' + esc(t("fltMapAria")) + '"></canvas></div>';
  h += '<div class="legend">' + ["fixed", "ppk", "float", "single", "none"].map(k => '<span><span aria-hidden="true" style="color:var(--' + RTK_ST[k][0] + ')">' + RTK_ST[k][1] + "</span> " + esc(t("rtk_" + k)) + "</span>").join("") + '<span><span aria-hidden="true">—</span> ' + esc(t("fltLegendTrk")) + '</span><span><span aria-hidden="true">◯</span> ' + esc(t("fltLegendImg")) + "</span></div>";
  h += '<h3 class="sub">' + esc(t("fltLogsH")) + "</h3>" + logs.map(l => {
    const rows = [[t("fltDevice"), esc(fltVal(Object.entries(l.device).filter(x => x[1]).map(x => x[1]).join(" · ") || "–"))], [t("fltTime"), esc(l.startMs != null ? fltTime(l.startMs) + " – " + fltTime(l.endMs) : "–")], l.timeSource ? [t("fltTimeSrc"), esc(l.timeSource)] : null, l.verify ? [t("fltVer"), esc(fltT("fltVerS", l.verify.state) + (l.verify.key && l.verify.state !== "none" ? " · " + l.verify.key : ""))] : null, l.verify && l.verify.state !== "ok" && l.verify.known ? [t("fltVerKnown"), esc(l.verify.known)] : null]
      .concat(l.facts.map(f => [fltT("fltF", f[0]), esc(fltVal(f[1]))])).concat(l.notes.length ? [[t("fltNotes"), esc(l.notes.map(n => fltT("fltN", n)).join(" · "))]] : []);
    return '<details class="lg"' + (st.open["lg:" + l.name] ? " open" : "") + ' data-o="lg:' + esc(l.name) + '"><summary><b>' + esc(l.name) + "</b> · " + esc(fltT("fltK", l.kind)) + (l.exposures.length && !l.listOnly ? " · " + esc(fmt(l.exposures.length, 0)) + " ×" : "") + (l.encrypted ? " · " + esc(fltT("fltN", "encrypted")) : "") + "</summary>" + kv(rows) + "</details>";
  }).join("");
  if (main) {
    const N = 200, byN = new Map(F.matches.filter(m => m.log === main.name).map(m => [m.n, m]));
    h += '<h3 class="sub">' + esc(t("fltExpH")) + " · " + esc(main.name) + '</h3><div class="tw"><table class="bt"><thead><tr><th>#</th><th>' + esc(t("thFile")) + "</th><th>" + esc(t("fltTime")) + "</th><th>" + esc(t("thLatLon")) + "</th><th>h</th><th>σH / σV</th><th>" + esc(t("fltSolution")) + "</th><th>" + esc(t("fltImage")) + "</th></tr></thead><tbody>" +
      main.exposures.slice(0, N).map(e => { const m = byN.get(e.n), sH = e.sH != null ? e.sH : e.sN != null ? Math.max(e.sN, e.sE) : null, q = e.q || "–", k = RTK_ST[q] ? q : "other";
        return '<tr><td class="n">' + esc(e.n) + '</td><td class="fn0">' + esc(e.name || e.captureId || "–") + '</td><td class="n">' + esc(e.t != null ? fltTime(e.t) : "–") + '</td><td class="n">' + (e.lat != null ? fmt(e.lat, 7, false) + "<br>" + fmt(e.lon, 7, false) : "–") + '</td><td class="n">' + (e.h != null ? fmt(+e.h, 2) : "–") + '</td><td class="n">' + (sH != null ? fmt(sH, 3) : "–") + " / " + (e.sV != null ? fmt(e.sV, 3) : "–") + '</td><td><span class="chip s-' + ({ ok: "file", warn: "missing", bad: "bad", info: "derived", na: "na" })[(RTK_ST[k] || RTK_ST.other)[0]] + '"><i>' + (RTK_ST[k] || RTK_ST.other)[1] + "</i>" + esc(RTK_ST[q] ? t("rtk_" + q) : q) + "</span></td><td>" + (m ? esc(m.image) : "–") + "</td></tr>"; }).join("") + "</tbody></table></div>" +
      (main.exposures.length > N ? '<p class="note small">' + esc(t("fltExpNote", N)) + "</p>" : "");
  }
  h += '<div class="toolbar"><button class="btn" id="x-fcsv">' + esc(t("fltCsv")) + '</button><button class="btn" id="x-fjson">' + esc(t("fltJson")) + '</button></div><p class="note small">' + esc(t("fltXNote")) + "</p>";
  P.innerHTML = h; drawFlight();
}
function geomHtml(G) {
  if (!G || !G.checks || !G.checks.length) return "";
  return '<h3 class="sub">' + esc(t("geoH")) + '</h3><ul class="checks">' + G.checks.map(c => "<li>" + fltChip(c.state) + "<span>" + esc(t(c.key)) + "<small>" + esc(dec(c.det)) + "</small></span></li>").join("") + "</ul>" +
    '<p class="note small">' + esc(t(G.source === "log" ? "geoNoteLog" : "geoNoteImg")) + (G.orient === "assumed" ? " " + esc(t("geoAssumed")) : "") + (G.overlapForward == null ? " " + esc(t("geoNoFoot")) : "") + "</p>";
}
function drawFlight() {
  const cv = $("#fltCv"); if (!cv) return; const { c, w, h } = cvx(cv); c.fillStyle = cssv("--plot-bg"); c.fillRect(0, 0, w, h);
  const logs = flightLogs().filter(l => !l._other), F = st.flight || { exposures: [], matches: [] };
  const pts = [], tr = logs.filter(l => l.trajectory.length > 1).map(l => l.trajectory.filter(p => p.lat != null && isFinite(p.lat) && Math.abs(p.lat) > 0.01));
  for (const a of tr) for (const p of a) pts.push(p);
  const ex = (F.exposures || []).filter(e => e.lat != null && isFinite(e.lat) && Math.abs(e.lat) > 0.01); for (const e of ex) pts.push(e);
  const im = batchFiles().filter(f => f.res.summary.lat != null).map(f => f.res.summary); for (const s of im) pts.push({ lat: s.lat, lon: s.lon });
  if (!pts.length) return;
  const lat0 = median(pts.map(p => p.lat)), lon0 = median(pts.map(p => p.lon)), en = ENU(lat0, lon0);
  const keep = pts.map(p => en(p.lat, p.lon)).filter(q => Math.abs(q[0]) < 50000 && Math.abs(q[1]) < 50000); if (!keep.length) return;
  const xs = keep.map(q => q[0]), ys = keep.map(q => q[1]), pad = 22, x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ppm = Math.min((w - 2 * pad) / Math.max(x1 - x0, 20), (h - 2 * pad - 14) / Math.max(y1 - y0, 20)), cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;
  const X = x => w / 2 + (x - cxm) * ppm, Y = y => (h - 14) / 2 - (y - cym) * ppm, ok = q => Math.abs(q[0]) < 50000 && Math.abs(q[1]) < 50000;
  c.lineWidth = 1; c.globalAlpha = .7; c.strokeStyle = cssv("--muted");
  // a point that implies more than 120 m/s from the previous one is a receiver glitch (for example before the first fix) and is skipped
  for (const a of tr) { c.beginPath(); let prev = null, skip = 0; for (const p of a) { const q = en(p.lat, p.lon); if (!ok(q)) continue; if (prev && skip < 3 && p.t != null && prev.t != null && p.t > prev.t && Math.hypot(q[0] - prev.q[0], q[1] - prev.q[1]) / ((p.t - prev.t) / 1000) > 120) { skip++; continue; } if (!prev || skip >= 3) c.moveTo(X(q[0]), Y(q[1])); else c.lineTo(X(q[0]), Y(q[1])); prev = { q, t: p.t }; skip = 0; } c.stroke(); }
  c.globalAlpha = 1;
  const r = ex.length > 1500 ? 1.6 : ex.length > 400 ? 2.4 : 3.5;
  for (const e of ex) { const q = en(e.lat, e.lon); if (!ok(q)) continue; const s = RTK_ST[e.q] ? e.q : "other"; marker(c, X(q[0]), Y(q[1]), s, r, cssv("--" + (RTK_ST[s] || RTK_ST.other)[0])); }
  c.strokeStyle = cssv("--fg"); c.lineWidth = 1.5;
  for (const s of im) { const q = en(s.lat, s.lon); if (!ok(q)) continue; c.beginPath(); c.arc(X(q[0]), Y(q[1]), r + 5, 0, 2 * Math.PI); c.stroke(); }
  drawNorth(c, w - 16, 18, cssv("--fg")); drawScale(c, 10, h - 6, ppm, w * .3, cssv("--fg"));
}
function median(a) { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
function flightClick(b) {
  if (b.dataset.lg != null) { setTab("flt"); return true; }
  if (b.dataset.rml != null) { st.logs.splice(+b.dataset.rml, 1); renderFiles(); afterLogs(); return true; }
  if (b.id === "x-fcsv") { download("flight_exposures.csv", "﻿" + OSLFlight.exposuresCSV(flightLogs(), st.flight), "text/csv;charset=utf-8"); return true; }
  if (b.id === "x-fjson") { download("flight_summary.json", OSLFlight.flightJSON(flightLogs(), st.flight), "application/json"); return true; }
  return false;
}
