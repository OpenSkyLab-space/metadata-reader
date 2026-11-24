// Flight reader tests on synthetic files built here from the documented structures (no field data).
// Run: node metadata-reader_flight_test.js   (exit code 1 on failure)
"use strict";
const path = require("path"), zlib = require("zlib");
const src = [path.join(__dirname, "metadata-reader_flight.js"), path.join(__dirname, "..", "src", "metadata-reader_flight.js")].find(p => require("fs").existsSync(p));
const F = require(src), { crc16, crc24 } = F._internal;
let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fails++; console.log("FAIL", msg); } };
const near = (a, b, e) => a != null && Math.abs(a - b) <= e;
const u8 = s => new TextEncoder().encode(s);
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const GPS0 = Date.UTC(1980, 0, 6), WEEK = 604800000;
const gpsMs = utc => utc + 18000; // after 2017

(async () => {
  /* DJI Timestamp.MRK: GPS week + SOW → UTC − 18 s */
  { const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), sow = (g % WEEK) / 1000;
    const line = (i, s, q) => [i, s.toFixed(6), "[" + wk + "]", "     1,N", "    -2,E", "    80,V", "49.00000000,Lat", "14.00000000,Lon", "500.000,Ellh", "0.020000, 0.015000, 0.040000", q + ",Q"].join("\t");
    const L = await F.parse(u8([line(1, sow, 50), line(2, sow + 2, 16), line(3, sow + 4, 34)].join("\n") + "\n"), "SYN_Timestamp.MRK");
    ok(L && L.kind === "dji-mrk", "mrk kind"); ok(L.exposures.length === 3, "mrk count"); ok(L.exposures[0].t === utc, "mrk time GPS→UTC");
    ok(L.exposures.map(e => e.q).join() === "fixed,single,float", "mrk Q mapping");
    const bad = await F.parse(u8("1\t-259199.997206\t[-522]\t0,N\t0,E\t0,V\t49,Lat\t14,Lon\t500,Ellh\t0, 0, 0\t1,Q\n"), "x_Timestamp.MRK");
    ok(bad.exposures[0].t === null && bad.notes.includes("mrk-no-gnss-time"), "mrk invalid week"); }

  /* RINEX 3 observation file */
  { const h = l => l.padEnd(60) ;
    const hdr = [h("     3.04           OBSERVATION DATA    M") + "RINEX VERSION / TYPE", h("SYN") + "MARKER NAME", h("123                 SYNRX               1.0") + "REC # / TYPE / VERS", h("456                 SYNANT          NONE") + "ANT # / TYPE",
      h("  3950000.0000   950000.0000  4900000.0000") + "APPROX POSITION XYZ", h("G    4 C1C L1C D1C S1C") + "SYS / # / OBS TYPES", h("  2026     5    14    10     0    0.0000000     GPS") + "TIME OF FIRST OBS", h("") + "END OF HEADER"];
    const ep = s => "> 2026 05 14 10 00 " + s.toFixed(7).padStart(10) + "  0  2\nG01  20000000.000\nG02  21000000.000";
    const L = await F.parse(u8(hdr.join("\n") + "\n" + [ep(0), ep(1), ep(2), ep(3)].join("\n") + "\n"), "SYN.26o");
    ok(L.kind === "rinex" && L.raw.epochs === 4 && L.raw.interval === 1, "rinex epochs/interval"); ok(L.raw.role === "base" && L.base, "rinex base role");
    ok(L.startMs === Date.UTC(2026, 4, 14, 10, 0, 0) - 18000, "rinex GPS → UTC"); }

  /* RTCM 3: GPS MSM4 epochs and a 1019 ephemeris with the week */
  { const frame = bitsArr => { const nb = Math.ceil(bitsArr.length / 8), p = new Uint8Array(nb); bitsArr.forEach((b, i) => { if (b) p[i >> 3] |= 0x80 >> (i & 7); }); const f = new Uint8Array(6 + nb); f[0] = 0xd3; f[1] = (nb >> 8) & 3; f[2] = nb & 255; f.set(p, 3); const c = crc24(f, 0, 3 + nb); f[3 + nb] = c >> 16; f[4 + nb] = (c >> 8) & 255; f[5 + nb] = c & 255; return f; };
    const put = (a, v, n) => { for (let i = n - 1; i >= 0; i--) a.push(Math.floor(v / 2 ** i) % 2); };
    const msm = tow => { const a = []; put(a, 1074, 12); put(a, 0, 12); put(a, tow, 30); while (a.length < 64) a.push(0); return frame(a); };
    const eph = wk => { const a = []; put(a, 1019, 12); put(a, 1, 6); put(a, wk % 1024, 10); while (a.length < 64) a.push(0); return frame(a); };
    const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), tow = g % WEEK;
    const L = await F.parse(cat(new Uint8Array([1, 2, 3]), eph(wk), msm(tow), msm(tow + 200), msm(tow + 400)), "SYN_PPKRAW.bin");
    ok(L && L.kind === "rtcm3", "rtcm sniff after junk"); ok(L.raw.epochs === 3 && L.raw.interval === 0.2, "rtcm epochs"); ok(L.startMs === utc, "rtcm start time"); }

  /* Septentrio SBF: PVTGeodetic, ExtEventPVTGeodetic, ExtEvent, ReceiverSetup, MeasEpoch */
  const sbfBlock = (id, len, fill) => { const b = new Uint8Array(len), d = new DataView(b.buffer); b[0] = 0x24; b[1] = 0x40; d.setUint16(4, id, true); d.setUint16(6, len, true); fill(d, b); d.setUint16(2, crc16(b, 4, len), true); return b; };
  const utcS = Date.UTC(2026, 4, 14, 10, 0, 0), gS = gpsMs(utcS) - GPS0, wkS = Math.floor(gS / WEEK), towS = gS % WEEK;
  const pvt = (k, mode, id) => sbfBlock(id || 4007, 96, (d, b) => { d.setUint32(8, towS + k * 100, true); d.setUint16(12, wkS, true); b[14] = mode; d.setFloat64(16, 49 * Math.PI / 180, true); d.setFloat64(24, (14 + k * 1e-5) * Math.PI / 180, true); d.setFloat64(32, 500, true); d.setFloat32(40, 46, true); b[74] = 20; d.setUint16(90, 2, true); d.setUint16(92, 3, true); });
  const ev = k => sbfBlock(5924, 32, (d, b) => { d.setUint32(8, towS + k * 100, true); d.setUint16(12, wkS, true); b[14] = 1; d.setFloat32(16, 0, true); });
  const meas = k => sbfBlock(4027, 20, d => { d.setUint32(8, towS + k * 100, true); d.setUint16(12, wkS, true); });
  const setup = sbfBlock(5902, 424, (d, b) => { b.set(u8("SYN"), 16); b.set(u8("SN123"), 156); b.set(u8("SYNRX"), 176); b.set(u8("1.0"), 196); b.set(u8("SYN-PRODUCT"), 328); });
  const sbf = cat(setup, pvt(0, 4), meas(0), ev(1), pvt(1, 4, 4038), pvt(2, 5), meas(2), new Uint8Array([0x24, 0x40, 1, 2]), pvt(3, 1));
  { const L = await F.parse(sbf, "syn.sbf");
    ok(L.kind === "sbf" && L.exposures.length === 1 && L.exposures[0].q === "fixed", "sbf event with RTK fix"); ok(L.startMs === utcS, "sbf time GPS → UTC");
    ok(L.device.serial === "SN123", "sbf ReceiverSetup serial"); ok(L.raw.epochs === 2 && L.raw.role === "rover", "sbf raw measurements"); ok(near(L.exposures[0].sH, 0.02, 1e-9), "sbf event hAcc"); }

  /* senseFly .bb3: frames 0xCD … 0xCE, escape 0xCF, SBF inside channel 5/2, one encrypted frame */
  { const inv = { 0xcf: 0xc0, 0xcd: 0xc1, 0xce: 0xc2, 0x2b: 0xc3 }; // escape table verified on eBee X field logs
    const esc = r => { const o = []; for (const x of r) { if (inv[x] != null) o.push(0xcf, inv[x]); else o.push(x); } return o; };
    const frames = []; let ts = 1000;
    for (let i = 0; i < sbf.length; i += 200) { const part = sbf.subarray(i, i + 200), r = [0x82, ...[0, 0, 0, 0, 0, 0].map((_, k) => (ts >> (8 * k)) & 255), 5, 2, part.length & 255, part.length >> 8, ...part, 0, 0, 0, 0]; ts += 10; frames.push(0xcd, ...esc(r), 0xce); }
    frames.push(0xcd, 0x87, ...esc([1, 2, 3, 0xcd, 0x2b, 0xce, 0xcf, 9]), 0xce);
    const L = await F.parse(new Uint8Array(frames), "SYN_0001.bb3");
    ok(L.kind === "bb3" && L.exposures.length === 1 && L.startMs === utcS, "bb3 → SBF"); ok(L.notes.includes("bb3-encrypted-part"), "bb3 encrypted frame noted"); }

  /* PX4 ULog, plain and with the Wingtra 2-byte prefix */
  for (const pre of [0, 2]) {
    const msg = (t, body) => { const b = new Uint8Array(pre + 3 + body.length), d = new DataView(b.buffer); d.setUint16(pre, body.length, true); b[pre + 2] = t.charCodeAt(0); b.set(body, pre + 3); return b; };
    const hdr = new Uint8Array(16); hdr.set([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 1]);
    const B = new Uint8Array(3 + 40); new DataView(B.buffer).setUint16(0, 40, true); B[2] = 0x42; // flag bits, never prefixed
    const fmt = msg("F", u8("vehicle_gps_position:uint64_t timestamp;uint64_t time_utc_usec;int32_t lat;int32_t lon;int32_t alt_ellipsoid;float eph;float epv;uint8_t fix_type;uint8_t satellites_used"));
    const info = (() => { const k = u8("char[12] sys_name"), v = u8("SYN-VEHICLE!"); return msg("I", cat(new Uint8Array([k.length]), k, v)); })();
    const sub = msg("A", cat(new Uint8Array([0, 1, 0]), u8("vehicle_gps_position")));
    const data = k => { const b = new Uint8Array(2 + 8 + 8 + 12 + 8 + 2), d = new DataView(b.buffer); d.setUint16(0, 1, true); const ts = 5e6 + k * 2e5; d.setUint32(2, ts % 2 ** 32, true); const utc = (Date.UTC(2026, 4, 14, 10, 0, 0) + k * 200) * 1000; d.setUint32(10, utc % 2 ** 32, true); d.setUint32(14, Math.floor(utc / 2 ** 32), true); d.setInt32(18, 490000000, true); d.setInt32(22, 140000000 + k * 100, true); d.setInt32(26, 500000, true); d.setFloat32(30, 0.4, true); d.setFloat32(34, 0.8, true); b[38] = 3; b[39] = 20; return msg("D", b); };
    const L = await F.parse(cat(hdr, B, fmt, info, sub, data(0), data(1), data(2)), "syn.ulg");
    ok(L && L.kind === "ulog" && L.trajectory.length === 3, "ulog trajectory, prefix " + pre); ok(near(L.trajectory[0].lat, 49, 1e-9) && near(L.trajectory[0].h, 500, 1e-9), "ulog values, prefix " + pre);
    ok(L.startMs === Date.UTC(2026, 4, 14, 10, 0, 0), "ulog boot → UTC, prefix " + pre); ok(L.device.model === "SYN-VEHICLE!", "ulog info, prefix " + pre); }

  /* Wingtra ULog as in WingtraPilot 2.20 field logs: logged string 'C' with a one-byte tag, receiver time without a fix, an image count without camera_capture */
  { const pre = 2, msg = (t, body) => { const b = new Uint8Array(pre + 3 + body.length), d = new DataView(b.buffer); d.setUint16(pre, body.length, true); b[pre + 2] = t.charCodeAt(0); b.set(body, pre + 3); return b; };
    const hdr = new Uint8Array(16); hdr.set([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 1]);
    const B = new Uint8Array(3 + 40); new DataView(B.buffer).setUint16(0, 40, true); B[2] = 0x42;
    const fmt = msg("F", u8("vehicle_gps_position:uint64_t timestamp;uint64_t time_utc_usec;int32_t lat;int32_t lon;int32_t alt_ellipsoid;float eph;float epv;uint8_t fix_type;uint8_t satellites_used"));
    const info = (() => { const k = u8("uint32_t camera_image_count"), v = new Uint8Array(4); new DataView(v.buffer).setUint32(0, 5, true); return msg("I", cat(new Uint8Array([k.length]), k, v)); })();
    const sub = msg("A", cat(new Uint8Array([0, 1, 0]), u8("vehicle_gps_position")));
    const data = k => { const b = new Uint8Array(40), d = new DataView(b.buffer); d.setUint16(0, 1, true); d.setUint32(2, 5e6 + k * 2e5, true); const utc = (Date.UTC(2011, 2, 26, 6, 46) + k * 200) * 1000; d.setUint32(10, utc % 2 ** 32, true); d.setUint32(14, Math.floor(utc / 2 ** 32), true); b[38] = 0; return msg("D", b); };
    const C = (() => { const b = new Uint8Array(10 + 12), d = new DataView(b.buffer); b[0] = 0x33; b[1] = 0x30; d.setUint32(2, 4e6, true); b.set(u8("SYN ERROR 1!"), 10); return msg("C", b); })();
    const L = await F.parse(cat(hdr, B, fmt, info, sub, data(0), C, data(1)), "syn_wingtra.ulg");
    ok(L.startMs == null && L.notes.includes("gps-no-fix-time"), "ulog: receiver time without a fix not used");
    ok(L.notes.includes("ulog-no-captures"), "ulog: image count without camera_capture noted");
    const lm = L.facts.find(f => f[0] === "fLogMessages"); ok(lm && /: SYN ERROR 1!$/.test(lm[1]), "ulog Wingtra: logged string with a one-byte tag read whole"); }

  /* MicaSense paramlog: JSON schema, separator, records */
  { const P = [{ parent: 0, key: 1, type: "Ublox", size: 64, name: "Ublox" }, ...[["lat", "double", 8], ["lon", "double", 8], ["altMsl", "double", 8], ["altEll", "double", 8], ["hAcc", "float", 4], ["vAcc", "float", 4], ["timeOfWeek", "double", 8], ["gpsWeek", "int32_t", 4], ["nanoSecond", "int32_t", 4], ["year", "uint16_t", 2], ["month", "uint8_t", 1], ["day", "uint8_t", 1], ["hour", "uint8_t", 1], ["minute", "uint8_t", 1], ["second", "uint8_t", 1], ["valid", "bool", 1]].map(([n, t, s], i) => ({ parent: 1, key: 10 + i, type: t, size: s, name: n })),
      { parent: 0, key: 2, type: "CaptureLog", size: 21, name: "CaptureLog" }, { parent: 2, key: 40, type: "string", size: 21, name: "CaptureId" }];
    const head = u8(JSON.stringify({ Parameters: P, flight_id: "SYNFLIGHT" }) + "\n==========\n");
    const rec = (ts, key, body) => { const b = new Uint8Array(16 + body.length), d = new DataView(b.buffer); d.setUint32(0, ts % 2 ** 32, true); d.setUint32(4, Math.floor(ts / 2 ** 32), true); d.setUint32(8, key, true); d.setUint32(12, 1, true); b.set(body, 16); return b; };
    const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0;
    const ub = k => { const b = new Uint8Array(64), d = new DataView(b.buffer); d.setFloat64(0, 49 * Math.PI / 180, true); d.setFloat64(8, 14 * Math.PI / 180, true); d.setFloat64(24, 500, true); d.setFloat32(32, 0.5, true); d.setFloat32(36, 0.7, true); d.setFloat64(40, (g % WEEK) / 1000 + k, true); d.setInt32(48, Math.floor(g / WEEK), true); b[63] = 1; return b; };
    const cap = id => { const b = new Uint8Array(21); b.set(u8(id)); return b; };
    const L = await F.parse(cat(head, rec(1e9, 1, ub(0)), rec((utc + 500) * 1e6, 2, cap("SYNCAPTURE0000000001")), rec(2e9, 1, ub(1))), "paramlog.dat");
    ok(L && L.kind === "mica-paramlog", "paramlog kind"); ok(L.exposures.length === 1 && L.exposures[0].captureId === "SYNCAPTURE0000000001", "paramlog capture id");
    ok(near(L.exposures[0].t, utc + 500, 1), "paramlog capture time (Unix ns)"); ok(near(L.trajectory[0].lat, 49, 1e-9) && L.startMs === utc, "paramlog u-blox position and time"); }

  /* MicaSense gpslog: MICA frames → UBX 0x67/0xFA → u-blox NAV-SOL and NAV-POSLLH */
  { const ubx = (c, i, p) => { const b = new Uint8Array(8 + p.length); b[0] = 0xb5; b[1] = 0x62; b[2] = c; b[3] = i; b[4] = p.length & 255; b[5] = p.length >> 8; b.set(p, 6); let A = 0, B = 0; for (let k = 2; k < 6 + p.length; k++) { A = (A + b[k]) & 255; B = (B + A) & 255; } b[6 + p.length] = A; b[7 + p.length] = B; return b; };
    const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), tow = g % WEEK;
    const sol = k => { const p = new Uint8Array(52), d = new DataView(p.buffer); d.setUint32(0, tow + k * 200, true); d.setInt16(8, wk, true); p[10] = 3; p[11] = 1; d.setUint32(24, 120, true); p[47] = 18; return ubx(1, 6, p); };
    const llh = k => { const p = new Uint8Array(28), d = new DataView(p.buffer); d.setUint32(0, tow + k * 200, true); d.setInt32(4, 140000000, true); d.setInt32(8, 490000000, true); d.setInt32(12, 500000, true); d.setInt32(16, 454000, true); d.setUint32(20, 800, true); d.setUint32(24, 1000, true); return ubx(1, 2, p); };
    const inner = cat(sol(0), llh(0), sol(1), llh(1)), outer = ubx(0x67, 0xfa, cat(new Uint8Array([1, 0xff]), inner));
    const frames = []; for (let i = 0; i < outer.length; i += 40) frames.push(cat(u8("MICA"), new Uint8Array([0x20, 0, 0, 0, 0, 0, 0, 1, 2, 3]), outer.subarray(i, i + 40), new Uint8Array([0, 0])));
    const L = await F.parse(cat(...frames), "gpslog.dat");
    ok(L && L.kind === "mica-gpslog" && L.trajectory.length === 2, "gpslog positions"); ok(L.startMs === utc && near(L.trajectory[0].lat, 49, 1e-9), "gpslog time and position"); }

  /* u-blox UBX raw log: NAV-PVT with carrier solution */
  { const ubx = (c, i, p) => { const b = new Uint8Array(8 + p.length); b[0] = 0xb5; b[1] = 0x62; b[2] = c; b[3] = i; b[4] = p.length & 255; b[5] = p.length >> 8; b.set(p, 6); let A = 0, B = 0; for (let k = 2; k < 6 + p.length; k++) { A = (A + b[k]) & 255; B = (B + A) & 255; } b[6 + p.length] = A; b[7 + p.length] = B; return b; };
    const pvt = k => { const p = new Uint8Array(92), d = new DataView(p.buffer); d.setUint16(4, 2026, true); p[6] = 5; p[7] = 14; p[8] = 10; p[9] = 0; p[10] = k; p[11] = 3; p[20] = 3; p[21] = 0x81; d.setInt32(24, 140000000, true); d.setInt32(28, 490000000, true); d.setInt32(32, 500000, true); d.setUint32(40, 15, true); return ubx(1, 7, p); };
    const L = await F.parse(cat(pvt(0), pvt(1)), "syn.ubx");
    ok(L && L.kind === "ubx" && L.trajectory.length === 2 && L.trajectory[0].q === "fixed" && L.startMs === Date.UTC(2026, 4, 14, 10), "ubx NAV-PVT"); }

  /* Parrot Sequoia TLMB: header, zlib block, section/variable/sample records */
  { const kv = (k, v) => cat(new Uint8Array([k.length + 1]), u8(k), new Uint8Array([0, v.length + 1]), u8(v), new Uint8Array([0]));
    const hdr = cat(u8("TLMB"), new Uint8Array([1, 2, 0, 0, 0]), kv("date", "20260514-100000"), kv("ro.serialno", "SYNSERIAL"));
    const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
    const vdesc = (name, ty, sz) => { const nm = cat(u8(name), new Uint8Array([0])); return cat(u32(24 + nm.length), u32(name.length), u32(ty), u32(sz), u32(1), u32(0), nm); };
    const vars = [["altitude", 9, 4], ["h_accuracy", 9, 4], ["latitude", 10, 8], ["longitude", 10, 8], ["v_accuracy", 9, 4]];
    const sec = cat(new Uint8Array([0]), u32(7), new Uint8Array([12]), u8("ExternalGPS"), new Uint8Array([0]));
    const vl = cat(new Uint8Array([2]), u32(7), u32(28), u32(vars.length), ...vars.map(v => vdesc(...v)));
    const sample = k => { const b = new Uint8Array(28), d = new DataView(b.buffer); d.setFloat32(0, 500, true); d.setFloat32(4, 3, true); d.setFloat64(8, 49, true); d.setFloat64(16, 14 + k * 1e-4, true); d.setFloat32(24, 5, true); return cat(new Uint8Array([3]), u32(7), u32(100 + k), u32(0), u32(28), b); };
    const z = new Uint8Array(zlib.deflateSync(cat(sec, vl, sample(0), sample(1))));
    const L = await F.parse(cat(hdr, u32(z.length), z, u32(0xffffffff)), "sequoia_param.dat");
    ok(L && L.kind === "tlmb" && L.exposures.length === 2 && near(L.exposures[1].lon, 14.0001, 1e-9), "tlmb ExternalGPS samples"); ok(L.device.serial === "SYNSERIAL", "tlmb header"); }

  /* text formats */
  { const L = await F.parse(u8("#Rev: sensefly/geoinfo/3\nfileName\tlatitude\tlongitude\taltitude_wgs84\tAccuracy XY\tAccuracy Z\nSYN_0001.JPG\t49.0\t14.0\t500.0\t0.05\t0.08\t\n"), "syn_geoinfo.txt");
    ok(L.kind === "sf-geoinfo" && L.exposures[0].q === "ppk", "geoinfo"); }
  { const L = await F.parse(u8("[General]\nEventsRTKFix=98\nx=3950000\ny=950000\nz=4900000\nname=SYN\n"), "syn.ini"); ok(L.kind === "wingtra-ini" && L.rtkFix === 98 && L.base, "wingtra ini"); }
  { const L = await F.parse(u8("# image name,latitude [decimal degrees],longitude [decimal degrees],altitude [meter],omega [degrees],phi [degrees],kappa [degrees],accuracy horizontal [meter],accuracy vertical [meter]\nSYN_00001.JPG,49.0,14.0,500,0,0,0,0.02,0.03\n"), "syn geotags.csv"); ok(L.kind === "wingtra-geotags" && L.exposures[0].q === "ppk", "wingtra geotags"); }
  { const H = "# image name,latitude [decimal degrees],longitude [decimal degrees],altitude [meter],omega [degrees],phi [degrees],kappa [degrees],accuracy horizontal [meter],accuracy vertical [meter]\n";
    const rows = (p, n) => Array.from({ length: n }, (_, k) => p + String(k + 1).padStart(5, "0") + ".JPG,49.0" + k + ",14.0,500,0,0,0,0.02,0.03").join("\n") + "\n";
    const A = await F.parse(u8(H + rows("SYN_A_", 40)), "syn_a geotags.csv"), Bq = await F.parse(u8(H + rows("SYN_B_", 30)), "syn_b geotags.csv"), R = F.combine([A, Bq], []);
    ok(R.checks.some(c => c.key === "cOtherFlight") && !R.checks.some(c => c.key === "cCountMismatch"), "two geotags.csv naming different images: other flight, no count mismatch"); }
  { const L = await F.parse(u8(JSON.stringify({ geotaggingSessionId: "SYN", payload: "SYN-CAM", version: 1, images: [{ imageName: "SYN_1.tif", geotaggedImage: { imageTimeStamp: Date.UTC(2026, 4, 14, 10), geoRef: { coordSys: "PPK_WGS84", coordinate: [49, 14, 500], hAccuracy: 0.02, vAccuracy: 0.03 } } }], triggers: [], orienations: [] })), "syn.geotaglog");
    ok(L.kind === "wingtra-geotaglog" && L.exposures[0].q === "ppk" && L.startMs === Date.UTC(2026, 4, 14, 10), "wingtra geotaglog"); }
  { const L = await F.parse(u8("2022-01-06-15-27-05.720056333 KRN: Firmware version: 1.0\n2026-05-14-10-00-01.000000000 KRN: $GPRMC,100000.00,A,4900.0000,N,01400.0000,E,0.0,0.0,140526,,,A*00\n"), "service.log");
    ok(L.kind === "lidar-service" && L.notes.includes("clock-jump") && L.startMs === Date.UTC(2026, 4, 14, 10), "lidar service.log"); }
  /* Wingtra LiDAR service.log lines as written by firmware 5.4 (values synthetic) and a ppk.pcmp naming the recordings */
  { const T = k => "2026-05-14-10-00-" + String(k).padStart(2, "0") + ".000000000 ";
    const rmc = k => T(k) + "KRN: $GPRMC,1000" + String(k).padStart(2, "0") + ".00,A,4900.0000,N,01400.0000,E,0.0,0.0,140526,,,A*00";
    const lines = [T(0) + "KRN: Time is good", T(1) + "DWR: Recording to SYN-001.data", T(2) + "RCV: Kernel receiver model = SYNRX 1.0", T(2) + "KRN: Max field of view is 45", T(2) + "KRN: Min field of view is 315",
      T(3) + "NAV: NavSolver current state: Static GPS", T(3) + "LED: GNSS LED state is changed to red", T(4) + "RCV: Adjusting clock by 3 microsec", T(4) + "RCV: Adjusting frequency by -1.25 ppm",
      T(5) + "SCN: Hesai total working time: 1 hours 20 minutes", T(5) + "SCN: Hesai total startup times: 7", T(5) + "SCN: Hesai total time between 20 deg C and 40 deg C: 0 hours 59 minutes",
      T(5) + 'SCN: Hesai factory calibration: "[{\\"i\\":1,\\"e\\":\\"15.0\\",\\"a\\":\\"0\\"},{\\"i\\":2,\\"e\\":\\"-16.0\\",\\"a\\":\\"0\\"}]"',
      T(6) + "IMU: IMU nSec = 1, GPS nSec = 2, latency = 800000, IMU Flags =", T(20) + "DWR: SYN-001.data checksum is 123", T(20) + "KRN: Stopped logging"];
    for (let k = 0; k < 12; k++) lines.push(rmc(k));
    const L = await F.parse(u8(lines.join("\n") + "\n"), "service.log"), f = k => (L.facts.find(x => x[0] === k) || [])[1];
    ok(/SYN-001\.data 10:00:01 \(checksum 123\) · stop 10:00:20/.test(f("fRecording")) && f("fFov") === "315° → 45° (90°)" && f("fNavStates") === "Static GPS" && f("fLeds") === "GNSS: red", "lidar service.log: recordings, field of view, navigation, LEDs");
    ok(f("fScannerUse") === "working 1 h 20 min · 7 start-ups" && f("fScannerTempHist") === "20–40 °C: 59 min" && f("fScannerCalib") === "2 lasers, elevation -16…15°", "lidar service.log: scanner use and calibration");
    ok(/^median 0\.80 ms/.test(f("fImuLatency")) && /1 corrections, max 3 µs · frequency -1\.25…-1\.25 ppm/.test(f("fClockSteer")) && L.notes.includes("lidar-static"), "lidar service.log: IMU latency, clock steering, static recording");
    const P = await F.parse(u8('<?xml version="1.0"?>\n<Project>\n<Files>\n<data path="data/SYN-001.data"/>\n<data path="data/SYN-002.data"/>\n<trajectory path="x/t.txt" ppk="1">\n</trajectory>\n</Files>\n<Filters><range min="8.000" max="200.000"/></Filters>\n</Project>\n'), "ppk.pcmp");
    const C = F.combine([L, P], []).checks.find(c => c.key === "cLidarFiles");
    ok(P.kind === "pcmp" && /range 8–200 m/.test((P.facts.find(x => x[0] === "fFilters") || [])[1]) && C && C.state === "warn" && /not recorded: SYN-002\.data/.test(C.det), "lidar: project file not recorded by the scanner"); }
  { const L = await F.parse(new Uint8Array(4096).map((_, i) => (i * 7919) & 255), "IX-00-00000_0001_em.bb3"); ok(L && L.kind === "bb3", "em.bb3 recognised as bb3"); }
  { const L = await F.parse(new Uint8Array(0), "hostlog.dat"); ok(L && L.notes.includes("empty"), "empty diagnostics file"); }
  ok(F.sniff("photo.jpg", new Uint8Array([0xff, 0xd8, 0xff])) === null, "images are not logs");

  /* joining: DJI index, clock offset, opposite lines, base coverage */
  { const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), sow = (g % WEEK) / 1000, lines = [];
    for (let i = 1; i <= 12; i++) { const row = Math.floor((i - 1) / 4), x = row % 2 ? 3 - ((i - 1) % 4) : (i - 1) % 4; lines.push([i, (sow + i * 2).toFixed(6), "[" + wk + "]", "0,N", "0,E", "0,V", (49 + row * 3e-4).toFixed(8) + ",Lat", (14 + x * 3e-4).toFixed(8) + ",Lon", "500.000,Ellh", "0.02, 0.02, 0.04", "50,Q"].join("\t")); }
    const mrk = await F.parse(u8(lines.join("\n")), "SYN_Timestamp.MRK");
    const images = [1, 6, 11].map(i => { const e = mrk.exposures[i - 1]; return { name: "DJI_20260514100000_" + String(i).padStart(4, "0") + "_D.JPG", S: { utcMs: e.t + 300, lat: e.lat, lon: e.lon, altAbs: 500 } }; });
    const R = F.combine([mrk], images, () => ({ elevation: 40, azimuth: 180 })), c = k => R.checks.find(x => x.key === k);
    ok(c("cMatched") && c("cMatched").state === "ok", "combine: all images matched by DJI index"); ok(c("cClock") && near(c("cClock").val, 0.3, 1e-6), "combine: clock offset +0.3 s");
    ok(c("cOpposite"), "combine: opposite flight lines"); ok(c("cSolution").state === "ok", "combine: all fixed");
    const csv = F.exposuresCSV([mrk], R); ok(csv.split("\r\n").length === 14 && /DJI_20260514100000_0006_D\.JPG,index/.test(csv), "exposures CSV"); }

  /* matching audit: the seven situations of a public matching test set */
  { const T0 = Date.UTC(2026, 4, 14, 10, 0, 0), g0 = gpsMs(T0) - GPS0, mk = (t0, n, step, lat0) => { const g = gpsMs(t0) - GPS0, wk = Math.floor(g / WEEK), sow = (g % WEEK) / 1000, L = [];
      for (let i = 1; i <= n; i++) L.push([i, (sow + i * step).toFixed(6), "[" + wk + "]", "0,N", "0,E", "0,V", (lat0 + i * 1e-4).toFixed(8) + ",Lat", "14.00000000,Lon", "500.000,Ellh", "0.02, 0.02, 0.04", "50,Q"].join("\t")); return L.join("\n"); };
    const A = await F.parse(u8(mk(T0, 12, 2, 49)), "A_Timestamp.MRK"), B = await F.parse(u8(mk(T0 + 3600e3, 12, 2, 49)), "B_Timestamp.MRK");
    const img = (name, e, dt, more) => ({ name, S: Object.assign({ utcMs: e.t + (dt || 0), lat: e.lat, lon: e.lon, altAbs: 500 }, more || {}) });
    const st = (R, name) => R.matches.find(m => m.image === name), ck = (R, k) => R.checks.find(c => c.key === k);
    // 1 renamed files: no index in the name → matched by time
    let R = F.combine([A], [img("site_a_001.jpg", A.exposures[2], 200)]);
    ok(st(R, "site_a_001.jpg").how === "time" && st(R, "site_a_001.jpg").status === "unique" && st(R, "site_a_001.jpg").n === 3, "audit: renamed file matched by time, unique");
    // 2 missing image: 11 of 12 shots loaded, every one matched once
    R = F.combine([A], A.exposures.slice(1).map(e => img("DJI_" + String(e.n).padStart(4, "0") + ".JPG", e)));
    ok(R.matches.every(m => m.status === "unique" && m.candidates === 1), "audit: missing image does not shift the others");
    // 3 duplicated image under another name: both point at one exposure → conflict
    R = F.combine([A], [img("DJI_0004.JPG", A.exposures[3]), img("copy_of_shot.jpg", A.exposures[3])]);
    ok(st(R, "copy_of_shot.jpg").status === "conflict" && st(R, "DJI_0004.JPG").status === "conflict" && ck(R, "cMatchConflict"), "audit: duplicate → conflict reported");
    // 4 two flights with the same numbering: time decides; without time and with the same position it stays ambiguous
    R = F.combine([A, B], [img("DJI_0006.JPG", B.exposures[5], 300)]);
    ok(st(R, "DJI_0006.JPG").log === "B_Timestamp.MRK" && st(R, "DJI_0006.JPG").status === "unique" && st(R, "DJI_0006.JPG").rejected[0].log === "A_Timestamp.MRK", "audit: two flights, same index: the other flight rejected by time");
    const C = await F.parse(u8(mk(T0 + 50e3, 12, 2, 49)), "C_Timestamp.MRK");
    R = F.combine([A, C], [img("DJI_0006.JPG", A.exposures[5], 2000)]);
    ok(st(R, "DJI_0006.JPG").log === "A_Timestamp.MRK" && /closest of 2 in time/.test(st(R, "DJI_0006.JPG").reason || ""), "audit: two candidates within the time window, the clearly closer one wins");
    R = F.combine([A, B], [img("DJI_0007.JPG", B.exposures[6], 0, { utcMs: null })]);
    ok(!st(R, "DJI_0007.JPG").log && st(R, "DJI_0007.JPG").status === "ambiguous" && st(R, "DJI_0007.JPG").candidates === 2 && ck(R, "cAmbiguous"), "audit: two flights, no time, same place → ambiguous, not matched");
    // 5 multispectral: five band files of one shot, the geotag list names only band 1 → one exposure, no conflict
    const gt = await F.parse(u8("name,lat,lon,alt,time\nIMG_0004_1.tif,49.0004,14.0,500,2026-05-14T10:00:08Z\nIMG_0005_1.tif,49.0005,14.0,500,2026-05-14T10:00:10Z\n"), "geotags.csv");
    R = F.combine([gt], [1, 2, 3, 4, 5].map(b => ({ name: "IMG_0004_" + b + ".tif", S: { utcMs: Date.UTC(2026, 4, 14, 10, 0, 8), lat: 49.0004, lon: 14.0 } })));
    ok(R.matches.every(m => m.log === "geotags.csv" && m.status === "unique" && m.how === "name"), "audit: band files of one shot share the exposure without a conflict");
    const SK = F._internal.shotKey; ok(["DJI_20251121131117_0001_D.JPG", "DJI_20251121131117_0001_MS_G.TIF", "DJI_20251121131117_0001_MS_NIR.TIF"].every(n => SK(n) === "DJI_20251121131117_0001") && SK("DJI_0001.JPG") === "DJI_0001" && SK("IMG_0004_10.tif") === "IMG_0004", "shot key: DJI multispectral bands, MicaSense band 10, plain DJI name kept");
    // 6 camera clock offset: still matched by index, offset reported
    R = F.combine([A], A.exposures.map(e => img("DJI_" + String(e.n).padStart(4, "0") + ".JPG", e, 1200)));
    ok(R.matches.every(m => m.how === "index" && m.status === "unique") && near(ck(R, "cClock").val, 1.2, 1e-6), "audit: camera clock +1.2 s, matched by index");
    // 7 different time resolution: exposures 0.3 s apart, image time to 1 s → ambiguous by time
    const Fst = await F.parse(u8(mk(T0, 12, 0.3, 49)), "fast_Timestamp.MRK");
    R = F.combine([Fst], [img("renamed.jpg", Fst.exposures[5], 100, { lat: null, lon: null })]);
    ok(!st(R, "renamed.jpg").log && st(R, "renamed.jpg").status === "ambiguous" && /within 0\.5 s/.test(st(R, "renamed.jpg").reason), "audit: exposures closer than the image clock resolution → ambiguous");
    // 8 image with no record: the index exists but 300 m away → rejected, unmatched
    R = F.combine([A], [img("DJI_0003.JPG", A.exposures[2], 0, { lat: A.exposures[2].lat + 0.0027 })]);
    ok(!st(R, "DJI_0003.JPG").log && st(R, "DJI_0003.JPG").rejected.length === 1 && /m from the image/.test(st(R, "DJI_0003.JPG").rejected[0].why) && ck(R, "cMatchRejected"), "audit: candidate 300 m away rejected, image unmatched"); }

  /* plausibility: impossible values are removed and counted, (0, 0) is "no fix" */
  { const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), sow = (g % WEEK) / 1000;
    const row = (i, s, lat, lon, h) => [i, s.toFixed(6), "[" + wk + "]", "0,N", "0,E", "0,V", lat + ",Lat", lon + ",Lon", h + ",Ellh", "0.02, 0.02, 0.04", "50,Q"].join("\t");
    const L = await F.parse(u8([row(1, sow, 49, 14, 500), row(2, sow + 2, 0, 0, 0), row(3, sow + 4, 95, 14, 500), row(4, sow + 6, 49, 14.0001, 99999), row(5, sow + 8, 49.5, 14, 500)].join("\n")), "SYN_Timestamp.MRK");
    ok(L.sanity.noFix === 1 && L.exposures[1].lat === null, "sanity: (0, 0) removed as no fix");
    ok(L.sanity.position === 1 && L.exposures[2].lat === null, "sanity: latitude 95° removed");
    ok(L.sanity.height === 1 && L.exposures[3].h === null && L.exposures[3].lat === 49, "sanity: height 99999 m removed, position kept");
    ok(L.sanity.speed === 1, "sanity: 55 km in 4 s counted as implausible speed");
    ok(L.notes.includes("implausible"), "sanity: note");
    const R = F.combine([L], []); ok(R.checks.some(c => c.key === "cImplausible" && c.state === "warn"), "sanity: check in combine");
    const T0 = F._internal.sanity({ exposures: [{ t: Date.UTC(1975, 0, 1), lat: 49, lon: 14 }], trajectory: [{ t: Date.UTC(2090, 0, 1), lat: 49, lon: 14 }], startMs: null, endMs: null, facts: [], notes: [] });
    ok(true, "sanity on a bare object does not throw"); }
  { const X = { exposures: [{ t: Date.UTC(1975, 0, 1), lat: 49, lon: 14 }], trajectory: [{ t: Date.UTC(2090, 0, 1), lat: 49, lon: 14 }], startMs: null, endMs: null, facts: [], notes: [] };
    F._internal.sanity(X, Date.UTC(2026, 9, 31)); ok(X.exposures[0].t === null && X.trajectory.length === 0 && X.sanity.time === 1 && X.sanity.track === 1, "sanity: times before 1980 and in the future removed"); }

  /* version check: a known version, an unknown one and a file without a version */
  { const mk = (kind, device, facts, extra) => Object.assign({ kind, name: "x", device, facts: facts || [], notes: [], exposures: [], trajectory: [] }, extra || {});
    const v = F._internal.verify;
    ok(v(mk("ulog", { make: "Wingtra", fw: "2.20.3" })).state === "ok", "verify: Wingtra 2.20.3 verified");
    const nw = v(mk("ulog", { make: "Wingtra", fw: "2.31.0" })); ok(nw.state === "new" && nw.standard && /2\.20/.test(nw.known), "verify: Wingtra 2.31 not verified, known versions listed");
    ok(v(mk("ulog", { make: "PX4", fw: "fd483321a5cf50ead91164356d15aa474643aa73" })).state === "none", "verify: git hash only means no version");
    ok(v(mk("sbf", { receiver: "mosaic-X5 · GRB0051", fw: "6.12.5-gcfb7243a03" })).state === "ok", "verify: mosaic-X5 6.12.5");
    ok(v(mk("sbf", { receiver: "mosaic-X5 · GRB0051", fw: "4.14.0" })).state === "new", "verify: mosaic-X5 4.14 not verified");
    ok(v(mk("tlmb", { fw: "1.6.0" })).state === "new" && !v(mk("tlmb", { fw: "1.6.0" })).standard, "verify: Sequoia 1.6 not verified, proprietary");
    ok(v(mk("rinex", {}, [["fFormat", "RINEX 4.01 observation"]])).state === "new", "verify: RINEX 4 not verified");
    ok(v(mk("rinex", {}, [["fFormat", "RINEX 3.04 observation"]])).state === "ok", "verify: RINEX 3.04 verified");
    /* ThermoTIFF conversion_log.csv and processing_record.json (structure from the ThermoTIFF 0.1.0 source; values synthetic) */
    { const csv = "\uFEFFsource,output,status,message,width,height,distance,humidity,emissivity,reflection,ambient_temp,t_min_C,t_max_C,t_mean_C,seconds,dji_api_version,overridden\r\n" +
        "C:\\data\\in\\DJI_0001_T.JPG,C:\\data\\out\\DJI_0001_T.tif,ok,,640,512,20,50,0.95,25,25,10.000,30.000,20.000,0.50,0x103,emissivity=0.95\r\n" +
        "C:\\data\\in\\DJI_0002_T.JPG,C:\\data\\out\\DJI_0002_T.tif,ok,,640,512,20,50,0.95,25,25,11.000,31.000,21.000,0.60,0x103,emissivity=0.95\r\n" +
        "C:\\data\\in\\DJI_0003.JPG,,not_radiometric,not a radiometric DJI thermal JPEG,0,0,,,,,,nan,nan,nan,0.01,,emissivity=0.95\r\n";
      const L = await F.parse(u8(csv), "conversion_log.csv"), p = L.proc;
      ok(L.kind === "thermotiff-log" && p && p.source === "thermotiff", "thermotiff log kind");
      ok(p.thermal_settings.emissivity === 0.95 && p.thermal_settings.object_distance_m === 20 && p.thermal_settings.relative_humidity_pct === 50 && /set by the user for emissivity/.test(p.thermal_settings.parameter_source), "thermotiff log parameters and source");
      ok(p.steps[0].parameters.converted === 2 && p.steps[0].parameters.errors === 1 && near(p.steps[0].duration_s, 1.11, 1e-9), "thermotiff log counts");
      ok(p.software[1].version === "API 0x103" && p.images.join() === "dji_0001_t,dji_0002_t,dji_0003", "thermotiff log SDK and file names");
      ok(!JSON.stringify(L).includes("C:\\data"), "thermotiff log: no folder paths kept");
      const R = F.procRecord([L])[0]; ok(R.processing.thermal_settings && R.processing.atmospheric_model && !R.processing.photogrammetry_settings && R.made[0] === 1, "thermotiff procRecord");
      ok((L.facts.find(x => x[0] === "fTempRange") || [])[1] === "10.00 … 31.00 °C (image means 20.00 … 21.00 °C)" && !L.notes.includes("thermal-clipped"), "thermotiff log: temperature range");
      const C = await F.parse(u8(csv.replace("10.000,30.000", "-20.000,30.000")), "conversion_log.csv"); ok(C.notes.includes("thermal-clipped") && /^1 · DJI_0001_T\.JPG \(-20 °C\)$/.test((C.facts.find(x => x[0] === "fTempClipped") || [])[1]), "thermotiff log: minimum at the DJI range limit is clipping");
      const rec = { software: { name: "ThermoTIFF", version: "0.1.0", dji_thermal_sdk_api: "0x103", exiftool: "12.76", python: "3.12", qt: "6.7" }, created: "2030-06-01T14:00:00+02:00",
        camera: { model: "ExampleT", focal_length_mm: 9.1, width_px: 640, height_px: 512 }, input: { folder: "C:/secret/folder", images: 2, dates: ["2030-06-01"], duration_s: 120, mean_height_m: 60 },
        parameters: { distance_m: 20, humidity_pct: 50, emissivity: 0.95, reflected_C: 25, source: "set by the user" }, output: { folder: "C:/secret/out", format: "TIFF float32, deflate, degrees Celsius", converted: 2, errors: 0 },
        quality_control: { flagged: 1, reasons: { saturated: 1 }, rules: { max_C: 150 } } };
      const J = await F.parse(u8(JSON.stringify(rec, null, 2)), "processing_record.json"), q = J.proc;
      ok(J.kind === "thermotiff-record" && q.software.map(x => x.name + " " + x.version).join() === "ThermoTIFF 0.1.0,DJI Thermal SDK API 0x103,ExifTool 12.76", "thermotiff record software");
      ok(q.thermal_settings.reflected_temperature_c === 25 && q.thermal_settings.parameter_source === "set by the user" && q.steps.length === 2 && q.steps[1].parameters.flagged === 1, "thermotiff record steps");
      ok(!JSON.stringify(J).includes("secret"), "thermotiff record: no folder paths kept");
      const M2 = F.procRecord([L, J]); ok(M2.length === 1 && M2[0].logs.length === 2 && M2[0].software[0].version === "0.1.0" && M2[0].steps[0].parameters.converted === 2 && M2[0].steps.length === 2 && M2[0].images.length === 3, "thermotiff log + record = one workflow"); }
    const kinds = Object.keys(F._internal.PARSERS || {}); ok(!kinds.length || kinds.every(k => F.VERIFIED.some(x => x.kind === k)), "verify: every parser has an entry in the table");
    const R = F.combine([mk("tlmb", { fw: "1.6.0" }, [], { verify: v(mk("tlmb", { fw: "1.6.0" })), startMs: null, endMs: null })], []);
    ok(R.checks.some(c => c.key === "cUnverified" && c.state === "warn"), "verify: proprietary unverified version is a warning"); }
  { const L = await F.parse(u8("#Rev: sensefly/geoinfo/3\nfileName\tlatitude\n"), "empty_geoinfo.txt"); ok(L.notes.includes("nothing-read"), "recognised file with no content is reported"); }

  /* ArduPilot DataFlash .bin: FMT-described GPS, CAM and MSG messages */
  { const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), tow = g % WEEK, parts = [];
    const str = (x, n) => { const b = new Uint8Array(n); b.set(u8(x).subarray(0, n)); return b; };
    const fmt = (type, len, name, f, cols) => { const b = new Uint8Array(89), dv = new DataView(b.buffer); b.set([0xa3, 0x95, 0x80, type, len]); b.set(str(name, 4), 5); b.set(str(f, 16), 9); b.set(str(cols, 64), 25); return b; };
    parts.push(fmt(128, 89, "FMT", "BBnNZ", "Type,Length,Name,Format,Columns"), fmt(130, 33, "GPS", "QBIHBcLLf", "TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt"),
      fmt(131, 46, "CAM", "QBHIHLLeeeccC", "TimeUS,I,Img,GPSTime,GPSWeek,Lat,Lng,Alt,RelAlt,GPSAlt,R,P,Y"), fmt(132, 75, "MSG", "QZ", "TimeUS,Message"), fmt(133, 12, "XKF1", "QB", "TimeUS,C"),
      fmt(134, 28, "VIBE", "QBfffI", "TimeUS,IMU,VibeX,VibeY,VibeZ,Clip"), fmt(135, 14, "MODE", "QMBB", "TimeUS,Mode,ModeNum,Rsn"), fmt(136, 13, "ERR", "QBB", "TimeUS,Subsys,ECode"));
    const msg = (type, len, fill) => { const b = new Uint8Array(len), dv = new DataView(b.buffer); b.set([0xa3, 0x95, type]); fill(dv, b); return b; };
    const q64 = (dv, o, v) => { dv.setUint32(o, v % 4294967296, true); dv.setUint32(o + 4, Math.floor(v / 4294967296), true); };
    parts.push(msg(132, 75, (dv, b) => { q64(dv, 3, 1000); b.set(u8("ArduPlane V4.5.7 (abc123)"), 11); }));
    for (let i = 0; i < 10; i++) parts.push(msg(130, 33, dv => { q64(dv, 3, 5e6 + i * 2e5); dv.setUint8(11, i < 5 ? 3 : 6); dv.setUint32(12, tow + i * 200, true); dv.setUint16(16, wk, true); dv.setUint8(18, 14); dv.setInt16(19, 120, true); dv.setInt32(21, Math.round((49 + i * 1e-5) * 1e7), true); dv.setInt32(25, 14e7, true); dv.setFloat32(29, 400, true); }));
    parts.push(msg(133, 12, () => {}));
    // flight state: AUTO (ArduPlane 10) until 6.0 s boot time, then FBWA (5); vibration 65 m/s² at exposure 1; clipping rises by 3; a GPS error
    parts.push(msg(135, 14, (dv, b) => { q64(dv, 3, 4e6); b[11] = 10; b[12] = 10; b[13] = 1; }), msg(135, 14, (dv, b) => { q64(dv, 3, 6e6); b[11] = 5; b[12] = 5; b[13] = 1; }));
    for (let i = 0; i <= 14; i++) parts.push(msg(134, 28, dv => { q64(dv, 3, 5e6 + i * 1e5); const v = i === 2 ? 65 : 20; dv.setFloat32(12, v, true); dv.setFloat32(16, v / 2, true); dv.setFloat32(20, v / 3, true); dv.setUint32(24, i < 10 ? 0 : 3, true); }));
    parts.push(msg(136, 13, (dv, b) => { q64(dv, 3, 5.6e6); b[11] = 11; b[12] = 2; }));
    for (let i = 1; i <= 3; i++) parts.push(msg(131, 46, dv => { q64(dv, 3, 5e6 + i * 4e5); dv.setUint16(12, i, true); dv.setUint32(14, tow + i * 400, true); dv.setUint16(18, wk, true); dv.setInt32(20, Math.round((49 + i * 2e-5) * 1e7), true); dv.setInt32(24, 14e7, true); dv.setInt32(28, 40000, true); dv.setInt32(36, 40100, true); }));
    const L = await F.parse(cat(...parts), "00000042.BIN");
    const bf = await F.parse(cat(parts[0], fmt(140, 10, "GPS", "QQQ", "TimeUS,A,B"), new Uint8Array([0xa3, 0x95, 140, 1, 2, 3, 4, 5, 6, 7])), "bad.bin"); ok(bf && !bf.error && bf.notes.includes("df-bad-fmt"), "ardupilot: FMT longer than its message is skipped, not a crash");
    ok(L && L.kind === "ardupilot-bin", "ardupilot bin kind"); ok(L.device.fw === "ArduPlane 4.5.7", "ardupilot firmware from MSG");
    ok(L.trajectory.length === 10 && L.trajectory[0].t === utc && L.trajectory[9].q === "fixed", "ardupilot GPS: GWk/GMS → UTC, status 6 = fixed");
    ok(L.exposures.length === 3 && L.exposures[0].t === utc + 400 && near(L.exposures[1].lat, 49.00004, 1e-9) && near(L.exposures[0].h, 401, 1e-9), "ardupilot CAM exposures (time, position, GPSAlt)");
    ok(L.notes.includes("height-amsl") && L.verify.state === "new", "ardupilot: height above sea level noted, version not verified");
    const [e1, , e3] = L.exposures;
    ok(e1.sv === 14 && e1.hdop === 1.2 && e1.fix === 3 && e3.fix === 6, "ardupilot at exposure: satellites, HDOP, fix of the nearest GPS record");
    ok(e1.vib === 65 && L.exposures[1].vib === 20 && e1.mode === "AUTO" && e1.auto === true && e3.mode === "FBWA" && e3.auto === false, "ardupilot at exposure: vibration within ±0.5 s, ArduPlane mode names");
    const A = L.atExp; ok(A.vib.over60 === 1 && A.vib.clip === 3 && A.modes.out === 1 && A.ev.err === 1 && /ERR GPS, code 2/.test(A.ev.first[0]) && A.interp === 0, "ardupilot summary: vibration, clipping, mode, ERR in the imaging window");
    const R = F.combine([L], []), c = R.checks.find(x => x.key === "cAtExposure");
    ok(c && c.state === "warn" && /outside the automatic mission: 1 \(FBWA\)/.test(c.det) && /vibration max 65/.test(c.det) && /HDOP max 1\.2/.test(c.det), "check: flight state at the exposures in one row");
    const csv = F.exposuresCSV([L], R).split("\r\n"); ok(/,position,satellites,hdop,eph_m,vibration_m_s2,flight_mode$/.test(csv[0]) && /,log,14,1\.2,,65,AUTO$/.test(csv[1]), "exposures CSV: state columns"); }
  /* ArduPilot text log, older column names (TimeMS + Week as GPS time) */
  { const utc = Date.UTC(2015, 4, 14, 10, 0, 0), g = utc + 16000 - GPS0, wk = Math.floor(g / WEEK), tow = g % WEEK;
    const txt = ["FMT, 128, 89, FMT, BBnNZ, Type,Length,Name,Format,Columns", "FMT, 130, 45, GPS, BIHBcLLeeEefI, Status,TimeMS,Week,NSats,HDop,Lat,Lng,RelAlt,Alt,Spd,GCrs,VZ,T",
      "FMT, 131, 40, CAM, IHLLeccC, GPSTime,GPSWeek,Lat,Lng,Alt,Roll,Pitch,Yaw", "MSG, ArduCopter V3.2.1 (36b405fb)",
      "GPS, 3, " + tow + ", " + wk + ", 10, 1.2, 49.1, 14.1, 20, 420.5, 0, 0, 0, 1000", "CAM, " + (tow + 1000) + ", " + wk + ", 49.1001, 14.1, 421, 0, 0, 90"].join("\n");
    const L = await F.parse(u8(txt), "2015-05-14 10-00-00.log");
    ok(L && L.kind === "ardupilot-log" && L.trajectory[0].t === utc && L.exposures[0].t === utc + 1000, "ardupilot text log with TimeMS/Week"); }

  /* MAVLink .tlog: HEARTBEAT (v1), GPS_RAW_INT (v2, truncated payload), CAMERA_FEEDBACK (v1) */
  { const t0 = Date.UTC(2026, 4, 14, 10, 0, 0) * 1000, parts = [];
    const ts = us => { const b = new Uint8Array(8), dv = new DataView(b.buffer); dv.setUint32(0, Math.floor(us / 4294967296)); dv.setUint32(4, us % 4294967296); return b; };
    const v1 = (us, id, p) => cat(ts(us), new Uint8Array([0xfe, p.length, 0, 1, 1, id]), p, new Uint8Array(2));
    const v2 = (us, id, p) => { let n = p.length; while (n > 1 && !p[n - 1]) n--; return cat(ts(us), new Uint8Array([0xfd, n, 0, 0, 0, 1, 1, id & 255, (id >> 8) & 255, id >> 16]), p.subarray(0, n), new Uint8Array(2)); };
    const hb = new Uint8Array(9); hb[4] = 1; hb[5] = 3; parts.push(v1(t0, 0, hb));
    for (let i = 0; i < 5; i++) { const p = new Uint8Array(52), dv = new DataView(p.buffer); dv.setInt32(8, Math.round((49 + i * 1e-5) * 1e7), true); dv.setInt32(12, 14e7, true); dv.setInt32(16, 400000, true); p[28] = i < 3 ? 3 : 6; dv.setInt32(30, 445000, true); dv.setUint32(34, 15, true); parts.push(v2(t0 + i * 2e5, 24, p)); }
    { const p = new Uint8Array(47), dv = new DataView(p.buffer); dv.setUint32(0, 0, true); dv.setInt32(8, Math.round(49.00004 * 1e7), true); dv.setInt32(12, 14e7, true); dv.setFloat32(16, 401, true); dv.setUint16(40, 7, true); parts.push(v1(t0 + 9e5, 180, p)); }
    const L = await F.parse(cat(...parts), "flight.tlog");
    ok(L && L.kind === "tlog" && L.device.make === "ArduPilot", "tlog kind, autopilot from HEARTBEAT");
    ok(L.trajectory.length === 5 && L.trajectory[0].t === t0 / 1000 && near(L.trajectory[0].h, 445, 1e-9) && L.trajectory[4].q === "fixed", "tlog GPS_RAW_INT (MAVLink 2 truncated, ellipsoid height)");
    ok(L.exposures.length === 1 && L.exposures[0].n === 7 && L.exposures[0].q === "fixed" && near(L.exposures[0].sH, 0.015, 1e-9), "tlog CAMERA_FEEDBACK with solution of the last GPS fix"); }
  /* MAVLink .tlog, PX4: CAMERA_TRIGGER without position (interpolated), mode from HEARTBEAT custom_mode, STATUSTEXT, VIBRATION */
  { const t0 = Date.UTC(2026, 4, 14, 10, 0, 0) * 1000, parts = [];
    const ts = us => { const b = new Uint8Array(8), dv = new DataView(b.buffer); dv.setUint32(0, Math.floor(us / 4294967296)); dv.setUint32(4, us % 4294967296); return b; };
    const v1 = (us, id, p) => cat(ts(us), new Uint8Array([0xfe, p.length, 0, 1, 1, id]), p, new Uint8Array(2));
    const hb = (us, cm) => { const p = new Uint8Array(9), dv = new DataView(p.buffer); dv.setUint32(0, cm, true); p[4] = 2; p[5] = 12; return v1(us, 0, p); };
    parts.push(hb(t0, (4 << 16) | (4 << 24)));
    for (let i = 0; i < 10; i++) { const p = new Uint8Array(52), dv = new DataView(p.buffer); dv.setInt32(8, Math.round((49 + i * 1e-5) * 1e7), true); dv.setInt32(12, 14e7, true); dv.setInt32(16, 400000, true); dv.setUint16(20, 90, true); p[28] = 3; p[29] = 15; dv.setInt32(30, 445000 + i * 1000, true); parts.push(v1(t0 + i * 2e5, 24, p)); }
    { const p = new Uint8Array(32), dv = new DataView(p.buffer); dv.setFloat32(8, 12, true); dv.setFloat32(12, 13, true); dv.setFloat32(16, 14, true); parts.push(v1(t0 + 5e5, 241, p)); }
    { const p = new Uint8Array(12), dv = new DataView(p.buffer); dv.setUint32(8, 1, true); parts.push(v1(t0 + 5e5, 112, p)); }
    { const p = new Uint8Array(51); p[0] = 4; p.set(u8("Synthetic warning"), 1); parts.push(v1(t0 + 1e6, 253, p), v1(t0 + 1.05e6, 253, p)); }
    parts.push(hb(t0 + 1.1e6, 3 << 16));
    { const p = new Uint8Array(12), dv = new DataView(p.buffer); dv.setUint32(8, 2, true); parts.push(v1(t0 + 1.3e6, 112, p)); }
    const L = await F.parse(cat(...parts), "px4.tlog"), [e1, e2] = L.exposures;
    ok(L.device.make === "PX4" && e1.interp && near(e1.lat, 49.000025, 1e-9) && near(e1.h, 447.5, 1e-6) && near(e2.lat, 49.000065, 1e-9), "tlog CAMERA_TRIGGER: position interpolated from GPS_RAW_INT");
    ok(e1.sv === 15 && e1.hdop === 0.9 && e1.vib === 14 && e1.mode === "AUTO_MISSION" && e1.auto && e2.mode === "POSCTL" && e2.auto === false, "tlog at exposure: satellites, HDOP, vibration, PX4 mode");
    ok(/^ellipsoid .*CAMERA_TRIGGER/.test((L.facts.find(f => f[0] === "fHeight") || [])[1]) && L.atExp.interp === 2 && L.atExp.ev.n === 2 && !L.atExp.ev.err, "tlog: height source of interpolated exposures, STATUSTEXT warning in the window");
    const R = F.combine([L], [{ name: "IMG_1.JPG", S: { utcMs: t0 / 1000 + 500, lat: 49.000025, lon: 14 } }]), c = R.checks.find(x => x.key === "cAtExposure"), O = F.oslFromFlight([L], R);
    ok(c && c.state === "warn" && /interpolated positions: 2/.test(c.det) && /autopilot errors and warnings: 2 \(Synthetic warning ×2\)/.test(c.det), "check: interpolated positions and messages reported, a repeated message listed once");
    ok(O.images["IMG_1.JPG"] && O.images["IMG_1.JPG"].cols.lat_deg.note === "nInterp" && O.images["IMG_1.JPG"].cols.alt_ellipsoid_m.note === "nInterp", "provenance: interpolated position marked as an estimate");
    ok(/,interpolated,15,0\.9,,14,AUTO_MISSION$/.test(F.exposuresCSV([L], R).split("\r\n")[1]), "exposures CSV: interpolated position"); }
  /* ULog: GNSS quality, nav_state and a logged error at the exposures; camera_capture without a fix (0, 0) gets an interpolated position */
  { const msg = (t, body) => { const b = new Uint8Array(3 + body.length), d = new DataView(b.buffer); d.setUint16(0, body.length, true); b[2] = t.charCodeAt(0); b.set(body, 3); return b; };
    const hdr = new Uint8Array(16); hdr.set([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 1]);
    const B = new Uint8Array(3 + 40); new DataView(B.buffer).setUint16(0, 40, true); B[2] = 0x42;
    const u64 = (d, o, v) => { d.setUint32(o, v % 2 ** 32, true); d.setUint32(o + 4, Math.floor(v / 2 ** 32), true); };
    const T0 = Date.UTC(2026, 4, 14, 10, 0, 0), parts = [hdr, B,
      msg("F", u8("vehicle_gps_position:uint64_t timestamp;uint64_t time_utc_usec;int32_t lat;int32_t lon;int32_t alt_ellipsoid;float eph;float epv;uint8_t fix_type;uint8_t satellites_used")),
      msg("F", u8("vehicle_status:uint64_t timestamp;uint8_t nav_state")),
      msg("F", u8("camera_capture:uint64_t timestamp;uint64_t timestamp_utc;uint32_t seq;double lat;double lon;float alt;int8_t result")),
      msg("A", cat(new Uint8Array([0, 1, 0]), u8("vehicle_gps_position"))), msg("A", cat(new Uint8Array([0, 2, 0]), u8("vehicle_status"))), msg("A", cat(new Uint8Array([0, 3, 0]), u8("camera_capture")))];
    const D = (id, n, fill) => { const b = new Uint8Array(2 + n), d = new DataView(b.buffer); d.setUint16(0, id, true); fill(d); return msg("D", b); };
    const nav = (us, v) => D(2, 9, d => { u64(d, 2, us); d.setUint8(10, v); }), cap = (us, seq) => D(3, 41, d => { u64(d, 2, us); d.setUint32(18, seq, true); d.setInt8(42, 1); });
    parts.push(nav(4e6, 3));
    for (let k = 0; k < 10; k++) parts.push(D(1, 38, d => { u64(d, 2, 5e6 + k * 2e5); u64(d, 10, (T0 + k * 200) * 1000); d.setInt32(18, Math.round((49 + k * 1e-5) * 1e7), true); d.setInt32(22, 14e7, true); d.setInt32(26, 500000, true); d.setFloat32(30, k === 6 ? 2.5 : 0.75, true); d.setFloat32(34, 1.2, true); d.setUint8(38, 3); d.setUint8(39, k === 6 ? 7 : 16); }));
    parts.push(cap(5.5e6, 1), msg("L", cat(new Uint8Array([51]), (() => { const b = new Uint8Array(8); u64(new DataView(b.buffer), 0, 6e6); return b; })(), u8("Synthetic error"))), nav(6.1e6, 2), cap(6.25e6, 2));
    const L = await F.parse(cat(...parts), "state.ulg"), [e1, e2] = L.exposures;
    ok(e1.interp && near(e1.lat, 49.000025, 1e-9) && e1.sv === 16 && e1.eph === 0.75 && e1.mode === "AUTO_MISSION" && e1.auto, "ulog at exposure: interpolated position, GNSS quality, nav_state");
    ok(e2.sv === 7 && e2.eph === 2.5 && e2.mode === "POSCTL" && e2.auto === false && L.atExp.ev.err === 1 && L.atExp.gnss.svMin === 7 && L.atExp.gnss.ephMax === 2.5 && !L.atExp.vib, "ulog summary: minimum satellites, maximum eph, logged error, no vibration rating"); }

  /* NMEA 0183: date from RMC, GGA position, quality and height, GST σ, midnight rollover, bad checksum */
  { const cs = x => { let c = 0; for (const ch of x) c ^= ch.charCodeAt(0); return "$" + x + "*" + c.toString(16).toUpperCase().padStart(2, "0"); };
    const lines = [cs("GPGGA,235959.00,4900.0000,N,01400.0000,E,1,10,0.9,300.0,M,45.0,M,,"), cs("GNRMC,235959.00,A,4900.0000,N,01400.0000,E,0.0,0.0,140526,,,A"),
      cs("GNGGA,000001.00,4900.0060,N,01400.0000,E,4,20,0.6,300.0,M,45.0,M,1.0,0000"), cs("GNGST,000001.00,0.5,0.02,0.01,0,0.012,0.010,0.025"), "$GNGGA,000002.00,4900.0120,N,01400.0000,E,5,20,0.6,300.0,M,45.0,M,1.0,0000*00"];
    const L = await F.parse(u8(lines.join("\r\n") + "\r\n"), "rover.nmea");
    ok(L && L.kind === "nmea" && L.trajectory.length === 2, "nmea kind, bad checksum skipped");
    ok(L.trajectory[0].t === Date.UTC(2026, 4, 14, 23, 59, 59) && L.trajectory[1].t === Date.UTC(2026, 4, 15, 0, 0, 1), "nmea date before RMC and after midnight");
    ok(L.trajectory[1].q === "fixed" && near(L.trajectory[1].h, 345, 1e-9) && near(L.trajectory[1].lat, 49.0001, 1e-9), "nmea GGA quality 4 = fixed, ellipsoid height"); }

  /* GPX: track points and waypoints named like images */
  { const x = '<?xml version="1.0"?><gpx version="1.1" creator="SynLogger 2.0" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' +
      '<trkpt lat="49.0" lon="14.0"><ele>300</ele><time>2026-05-14T10:00:00Z</time></trkpt><trkpt lat="49.0001" lon="14.0"><ele>301</ele><time>2026-05-14T10:00:02Z</time></trkpt></trkseg></trk>' +
      '<wpt lat="49.00005" lon="14.0"><ele>300.5</ele><time>2026-05-14T10:00:01Z</time><name>IMG_0001.JPG</name></wpt><wpt lat="49.1" lon="14.1"><name>Home</name></wpt></gpx>';
    const L = await F.parse(u8(x), "track.gpx");
    ok(L && L.kind === "gpx" && L.trajectory.length === 2 && L.trajectory[1].t === Date.UTC(2026, 4, 14, 10, 0, 2), "gpx track points");
    ok(L.exposures.length === 1 && L.exposures[0].name === "IMG_0001.JPG", "gpx waypoints named like images are exposures"); }

  /* CSV geotags: Pix4D style, Metashape reference export, semicolon with decimal comma, projected coordinates */
  { const a = await F.parse(u8("imagename,latitude,longitude,altitude,omega,phi,kappa,accuracy_xy,accuracy_z\nIMG_0001.JPG,49.0,14.0,450.2,0,0,0,0.02,0.03\nIMG_0002.JPG,49.0001,14.0,450.3,0,0,0,0.02,0.03\n"), "pix4d_geotags.csv");
    ok(a && a.kind === "csv-geotags" && a.exposures.length === 2 && a.exposures[0].name === "IMG_0001.JPG" && a.exposures[0].sH === 0.02 && a.exposures[1].h === 450.3, "csv Pix4D style");
    const b = await F.parse(u8('# CoordinateSystem: GEOGCS["WGS 84"]\n#Label,X/Longitude,Y/Latitude,Z/Altitude,Yaw,Pitch,Roll\nDJI_0001.JPG,14.0,49.0,450.0,0,0,0\n'), "reference.txt");
    ok(b && b.kind === "csv-geotags" && b.exposures[0].lat === 49 && b.exposures[0].lon === 14 && b.exposures[0].name === "DJI_0001.JPG", "csv Metashape reference (X = longitude)");
    const c = await F.parse(u8("Name;Latitude;Longitude;Ellipsoidal height;Time;Solution status\nP1;49,5;14,25;300,1;2026-05-14 10:00:00;FIX\n"), "events.csv");
    ok(c && c.exposures[0].lat === 49.5 && c.exposures[0].h === 300.1 && c.exposures[0].t === Date.UTC(2026, 4, 14, 10) && c.exposures[0].q === "fixed", "csv semicolon, decimal comma, time, status");
    const d = await F.parse(u8("name,lat,lon,h\nA,5540000.1,-750000.2,300\n"), "sjtsk.csv"); ok(d && d.notes.includes("csv-projected") && !d.exposures.length, "csv projected coordinates recognised, not converted");
    ok(F.sniff("notes.csv", u8("a,b,c\n1,2,3\n")) === null, "csv without coordinate columns is not a log");
    const raw = u8("Snimek;Sirka;Delka;Vyska\nIMG_1.JPG;49,1234567;14,7654321;300,5\nIMG_2.JPG;49,1234667;14,7654321;300,6\n");
    const u = await F.parse(raw, "export.csv"), R0 = F.combine([u], []);
    ok(u && u.kind === "csv-columns" && u.csv.cols.join() === "snimek,sirka,delka,vyska" && u.csv.guess.lat === 1 && u.csv.guess.lon === 2 && u.notes.includes("csv-unmapped") && !u.notes.includes("nothing-read"), "csv with unknown column names: columns offered, first two degree-like guessed");
    ok(R0.checks.some(x => x.key === "cCsvMap" && x.state === "warn"), "check: unknown CSV columns to assign");
    const m = await F.parse(raw, "export.csv", { csvMap: { lat: "sirka", lon: "delka", h: "vyska", name: "snimek" } });
    ok(m.kind === "csv-geotags" && m.exposures.length === 2 && m.exposures[0].lat === 49.1234567 && m.exposures[1].h === 300.6 && m.exposures[0].name === "IMG_1.JPG" && m.notes.includes("csv-mapped") && /assigned by hand/.test((m.facts.find(f => f[0] === "fColumns") || [])[1]), "csv columns assigned by hand"); }

  { const L = await F.parse(u8('<?xml version="1.0"?><kml><Document><name>Plan KML</name><Placemark><name>0 </name><Point><coordinates>14.0,49.0,300</coordinates></Point></Placemark><Placemark><name>IMG_0001.JPG</name><Point><coordinates>14.0,49.0,301</coordinates></Point></Placemark></Document></kml>'), "plan.kml");
    ok(L.exposures.length === 1 && L.exposures[0].name === "IMG_0001.JPG" && L.facts.some(f => f[0] === "fPlacemarks" && f[1] === 1), "kml: mission waypoints are not exposures"); }

  /* Compact RINEX 3 (Hatanaka) in gzip; consecutive 15-minute base files joined; base distance */
  { const head = "3.0                 COMPACT RINEX FORMAT                    CRINEX VERS   / TYPE\n" + "RNX2CRX ver.4.1.0                       20-Nov-24 10:16     CRINEX PROG / DATE\n" +
      "     3.03           OBSERVATION DATA    M                   RINEX VERSION / TYPE\n" + "SYN                                                         MARKER NAME\n" +
      "GEODETIC                                                    MARKER TYPE\n" + "  3979316.4389  1050312.2534  4857066.9036                  APPROX POSITION XYZ\n" +
      "  2026    05    14    10     0    0.0000000     GPS         TIME OF FIRST OBS\n" + "                                                            END OF HEADER\n";
    // epoch lines as differences: only the seconds field changes ("               01" style), clock line empty, two data lines
    const crx = (min) => { let t = head.replace("10     0", "10    " + String(min).padStart(2)); let prev = "> 2026 05 14 10 " + String(min).padStart(2, "0") + "  0.0000000  0  2      G01G02";
      t += prev + "\n\n3&1 3&2\n3&3 3&4\n";
      for (let k = 1; k < 900; k++) { const s2 = String(k % 60).padStart(2, "0"), m2 = String(min + Math.floor(k / 60)).padStart(2, "0"); const ns = k % 2 ? 12 : 2, cur = "> 2026 05 14 10 " + m2 + " " + s2 + ".0000000  0 " + String(ns).padStart(2) + "      G01G02";
        let d = ""; for (let i = 0; i < cur.length; i++) d += cur[i] === prev[i] ? " " : cur[i] === " " ? "&" : cur[i]; t += d.replace(/\s+$/, "") + "\n\n" + " 1 2\n".repeat(ns); prev = cur; }
      return t; };
    const a = await F.parse(new Uint8Array(zlib.gzipSync(u8(crx(0)))), "SYN00CZE_R_20261341000_15M_01S_MO.crx.gz"), b = await F.parse(new Uint8Array(zlib.gzipSync(u8(crx(15)))), "SYN00CZE_R_20261341015_15M_01S_MO.crx.gz");
    ok(a && a.kind === "rinex" && a.notes.includes("gzip") && a.raw.epochs === 900 && a.raw.interval === 1, "compact RINEX in gzip: 900 epochs, 1 s");
    ok(a.startMs === Date.UTC(2026, 4, 14, 10, 0, 0) - 18000 && a.endMs === Date.UTC(2026, 4, 14, 10, 14, 59) - 18000, "compact RINEX epoch times rebuilt from differences");
    ok(a.verify.state === "ok", "compact RINEX 3 verified");
    const rov = { kind: "ulog", name: "rov", device: {}, facts: [], notes: [], exposures: [], trajectory: [{ t: Date.UTC(2026, 4, 14, 10, 5), lat: 49.9, lon: 14.8 }, { t: Date.UTC(2026, 4, 14, 10, 20), lat: 49.9, lon: 14.8 }], startMs: Date.UTC(2026, 4, 14, 10, 5), endMs: Date.UTC(2026, 4, 14, 10, 20) };
    const R = F.combine([rov, a, b], []);
    ok(R.checks.some(c => c.key === "cBaseCovers" && /2 files/.test(c.det)) && !R.checks.some(c => c.key === "cBaseGap"), "two 15-minute base files joined to cover the flight");
    ok(R.checks.filter(c => c.key === "cBaseDist").length === 1 && R.checks.find(c => c.key === "cBaseDist").state === "ok", "base distance reported once"); }

  /* DJI FlightRecord decoded to CSV by dji-log-parser */
  { const hdr = "CUSTOM.dateTime,OSD.flyTime,OSD.latitude,OSD.longitude,OSD.height,OSD.altitude,OSD.isGPSUsed,OSD.gpsNum,BATTERY.chargeLevel,APP.warn,DETAILS.aircraftName,DETAILS.aircraftSerial,DETAILS.photoNum,DETAILS.totalTime";
    const rows = [hdr, "2026-05-14T10:00:00Z,0,0,0,0,0,false,0,98,,Mavic 3E,SYN123,42,600", "2026-05-14T10:00:01.5Z,1.5,49.0,14.0,10,310,true,18,97,\"Low battery, return\",Mavic 3E,SYN123,42,600"];
    const L = await F.parse(u8(rows.join("\n") + "\n"), "flight.csv");
    ok(L && L.kind === "dji-fr-csv" && L.trajectory.length === 1 && L.trajectory[0].t === Date.UTC(2026, 4, 14, 10, 0, 1, 500), "dji-log-parser CSV: track, time, (0, 0) skipped");
    ok(L.device.model === "Mavic 3E" && L.facts.some(f => f[0] === "fBattery" && f[1] === "98 → 97 %") && L.facts.some(f => f[0] === "fWarnings" && /Low battery, return/.test(f[1])), "dji-log-parser CSV: details, battery, quoted warning");
    // platform 6 app: generic aircraft name, distance in km, no CAMERA.isPhoto edges, one row with a nonsense date
    const h6 = "CUSTOM.dateTime,OSD.flyTime,OSD.latitude,OSD.longitude,OSD.altitude,OSD.droneType,CAMERA.isPhoto,DETAILS.aircraftName,DETAILS.appPlatform,DETAILS.appVersion,DETAILS.totalDistance,DETAILS.photoNum";
    const r6 = [h6, "2026-05-14T10:00:00Z,0,49.0,14.0,300,Mavic3Enterprise,false,dji aircraft,DJIFly,46.0.0,1.68,12", "2043-07-13T10:50:27Z,1,49.0001,14.0,300,Mavic3Enterprise,false,dji aircraft,DJIFly,46.0.0,1.68,12", "2026-05-14T10:00:02Z,2,49.0002,14.0,300,Mavic3Enterprise,false,dji aircraft,DJIFly,46.0.0,1.68,12"];
    const M = await F.parse(u8(r6.join("\n") + "\n"), "flight6.csv"), fv = k => (M.facts.find(f => f[0] === k) || [])[1];
    ok(M.kind === "dji-fr-csv" && M.startMs === Date.UTC(2026, 4, 14, 10) && M.endMs === Date.UTC(2026, 4, 14, 10, 0, 2) && fv("fTimesDropped") === 1 && M.trajectory[1].t === null, "dji-log-parser CSV: a date far from the others is dropped");
    ok(M.device.model === "Mavic3Enterprise" && fv("fDistance") === "1680 m" && /isPhoto never set/.test(fv("fShotFlag") || "") && M.verify.state === "ok", "dji-log-parser CSV, platform 6: model, distance in km, missing shot flag reported"); }

  /* DJI FlightRecord v8, binary: records XOR-scrambled as described in dji-log-parser (CRC-64 Jones key), details block at the end */
  { const P = 0x95AC9329AC4BC9B5n, TB = []; for (let i = 0; i < 256; i++) { let c = BigInt(i); for (let j = 0; j < 8; j++) c = c & 1n ? (c >> 1n) ^ P : c >> 1n; TB.push(c); }
    const key = (rt, f) => { let crc = BigInt((f + rt) & 255), v = (0x123456789ABCDEF0n * BigInt(f)) & 0xFFFFFFFFFFFFFFFFn; for (let i = 0; i < 8; i++) crc = TB[Number((crc ^ ((v >> BigInt(8 * i)) & 255n)) & 255n)] ^ (crc >> 8n); return [...Array(8)].map((_, i) => Number((crc >> BigInt(8 * i)) & 255n)); };
    const rec = (rt, pay, f) => { const k = key(rt, f); return Uint8Array.from([rt, pay.length + 1, f, ...pay.map((x, i) => x ^ k[i % 8]), 0xff]); };
    const buf = (n, fill) => { const b = new Uint8Array(n), d = new DataView(b.buffer); fill(d, b); return [...b]; };
    const t0 = Date.UTC(2026, 4, 14, 10, 0, 0), recs = []; let f = 7;
    const custom = t => rec(5, buf(18, d => d.setBigInt64(10, BigInt(t), true)), f++ & 255);
    const osd = (lat, lon, h) => rec(1, buf(54, (d, b) => { d.setFloat64(0, lon * Math.PI / 180, true); d.setFloat64(8, lat * Math.PI / 180, true); d.setInt16(16, h * 10, true); b[36] = 17; }), f++ & 255);
    const cam = r => rec(25, buf(24, d => d.setUint32(13, r, true)), f++ & 255), gim = p => rec(3, buf(6, d => d.setInt16(0, p * 10, true)), f++ & 255), bat = pc => rec(8, buf(31, (d, b) => { b[26] = pc; }), f++ & 255);
    for (let i = 0; i < 5; i++) { recs.push(custom(t0 + 2000 * i), osd(49 + i * 1e-4, 14, 50), gim(-90), bat(90 - i), cam(500 - (i >= 2 ? i - 1 : 0))); }
    recs.push(Uint8Array.from([57, 4, 0x39, 0x30, 0, 0, 0xff]), Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
    const body = cat(...recs), off = 100 + body.length;
    const det = new Uint8Array(400), dd = new DataView(det.buffer); dd.setBigInt64(91, BigInt(t0), true); dd.setFloat64(99, 14, true); dd.setFloat64(107, 49, true); dd.setInt32(119, 600000, true); dd.setFloat32(123, 50.5, true);
    det.set(u8("SYN-P4"), 280); det.set(u8("SYNSN0001"), 312); det.set(u8("SYNCAM01"), 328); det[376] = 1; det.set([4, 3, 64], 377);
    const pre = new Uint8Array(100), pd = new DataView(pre.buffer); pd.setBigUint64(0, BigInt(off), true); pd.setUint16(8, 400, true); pre[10] = 8;
    const L = await F.parse(cat(pre, body, det), "DJIFlightRecord_2026-05-14_[12-00-00].txt");
    ok(L && L.kind === "dji-fr" && L.trajectory.length === 5 && near(L.trajectory[4].lat, 49.0004, 1e-9), "DJI FlightRecord v8: kind, OSD track");
    ok(L.exposures.length === 3 && L.exposures[0].t === t0 + 4000 && L.exposures[0].hRel === 50 && L.exposures[0].h === null && L.exposures[0].pitch === -90, "DJI FlightRecord v8: shots from the photo counter, time, relative height, gimbal");
    ok(L.device.model === "SYN-P4" && L.device.serial === "SYNSN0001" && L.facts.some(x => x[0] === "fBattery" && x[1] === "90 → 86 %") && L.facts.some(x => x[0] === "fSoftware" && x[1] === "iOS 4.3.64") && L.verify.state === "ok", "DJI FlightRecord v8: details, battery, version");
    pre[10] = 14; const E = await F.parse(cat(pre, body, det), "DJIFlightRecord_2026-05-14_[12-00-00].txt");
    ok(E.kind === "dji-fr" && E.encrypted && E.notes.includes("encrypted") && !E.exposures.length, "DJI FlightRecord v14: reported as encrypted");
    // v14: details in the first auxiliary block, XOR-scrambled like a record of type 0; records (AES) stay unread
    const d14 = new Uint8Array(436), d4 = new DataView(d14.buffer); d14.set(det.subarray(0, 380)); d4.setFloat32(115, 1234.4, true); d4.setInt32(135, 77, true);
    const pay = [0, 436 & 255, 436 >> 8, ...d14, 0, 0], sd = 0x5a, kk = key(0, sd), aux = Uint8Array.from([0, (pay.length + 1) & 255, (pay.length + 1) >> 8, sd, ...pay.map((x, i) => x ^ kk[i % 8])]);
    const ver = Uint8Array.from([1, 4, 0, 4, 0, 3, 0]), p14 = new Uint8Array(100), q14 = new DataView(p14.buffer);
    q14.setBigUint64(0, BigInt(100 + aux.length + ver.length), true); q14.setUint16(8, 436, true); p14[10] = 14;
    const V = await F.parse(cat(p14, aux, ver, Uint8Array.from([7, 9, 9, 9, 0xff])), "DJIFlightRecord_2026-05-14_[12-00-00].txt");
    ok(V.kind === "dji-fr" && V.encrypted && V.device.model === "SYN-P4" && V.device.serial === "SYNSN0001" && V.startMs === t0 && !V.trajectory.length && !V.exposures.length, "DJI FlightRecord v14: details from the auxiliary block, records left encrypted");
    ok(V.verify.state === "ok" && F.combine([V], []).checks.some(c => c.key === "cEncryptedSum") && F.combine([E], []).checks.some(c => c.key === "cEncrypted"), "DJI FlightRecord v14: summary verified, its own check");
    ok(V.facts.some(x => x[0] === "fPhotos" && x[1] === 77) && V.facts.some(x => x[0] === "fDistance" && x[1] === "1234 m") && V.facts.some(x => x[0] === "fSoftware" && x[1] === "iOS 4.3.64") && V.facts.some(x => x[0] === "fDuration" && x[1] === "600 s"), "DJI FlightRecord v14: capture count, distance, app, duration");
    d14[376] = 9; const pay2 = [0, 436 & 255, 436 >> 8, ...d14, 0, 0]; aux.set(pay2.map((x, i) => x ^ kk[i % 8]), 4);
    const W = await F.parse(cat(p14, aux, ver), "DJIFlightRecord_2026-05-14_[12-00-00].txt");
    ok(W.facts.some(x => x[0] === "fSoftware" && x[1] === "platform 9, 4.3.64") && !W.facts.some(x => x[0] === "fDistance"), "DJI FlightRecord v14: unknown platform kept as a number, distance left out");
    d14[376] = 6; const pay3 = [0, 436 & 255, 436 >> 8, ...d14, 0, 0]; aux.set(pay3.map((x, i) => x ^ kk[i % 8]), 4);
    const W6 = await F.parse(cat(p14, aux, ver), "DJIFlightRecord_2026-05-14_[12-00-00].txt");
    ok(W6.facts.some(x => x[0] === "fDistance" && x[1] === "1234400 m"), "DJI FlightRecord v14, platform 6: distance stored in km"); }

  /* senseFly eMotion console transcript: PC clock converted with the session header, trigger commands as exposures without position */
  { const t = ["10:00:00 : Console log file successfuly opened", "10:00:00 : === New session : Wed Mar 29 10:00:00 2017 (UTC 2017-03-29 08:00:00) ===",
      "10:00:01 : Robot XX-00-000 created from interface eBee_EB-00-00001 (SYN0001)", "10:05:00 : Taking off", "10:05:03 : Climbing to 90 m/ATO during transit",
      "10:06:00 : Taking photo #1", "10:06:02 : Taking photo #2", "10:06:05 : Taking photo #2", "10:06:07 : Taking photo #3", "10:06:08 : Poor GPS coverage", "10:20:00 : Touching down"];
    const L = await F.parse(u8(t.join("\r\n") + "\r\n"), "EB-00-00001_transcript_0.txt");
    ok(L && L.kind === "emotion-transcript" && L.exposures.length === 3 && L.exposures[0].t === Date.UTC(2017, 2, 29, 8, 6, 0) && L.exposures[1].t === Date.UTC(2017, 2, 29, 8, 6, 5) && L.exposures[0].lat === null, "eMotion transcript: photos, UTC from the header, repeated number keeps the last");
    ok(L.device.serial === "EB-00-00001" && L.facts.some(f => f[0] === "fMaxHeight" && /^90 m/.test(f[1])) && L.facts.some(f => f[0] === "fFlight" && /900 s/.test(f[1])) && !L.notes.includes("nothing-read"), "eMotion transcript: drone, planned height, flight span"); }

  /* senseFly eBee X payload computer log (log_n.txt): firmware, session, payload, thermal calibration, time sync from GNSS */
  { const t = ["19700101-000007.826Z:DBG afpu.logger: Log file open :  \"/logs/log_0.txt\" \"1970-01-01 00:00:07\"", "19700101-000007.835Z:DBG afpu.logger: FW version: 3.22.0 2022",
      "19700101-000008.297Z:DBG pm.flightsession: Starting new flight session \"IX-00-00001_0001\"", "19700101-000008.300Z:DBG default: USB: payload detected: \"Floda\"",
      "19700101-000008.400Z:INFO skup.core: Firmware changed: \"AutopilotMain\" btld: \"3.9.0 199\" fw: \"3.22.0 2022\"", "19700101-000009.000Z:DBG    Serial number: SYN0000000001",
      "19700101-000027.037Z:DBG flir.writer: calib file: found XMP tag :  Xmp.Camera.PerspectiveFocalLength  =  13.0", "19700101-000039.538Z:INFO afpu.time: Ignoring UTC time from AP, too close to timepulse",
      "20260514-100000.000Z:INFO afpu.time: System date/time set to  QDateTime(2026-05-14 10:00:00.000 UTC Qt::TimeSpec(LocalTime)) ( 1778752800 s 0 ns )", "20260514-100500.000Z:WRN flir.status: Poller request \"SerialNumber\" timeout"];
    const L = await F.parse(u8(t.join("\n") + "\n"), "log_0.txt");
    ok(L && L.kind === "ebeex-afpu" && L.device.fw === "3.22.0 2022" && L.device.serial === "IX-00-00001" && L.startMs === Date.UTC(2026, 4, 14, 10) && L.endMs === Date.UTC(2026, 4, 14, 10, 5), "eBee X log: firmware, session, time after GNSS sync only");
    ok(L.facts.some(f => f[0] === "fThermCalib" && /PerspectiveFocalLength = 13\.0/.test(f[1])) && L.facts.some(f => f[0] === "fSerials" && f[1] === "SYN0000000001") && L.facts.some(f => f[0] === "fPayload" && /Floda/.test(f[1]) && /FLIR/.test(f[1])) && L.verify.state === "ok", "eBee X log: calibration XMP, serials, payload, version"); }

  /* Pix4Dcapture app log: local time converted with the UTC start in the file name, drone and camera, stored mission settings */
  { const t = ["2026-05-14 12:00:00 [D][AppNavManager:76]:  --- App Start", "2026-05-14 12:00:00 [D][AppNavManager:82]:  *** Pix4Dcapture version 4.13.1(1) ***",
      "2026-05-14 12:00:00 [D] -[AppDelegate application:didFinishLaunchingWithOptions:]:64 Settings:", "{", "    settingsMissionAutoGrid =     {", "        \"camera_angle\" = 80;", "        \"grid_overlap\" = 75;", "        \"side_overlap\" = 65;", "    };", "}",
      "2026-05-14 12:00:05 [I][AppNavManager:277]: ****** GRID ********", "2026-05-14 12:00:06 [D] -[P4DDroneDJI configureForSingleCamera:]:1022 camera name is SYN Camera is connected",
      "2026-05-14 12:00:06 [D] -[P4DDroneDJI updateDroneModelWithName:]:1582 Drone model correction, overriding the specs. Intended: SYN A, Actual: SYN B", "2026-05-14 12:01:00 [D] -[AppDelegate applicationWillTerminate:]:99 ----- applicationWillTerminate"];
    const L = await F.parse(u8(t.join("\n") + "\n"), "com.pix4d.pix4dmapper.capture 2026-05-14--10-00-00-000.log");
    ok(L && L.kind === "pix4dcapture-log" && L.startMs === Date.UTC(2026, 4, 14, 10) && L.endMs === Date.UTC(2026, 4, 14, 10, 1) && L.device.model === "SYN B" && L.device.camera === "SYN Camera", "Pix4Dcapture log: UTC from the file name, drone corrected by the app, camera");
    ok(L.facts.some(f => f[0] === "fAppSettings" && /^Grid: grid_overlap 75, side_overlap 65, camera_angle 80/.test(f[1])) && L.verify.state === "ok", "Pix4Dcapture log: grid settings, version"); }

  /* senseFly .bbx: declarations, then [magic][group][time][u16][payload][u16]; photo tags with UTC, position (i64 deg × 1e14), WGS 84 height, accuracy */
  { const MG = [0x1e, 0x8a, 0x9a, 0x5e], le = (n, v) => { const b = new Uint8Array(n), d = new DataView(b.buffer); if (n === 2) d.setUint16(0, v, true); else if (n === 4) d.setUint32(0, v, true); return [...b]; };
    const grp = (id, name, mem) => [...le(2, id), name.length, ...u8(name), ...le(2, mem.length), ...mem.flatMap(([n, ty, c]) => [ty, n.length, ...u8(n), ...le(2, c)])];
    const idM = [["name", 1, 15], ["sn", 1, 15], ["firmwareVersion", 1, 20]];
    const tagM = [["id", 5, 1], ["utcYear", 3, 1], ["utcMonth", 1, 1], ["utcDay", 1, 1], ["utcHour", 1, 1], ["utcMin", 1, 1], ["utcSec", 8, 1], ["pitch", 8, 1], ["yaw", 8, 1], ["roll", 8, 1], ["longitude", 6, 1], ["latitude", 6, 1], ["altitudeWgs84", 8, 1], ["accXY", 8, 1], ["accZ", 8, 1], ["gpsSolType", 1, 1]];
    const decl = [...MG, 0xff, 0xff, 0, 0, 0, 0, 0, 0, ...le(2, 2), ...grp(6, "id_bb", idM), ...grp(83, "cam_PhotoTag_bb", tagM)];
    const str = (s, n) => { const b = new Uint8Array(n); b.set(u8(s)); return [...b]; };
    const rec = (id, pay) => [...MG, ...le(2, id), 0, 0, 0, 0, 0, 0, ...pay, 0, 0];
    const tag = (k, sec, lat, lon, h) => { const b = new Uint8Array(62), d = new DataView(b.buffer); d.setUint32(0, k, true); d.setUint16(4, 2026, true); b[6] = 5; b[7] = 14; b[8] = 10; b[9] = 0; d.setFloat32(10, sec, true); d.setFloat32(14, 2, true); d.setFloat32(18, 90, true); d.setFloat32(22, 1, true);
      d.setBigInt64(26, BigInt(Math.round(lon * 1e6)) * 100000000n, true); d.setBigInt64(34, BigInt(Math.round(lat * 1e6)) * 100000000n, true); d.setFloat32(42, h, true); d.setFloat32(46, 2.5, true); d.setFloat32(50, 3, true); b[54] = 2; return [...b.subarray(0, 55)]; };
    const file = Uint8Array.from([...decl, ...rec(6, [...str("EB-00-00001", 15), ...str("SYN-1", 15), ...str("2.4.10 1", 20)]), ...rec(83, tag(1, 5.5, 50.1, 14.2, 400)), 0x13, 0x37, ...rec(83, tag(2, 9, 50.1001, 14.2, 401))]);
    const L = await F.parse(file, "EB-00-00001_0001.bbx");
    ok(L && L.kind === "bbx" && L.exposures.length === 2 && L.exposures[0].t === Date.UTC(2026, 4, 14, 10, 0, 5, 500) && near(L.exposures[1].lat, 50.1001, 1e-9) && near(L.exposures[0].h, 400, 1e-3) && near(L.exposures[0].sH, 2.5, 1e-6), "eBee .bbx: photo tags with UTC, position, ellipsoid height, accuracy");
    ok(L.device.serial === "EB-00-00001" && L.device.fw === "2.4.10 1" && L.verify.state === "ok" && L.notes.includes("partial"), "eBee .bbx: identification, version, damaged bytes skipped");
    // .bbz: the same .bb3 inside a stored ZIP, with the payload computer log
    const zipE = (name, data) => { const h = new Uint8Array(30), d = new DataView(h.buffer); d.setUint32(0, 0x04034b50, true); d.setUint32(18, data.length, true); d.setUint32(22, data.length, true); d.setUint16(26, name.length, true); return cat(h, u8(name), data); };
    const Z = cat(zipE("version", u8(" Build version    : 3.22.0\n")), zipE("log_0.txt", u8("19700101-000007.835Z:DBG afpu.logger: FW version: 3.22.0 2022\n19700101-000008.297Z:DBG pm.flightsession: Starting new flight session \"IX-00-00001_0001\"\n")), zipE("IX-00-00001_0001_8.bb3", new Uint8Array(0)));
    const B = await F.parse(Z, "IX-00-00001_0001.bbz");
    ok(B && B.kind === "bbz" && B.facts.some(f => f[0] === "fBuild" && /^3\.22\.0/.test(f[1])) && B.facts.some(f => f[0] === "fSession" && /IX-00-00001_0001/.test(f[1])) && B.facts.some(f => f[0] === "fArchive" && /log_0\.txt/.test(f[1])), "eBee X .bbz: members, build, session from the log"); }

  /* Pix4Dcapture mission: plan fields for the OpenSkyLab mission block; the author's e-mail is not read */
  { const m = { expected: { photoCount: 40, flightTime: 300 }, captureDevice: { vendor: "DJI", name: "SYN P4", camera: { name: "SYN Cam", parameters: { focalLength: 8.8, imageWidth: 5000, imageHeight: 4000, sensorWidth: 13.2 } } },
      metaData: { createdBy: "someone@example.org", createdAt: "2026-05-14T08:00:00.000Z" }, appInfo: { version: "iOS-4.8.0(4)" },
      flightPlan: { waypoints: [{ flags: ["TakePhoto"], location: [14.2, 50.1, 60] }, { flags: ["TakePhoto"], location: [14.21, 50.1, 60] }] },
      missionPlan: { missionType: "DoubleGrid", frontOverlap: 0.8, sideOverlap: 0.75, cameraPitch: 80, altitude: 60, photoTriggerType: "App", surveyRegion: { regionType: "Rectangle", size: { width: 100, height: 80 }, rotation: 10 } } };
    const L = await F.parse(u8(JSON.stringify(m, null, 2)), "mission.pix4dcapture-mission");
    ok(L && L.kind === "pix4dcapture-mission" && L.plan.front === 80 && L.plan.side === 75 && L.plan.gimbalPitch === -80 && L.plan.pattern === "double_grid" && near(L.plan.gsd, 1.8, 1e-9) && L.plan.waypoints.length === 2, "Pix4Dcapture mission: overlaps, pitch, pattern, planned GSD, waypoints");
    ok(!JSON.stringify(L).includes("example.org") && !L.notes.includes("nothing-read"), "Pix4Dcapture mission: author e-mail not read");
    const O = F.oslFromFlight([L], F.combine([L], []));
    ok(O.mission["mission.overlap_forward"].val === 80 && O.mission["mission.nominal_agl"].val === 60 && O.mission["mission.planning_software"].val === "Pix4Dcapture 4.8.0(4) (iOS)", "Pix4Dcapture mission → mission fields"); }

  /* DJI CSV: exposures from rising edges of CAMERA.isPhoto, double edges merged when that matches DETAILS.photoNum */
  { const hdr = "CUSTOM.dateTime,OSD.flyTime,OSD.latitude,OSD.longitude,OSD.height,CAMERA.isPhoto,GIMBAL.pitch,DETAILS.photoNum", rows = [hdr];
    const t0 = Date.UTC(2026, 4, 14, 10); const ph = [0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0];   // 4 shots, two of them seen twice 1 s apart
    ph.forEach((p, i) => rows.push([new Date(t0 + i * 500).toISOString(), i * 0.5, 49 + i * 1e-5, 14, 50, p ? "true" : "false", -90, 3].join(",")));
    const L = await F.parse(u8(rows.join("\n") + "\n"), "flight.csv");
    ok(L && L.kind === "dji-fr-csv" && L.exposures.length === 3 && L.exposures[0].t === t0 + 500 && L.exposures[0].h === null && L.exposures[0].hRel === 50, "DJI CSV: shutter edges merged to the photo count"); }

  /* DJI app events: Home Point / RTH height and flight modes; local time only */
  { const L = await F.parse(u8('[["2026-05-14 12:00:00","","Home Point Recorded. RTH Altitude:  80m."]],[["2026-05-14 12:01:00","","Switched to S (Sport)-mode."]]'), "2026-05-14 12_00_00-SYN0000000001.dat");
    ok(L && L.kind === "dji-events" && L.facts.some(f => f[0] === "fRth" && f[1] === "80 m") && L.facts.some(f => f[0] === "fModes" && /Sport/.test(f[1])) && L.startMs == null && L.device.serial === "SYN0000000001", "DJI app events: RTH height, modes, no UTC"); }

  /* recognised only: DJI FLY.DAT (BUILD header) and Jeti transmitter telemetry (value ranges) */
  { const d = new Uint8Array(4096); d.set(u8("BUILD Jan  1 2026 10:00:00"), 16); for (let i = 64; i < d.length; i++) d[i] = (i * 7919) & 255;
    const D = await F.parse(d, "FLY001.DAT"); ok(D && D.kind === "dji-dat" && D.facts.some(f => f[0] === "fBuild" && /2026/.test(f[1])), "DJI FLY.DAT recognised with its build");
    const v3 = new Uint8Array(70000); v3.set(u8("BUILD Sep  9 2024 11:52:47"), 16); v3.set(u8("DJI_LOG_V3"), 242); let z = 12345; for (let i = 300; i < v3.length; i++) { z = (z * 1103515245 + 12345) >>> 0; v3[i] = z >>> 24; }
    const V3 = await F.parse(v3, "FLY176.DAT"); ok(V3.kind === "dji-dat" && V3.encrypted && V3.facts.some(f => f[0] === "fFormat" && /DJI_LOG_V3/.test(f[1])), "DJI FLY.DAT with DJI_LOG_V3: recognised as encrypted");
    for (let i = 300; i < v3.length; i++) v3[i] %= 224;   // entropy ≈ 7.8 bit/B, as in real scrambled files
    const V24 = await F.parse(v3, "FLY176.DAT"); ok(V24.encrypted, "DJI FLY.DAT with DJI_LOG_V3, build 2024, entropy 7.8: encrypted");
    v3.set(u8("BUILD Apr 23 2021 21:34:19"), 16); const V21 = await F.parse(v3, "FLY510.DAT"); ok(V21.kind === "dji-dat" && !V21.encrypted && V21.notes.includes("undocumented"), "DJI FLY.DAT with DJI_LOG_V3, build 2021: not called encrypted");
    const J = await F.parse(u8("# SYN\n000000000;1;0;Box; \n000000000;1;1;Voltage;V\n000001000;1;1;1;1;124\n000002000;1;1;1;1;118\n"), "10-00-00.log");
    ok(J && J.kind === "jeti" && J.facts.some(f => f[0] === "fChannels" && f[1] === "Voltage [V] 11.8–12.4"), "Jeti log: channel ranges with decimals"); }

  /* survey geometry on a synthetic grid: 4 lines 30 m apart flown alternately, 10 m between exposures every 2 s */
  { const lat0 = 50, kx = 111320 * Math.cos(lat0 * Math.PI / 180), pts = []; let t0 = Date.UTC(2026, 5, 1, 10);
    for (let ln = 0; ln < 4; ln++) for (let k = 0; k < 12; k++) { const y = (ln % 2 ? 11 - k : k) * 10, x = ln * 30; pts.push({ lat: lat0 + y / 111320, lon: 14 + x / kx, t: t0, yaw: ln % 2 ? 180 : 0 }); t0 += 2000; }
    const G = F.geometry(pts, { foot: [100, 60], gsd: 0.02, exposure: 0.001 });
    ok(G.lines === 4 && near(G.spacing, 10, 0.01) && near(G.interval, 2, 0.001) && near(G.speed, 5, 0.01), "geometry lines, spacing, interval, speed");
    ok(near(G.lineSpacing, 30, 0.05) && G.pattern === "single_grid" && G.orient === "along", "geometry line spacing, pattern, orientation");
    ok(G.overlapForward === 83 && G.overlapSide === 70, "geometry overlaps " + G.overlapForward + "/" + G.overlapSide);
    ok(near(G.blurPx, 0.25, 0.001), "geometry motion blur"); ok(G.trigger == null, "geometry: constant speed, trigger mode not decided");
    const C = F.geometryChecks(G); ok(C.find(c => c.key === "gForward").state === "ok" && C.find(c => c.key === "gSide").state === "ok" && C.find(c => c.key === "gBlur").state === "ok", "geometry checks");
    const G2 = F.geometry(pts.map(p => Object.assign({}, p, { yaw: 90 })), { foot: [100, 60] }); ok(G2.orient === "rotated" && G2.overlapForward === 90 && G2.overlapSide === 50, "geometry with the image turned across the track");
    ok(F.geometry(pts.slice(0, 2), {}).lines == null, "geometry needs 3 points"); }

  /* values for the OpenSkyLab check from a matched MRK, and agreement with the image */
  { const utc = Date.UTC(2026, 4, 14, 10, 0, 0), g = gpsMs(utc) - GPS0, wk = Math.floor(g / WEEK), sow = (g % WEEK) / 1000;
    const line = (i, s) => [i, s.toFixed(6), "[" + wk + "]", "     1,N", "    -2,E", "    80,V", (49 + i * 1e-4).toFixed(8) + ",Lat", "14.00000000,Lon", "500.000,Ellh", "0.020000, 0.015000, 0.040000", "50,Q"].join("\t");
    const L = await F.parse(u8([1, 2, 3].map(i => line(i, sow + 2 * i)).join("\n") + "\n"), "SYN_Timestamp.MRK");
    const imgs = [1, 2, 3].map(i => ({ name: "DJI_20260514120000_000" + i + "_V.JPG", S: { lat: 49 + i * 1e-4, lon: 14, utcMs: utc + 2000 * i, altAbs: 500.2 } }));
    const R = F.combine([L], imgs), O = F.oslFromFlight([L], R), im = O.images[imgs[1].name];
    ok(im && im.n === 2 && im.cols.rtk_flag.val === "fixed" && im.cols.alt_ellipsoid_m.val === 500 && im.cols.sigma_x_m.val === 0.015 && im.cols.sigma_y_m.val === 0.02 && im.cols.sigma_z_m.val === 0.04, "osl from flight: image columns");
    ok(O.mission["mission.n_images"].val === 3 && O.mission["mission.gnss_mode"].val === "RTK" && O.mission["mission.start_utc"].val === new Date(utc + 2000).toISOString(), "osl from flight: mission fields");
    ok(F.agree("lat_deg", 49.0002, 49.0002, im) === "same" && F.agree("alt_ellipsoid_m", 500.2, 500, im) === "same" && F.agree("alt_ellipsoid_m", 547, 500, im) === "differ" && F.agree("timestamp_utc", new Date(utc).toISOString(), new Date(utc + 900).toISOString()) === "differ" && F.agree("rtk_flag", "", "fixed") === null, "agreement image vs log"); }

  /* processing projects (synthetic): Pix4Dmapper .p4d and Agisoft Metashape doc.xml inside chunk.zip with a frame.zip */
  const WKT = (n, c) => 'PROJCS["' + n + '",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],AUTHORITY["EPSG","4326"]],UNIT["metre",1],AUTHORITY["EPSG","' + c + '"]]';
  { const img = (i, en, acc) => '<image path="C:/x/IMG_' + i + '.JPG" group="RGB" enabled="' + en + '"><camera name="CAM_8.8_5472x3648" id="0"/><time>2026:05:14 10:0' + i + ':00</time><accuracyXY>' + acc + '</accuracyXY><accuracyZ>' + (acc * 2) + '</accuracyZ></image>';
    const p4d = '<?xml version="1.0" encoding="UTF-8"?>\n<pix4dmapper><software><projectVersion>4.4.12</projectVersion><p4dVersion>21</p4dVersion></software><options>'
      + '<initial><runStep>true</runStep><keypointsImageScale>Full</keypointsImageScale><numberOfKeypoints>4000</numberOfKeypoints></initial>'
      + '<dense><runStep>false</runStep><pclExportLAS>true</pclExportLAS></dense><mesh><meshGenerate3dTexturedMesh>true</meshGenerate3dTexturedMesh></mesh>'
      + '<ortho><runStep>true</runStep><dsmTIFF>true</dsmTIFF><mosaicTIFF>true</mosaicTIFF><dtmTIFF>false</dtmTIFF><meanResolution>2.5</meanResolution></ortho><index><indices><index name="ndvi" formula="x" enabled="true"/></indices></index></options>'
      + '<inputs><cameras><camera name="CAM_8.8_5472x3648"><imageWidth>5472</imageWidth><imageHeight>3648</imageHeight><focalLengthmm>8.8</focalLengthmm><pixelSize>2.41</pixelSize><cameraModelSource>EXIF</cameraModelSource></camera></cameras>'
      + '<coordinateSystems><output><WKT>' + WKT("WGS 84 / UTM zone 33N", 32633) + '</WKT><verticalDef model="constShift" geoidHeight="0"/></output></coordinateSystems>'
      + '<gcps><gcp name="a" type="GCP"/><gcp name="b" type="GCP"/><gcp name="c" type="GCP"/><gcp name="d" type="checkPoint"/></gcps>'
      + '<images>' + img(1, true, 0.02) + img(2, true, 0.03) + img(3, true, 0.04) + img(4, false, 5) + '</images></inputs></pix4dmapper>';
    const L = await F.parse(u8(p4d), "SYN.p4d"), P = L && L.proc;
    ok(L && L.kind === "pix4d-project" && L.verify.state === "ok", "p4d kind and version");
    ok(P && P.software[0].version === "4.4.12" && P.steps.map(s => s.order).join() === "1,3" && P.steps[0].parameters.numberOfKeypoints === 4000 && !("runStep" in P.steps[0].parameters), "p4d steps switched on, settings");
    ok(P.products.map(x => x.type).join() === "DSM,orthomosaic,index map (ndvi)", "p4d products of the steps switched on");
    ok(P.output_crs === "EPSG:32633" && /ellipsoidal/.test(P.vertical) && P.gcp.control === 3 && P.gcp.check === 1, "p4d crs, heights, gcp");
    ok(P.adjustment_quality.images === 4 && P.adjustment_quality.images_enabled === 3 && P.adjustment_quality.prior_accuracy_xy_m === 0.03 && P.adjustment_quality.mean_gsd_cm === 2.5, "p4d image counts, prior accuracy of enabled images");
    ok(!L.facts.some(f => /C:\/x/.test(String(f[1]))), "p4d image paths not reported");
    const R = F.procRecord([L])[0]; ok(R.made.join() === "3,3,3" && R.products[0].vertical_crs && !R.products[1].vertical_crs && R.processing.output_crs === "EPSG:32633", "p4d record: products by step, heights only for surfaces");
    const O = F.oslFromFlight([L], F.combine([L], []));
    ok(O.mission["processing.software"].val[0].name === "Pix4Dmapper" && O.mission["processing.software"].log === "SYN.p4d" && O.mission["mission.gcp_count"].val === 3 && O.mission["mission.checkpoint_count"].val === 1
      && O.mission["product.product_type"].val === "DSM, orthomosaic, index map (ndvi)", "p4d values for the check table"); }

  { // a minimal ZIP writer (deflate, central directory)
    const zip = files => { const loc = [], cen = []; let off = 0;
      for (const [name, data, store] of files) { const nm = u8(name), d = store ? data : new Uint8Array(zlib.deflateRawSync(data)), h = new Uint8Array(30), c = new Uint8Array(46), hv = new DataView(h.buffer), cv = new DataView(c.buffer);
        hv.setUint32(0, 0x04034b50, true); hv.setUint16(8, store ? 0 : 8, true); hv.setUint32(18, d.length, true); hv.setUint32(22, data.length, true); hv.setUint16(26, nm.length, true);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, store ? 0 : 8, true); cv.setUint32(20, d.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nm.length, true); cv.setUint32(42, off, true);
        loc.push(h, nm, d); cen.push(c, nm); off += 30 + nm.length + d.length; }
      const cd = cat(...cen), e = new Uint8Array(22), ev = new DataView(e.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cd.length, true); ev.setUint32(16, off, true);
      return cat(...loc, cd, e); };
    const cam = (i, al) => '<camera id="' + i + '" sensor_id="0" label="IMG_' + i + '">' + (al ? '<transform>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</transform>' : '') + '<reference x="14" y="50" z="400" enabled="true"/><meta><property name="Exif/Make" value="X"/></meta></camera>';
    const mk = (i, en) => '<marker id="' + i + '" label="p' + i + '"><reference x="1" y="2" z="3" enabled="' + en + '"/></marker>';
    const chunk = '<?xml version="1.0" encoding="UTF-8"?>\n<chunk version="1.7.0" label="Chunk 1" enabled="true"><sensors next_id="1"><sensor id="0" label="CAM (8.8mm)" type="frame"><resolution width="5472" height="3648"/>'
      + '<property name="pixel_width" value="0.0024"/><property name="focal_length" value="8.8"/><calibration type="frame" class="adjusted"><resolution width="5472" height="3648"/><f>3700</f><cx>-4</cx><cy>6</cy><b1>0.5</b1><k1>-0.01</k1><k2>0.02</k2><k3>-0.003</k3><p1>0.0001</p1><p2>-0.0002</p2></calibration></sensor></sensors>'
      + '<cameras next_id="3">' + cam(0, true) + cam(1, true) + cam(2, false) + '</cameras><markers next_id="4">' + mk(0, true) + mk(1, true) + mk(2, false) + mk(3, false) + '</markers>'
      + '<elevations><elevation id="0" label="DSM"/></elevations><orthomosaics><orthomosaic id="0"/></orthomosaics><frames><frame id="0" path="0/frame.zip"/></frames>'
      + '<reference>' + WKT("ETRS89 / UTM zone 33N", 25833) + '</reference><camera_reference>GEOGCS["WGS 84",DATUM["x",SPHEROID["WGS 84",6378137,298.257223563]],AUTHORITY["EPSG","4326"]]</camera_reference>'
      + '<settings><property name="accuracy_cameras" value="0.05"/><property name="accuracy_markers" value="0.02"/></settings>'
      + '<meta><property name="AlignCameras/duration" value="12.5"/><property name="AlignCameras/downscale" value="1"/><property name="BuildOrthomosaic/blending_mode" value="1"/><property name="OptimizeCameras/sigma0" value="0.4"/>'
      + '<property name="Info/LastSavedSoftwareVersion" value="2.1.2.18548"/><property name="Info/LastSavedDateTime" value="2026:05:15 09:00:00"/></meta></chunk>';
    const frame = '<?xml version="1.0" encoding="UTF-8"?>\n<frame version="1.7.0"><markers><marker marker_id="2"><location camera_id="0" pinned="true" x="1" y="1"/></marker><marker marker_id="0"><location camera_id="0" x="1" y="1"/></marker></markers></frame>';
    const z = zip([["doc.xml", u8(chunk)], ["0/frame.zip", zip([["doc.xml", u8(frame)]]), true]]);
    const L = await F.parse(z, "chunk.zip"), P = L && L.proc;
    ok(L && L.kind === "metashape" && L.verify.state === "ok" && !L.error, "metashape zip kind and version");
    ok(P && P.steps.map(s => s.id).join() === "AlignCameras,OptimizeCameras,BuildOrthomosaic" && P.steps[0].duration_s === 12.5 && !("duration" in P.steps[0].parameters), "metashape steps in processing order, duration taken out");
    ok(!P.steps.some(s => s.id === "Exif"), "metashape camera Exif meta is not a step");
    ok(P.adjustment_quality.images === 3 && P.adjustment_quality.images_aligned === 2 && P.gcp.control === 2 && P.gcp.check === 1 && P.adjustment_quality.sigma0 === 0.4, "metashape counts; check point from frame projections");
    ok(P.output_crs === "EPSG:25833" && P.crs.cameras.epsg === "EPSG:4326" && P.photogrammetry_settings.reference_accuracy.accuracy_markers === 0.02, "metashape reference systems and accuracies");
    ok(P.products.map(x => x.type).join() === "DSM,orthomosaic" && F.procRecord([L])[0].made.join() === ",3", "metashape products, step that made the orthomosaic");
    const O = F.oslFromFlight([L], F.combine([L], [])), g = O.procGeom[0];
    ok(g.w === 5472 && g.vals["geometry.calibrated_focal_length"].val === 8.88 && g.vals["geometry.calibrated_optical_centre"].val.join() === "2732,1830" && g.vals["geometry.radial_distortion"].val.length === 3, "metashape adjusted calibration per sensor");
    const D = await F.parse(u8(chunk), "doc.xml"); ok(D.kind === "metashape" && D.proc.gcp.check === null && D.proc.adjustment_quality.markers_disabled === 2, "metashape doc.xml without frame: disabled markers not called check points");
    const X = await F.parse(u8('<?xml version="1.0" encoding="UTF-8"?>\n<document version="1.2.0" path="{projectname}.files/project.zip"/>\n'), "SYN.psx");
    ok(X.kind === "metashape" && X.notes.includes("project-pointer") && !X.proc && !X.notes.includes("nothing-read"), "metashape .psx is a pointer"); }

  /* camera angles for SfM: DJI gimbal (pitch −90 = nadir) → yaw from north, pitch 0 = nadir; a nadir shot written as roll 180 is turned back */
  { const a = F.sfmAngles(-57.2, -90, 180), b = F.sfmAngles(121.7, -89.9, 0), c = F.sfmAngles(10, -60, 0), d = F.sfmAngles(350, -90, -180);
    ok(a.yaw === 122.8 && a.pitch === 0 && a.roll === 0, "sfm angles: nadir with roll 180"); ok(b.yaw === 121.7 && b.pitch === 0.1 && b.roll === 0, "sfm angles: nadir");
    ok(c.yaw === 10 && c.pitch === 30 && c.roll === 0, "sfm angles: oblique forward"); ok(d.yaw === 170 && d.pitch === 0 && d.roll === 0, "sfm angles: roll −180"); ok(F.sfmAngles(null, -90, 0) === null, "sfm angles need yaw and pitch"); }

  /* Wingtra LiDAR recording .data (structure as firmware 5.4 writes it, values synthetic): 1 KiB header, records <u32 stream><u32 length><payload>,
     NovAtel BESTPOS inside stream 2, cut into two parts in the middle of a record */
  { const t0 = Date.UTC(2026, 4, 14, 10, 0, 0), g = t0 + 18000 - Date.UTC(1980, 0, 6), wk = Math.floor(g / 604800000), tow0 = g - wk * 604800000;
    const hdr = new Uint8Array(1024), put = (b, o, str) => { for (let i = 0; i < str.length; i++) b[o + i] = str.charCodeAt(i); };
    new DataView(hdr.buffer).setUint32(4, 1024, true); put(hdr, 8, "WINGTRA-SYN001"); put(hdr, 24, "5.4.0.0"); put(hdr, 40, "NovAtel OEM7500-1.00 SYN"); put(hdr, 104, "Hesai PandarXT32");
    const recs = [], rec = (st, p) => { const b = new Uint8Array(8 + p.length), d = new DataView(b.buffer); d.setUint32(0, st, true); d.setUint32(4, p.length, true); b.set(p, 8); recs.push(b); };
    const def = new Uint8Array(512); put(def, 0, "$IMURAW"); put(def, 65, "IL_IMU"); rec(1, def); const hd = new Uint8Array(64); put(hd, 0, "$HSAI"); rec(4, hd);
    const bestpos = (ms, lat, lon) => { const m = new Uint8Array(28 + 72 + 4), d = new DataView(m.buffer); m.set([0xaa, 0x44, 0x12, 28]); d.setUint16(4, 42, true); d.setUint16(8, 72, true); d.setUint16(14, wk, true); d.setUint32(16, ms, true);
      d.setUint32(28 + 4, 16, true); d.setFloat64(28 + 8, lat, true); d.setFloat64(28 + 16, lon, true); d.setFloat64(28 + 24, 300, true); d.setFloat32(28 + 32, 45, true); d.setFloat32(28 + 40, 1, true); d.setFloat32(28 + 44, 1, true); d.setFloat32(28 + 48, 2, true); m[28 + 65] = 12; return m; };
    for (let k = 0; k < 200; k++) { const imu = new Uint8Array(32); new DataView(imu.buffer).setFloat64(0, tow0 / 1000 + k * 0.1, true); rec(1, imu); if (k % 10 === 0) rec(2, bestpos(tow0 + k * 100, 49 + k * 1e-6, 14)); rec(4, new Uint8Array(64)); }
    const all = new Uint8Array(1024 + recs.reduce((a, b) => a + b.length, 0)); all.set(hdr); let o = 1024; for (const r of recs) { all.set(r, o); o += r.length; }
    const cut = 15000, A = await F.parse(all.slice(0, cut), "WINGTRA-2026-05-14-10-00-00-001.data"), B = await F.parse(all.slice(cut), "WINGTRA-2026-05-14-10-00-00-002.data"), f = (L, k) => (L.facts.find(x => x[0] === k) || [])[1];
    ok(A.kind === "lidar-data" && A.device.fw === "5.4.0.0" && f(A, "fScanner") === "Hesai PandarXT32" && A.startMs === t0 && A.verify.state === "ok", "lidar .data: header, time from IMU and NovAtel week");
    ok(/^1 IMURAW · IL_IMU: \d+ \(10\/s\)/.test(f(A, "fStreams")) && /BESTPOS/.test(f(A, "fMsgTypes")) && f(A, "fPvtModes").startsWith("single: ") && A.trajectory.length > 0 && A.notes.includes("lidar-static"), "lidar .data: streams, NovAtel BESTPOS");
    ok(B.kind === "lidar-data" && A.lidar.need > 0 && B.lidar.lead === A.lidar.need && B.endMs === t0 + 19900 && /begins with \d+ B/.test(f(B, "fPart")), "lidar .data: continuation part found by name, starts after the cut record");
    const C = F.combine([A, B]).checks.find(c => c.key === "cLidarParts"); ok(C && C.state === "ok", "lidar .data: parts continuous");
    const B2 = await F.parse(all.slice(cut + 3), "WINGTRA-2026-05-14-10-00-00-002.data"), C2 = F.combine([A, B2]).checks.find(c => c.key === "cLidarParts");
    ok(C2 && C2.state === "warn" && /001 → 002/.test(C2.det), "lidar .data: bytes missing between parts");
    const C3 = F.combine([A]).checks.find(c => c.key === "cLidarParts"); ok(C3 && C3.state === "warn" && /further part/.test(C3.det), "lidar .data: last part missing");
    const N = await F.parse(Uint8Array.from([...bestpos(tow0, 49, 14), ...bestpos(tow0 + 1000, 49, 14.0001)]), "SYN.gps");
    ok(N.kind === "novatel" && N.trajectory.length === 2 && N.startMs === t0 && Math.abs(N.trajectory[0].h - 345) < 1e-6, "novatel: BESTPOS positions, ellipsoidal height = MSL + undulation"); }

  /* Wingtra payload computer (OBC) log, line format of WingtraPilot 2.20 (values synthetic); OBC clock 2 h ahead of UTC */
  { const tow = k => 295824738 + k * 2000, ln = (t, lev, mod, msg) => "2026-Mar-18 " + t + "|" + lev + "|" + mod + "|" + msg;
    const lines = [ln("12:10:00.100000", "NOTICE", "MAIN", "GIT_TAG: v2.20.3 GIT_HASH: abc1234 GIT_BRANCH: HEAD"), ln("12:10:01.000000", "NOTICE", "PYLD", "Camera Software      : ILCE-6100 v1.00"),
      ln("12:10:02.000000", " WARN ", " PPK", "Found Trigger! TOW, WNc, Offset, ClkBias: 295800000, 2410, 0.002, 2.9e+10, ppkFixType 1"), ln("12:10:03.000000", " ERROR", "PYLD", "Original and copied files do not have the same file size")];
    for (let k = 0; k < 3; k++) { const s = String(6 + k * 2).padStart(2, "0"); lines.push(ln("12:10:" + s + ".990000", "NOTICE", "MAIN", "New geotag item: " + k), ln("12:10:" + s + ".999000", " WARN ", " PPK", "Found Trigger! TOW, WNc, Offset, ClkBias: " + tow(k) + ", 2410, 0.002, 3.9e+07, ppkFixType 1")); }
    const L = await F.parse(u8(lines.join("\n") + "\n"), "00007_20260318_121000.txt"), f = k => (L.facts.find(x => x[0] === k) || [])[1];
    ok(L.kind === "wingtra-obc" && L.exposures.length === 3 && L.exposures[0].t === F.gpsToUtc(2410, tow(0)) && L.device.camera === "ILCE-6100 v1.00" && L.verify.state === "ok", "wingtra obc: geotagged triggers as exposures, camera, firmware");
    ok(/^4 PPK triggers .* 3 geotag items · triggers without a geotag item: 1$/.test(f("fCameraTriggers")) && /^\+\d+\.\d s \(2 h \d+ min\)$/.test(f("fClockVsGnss")) && /^\[error\] PYLD: Original and copied/.test(f("fWarnings")), "wingtra obc: trigger count, clock offset, errors first");
    ok(Math.abs(L.startMs - (Date.UTC(2026, 2, 18, 12, 10, 0, 100) - (Date.UTC(2026, 2, 18, 12, 10, 6, 999) - F.gpsToUtc(2410, tow(0))))) < 5, "wingtra obc: span moved to UTC by the trigger offset");
    const X = await F.parse(u8('<?xml version="1.0"?>\n<log>\n\t<severity level="notice" timestamp="2023-Aug-04 08:04:19.987528">ulogWriter_thread: started.</severity>\n\t<severity level="error" timestamp="2023-Aug-04 08:04:20.000000">[ HELP]: [UMOUNT]: Process exit with non zero return 32</severity>\n</log>\n'), "20230804_080419_00012.xml");
    ok(X.kind === "wingtra-obc" && X.notes.join() === "obc-clock-unset" && /\[error\] HELP: \[UMOUNT\]/.test((X.facts.find(x => x[0] === "fWarnings") || [])[1]), "wingtra obc xml (2.8): read, no UTC without triggers"); }

  console.log(fails ? fails + " of " + n + " checks failed" : "all " + n + " flight checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
