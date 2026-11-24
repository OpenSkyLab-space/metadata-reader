// Regression tests for vendor conventions found in field data (Reader 1.2.0; thermal cases 1.5.0).
// All files are built here from scratch: the structure follows the vendors, every value is synthetic.
// Usage: node test/field_regressions_test.js
"use strict";
const path = require("path");
const M = require(path.join(__dirname, "..", "src", "metadata-reader_lib.js"));

/* ---- minimal JPEG / TIFF builders (little-endian TIFF, ASCII and SHORT/LONG/RATIONAL tags) */
function tiffIFD(entries, base) {
  // entries: [tag, type, value]; type 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL ([num, den] pairs)
  entries.sort((a, b) => a[0] - b[0]);
  const n = entries.length, dirLen = 2 + n * 12 + 4; let extra = [], extraOff = base + dirLen;
  const dir = Buffer.alloc(dirLen); dir.writeUInt16LE(n, 0);
  entries.forEach(([tag, type, v], i) => {
    const o = 2 + i * 12; dir.writeUInt16LE(tag, o); dir.writeUInt16LE(type, o + 2);
    let data;
    if (type === 2) data = Buffer.from(v + "\0", "latin1");
    else if (type === 3) { data = Buffer.alloc(2 * v.length); v.forEach((x, k) => data.writeUInt16LE(x, 2 * k)); }
    else if (type === 4) { data = Buffer.alloc(4 * v.length); v.forEach((x, k) => data.writeUInt32LE(x, 4 * k)); }
    else if (type === 5) { data = Buffer.alloc(8 * v.length); v.forEach((x, k) => { data.writeUInt32LE(x[0], 8 * k); data.writeUInt32LE(x[1], 8 * k + 4); }); }
    else if (type === 7) data = Buffer.from(v);
    const count = type === 2 ? data.length : type === 7 ? data.length : v.length;
    dir.writeUInt32LE(count, o + 4);
    if (data.length <= 4) data.copy(dir, o + 8);
    else { dir.writeUInt32LE(extraOff, o + 8); extra.push(data); extraOff += data.length + (data.length & 1); if (data.length & 1) extra.push(Buffer.alloc(1)); }
  });
  return Buffer.concat([dir].concat(extra));
}
function tiffBlock(ifd0, exif, gps, opts) {
  // returns a TIFF stream; ifd0 entries get ExifOffset / GPSInfo / XMP (700) added
  opts = opts || {};
  const hdr = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  const pass = (exOff, gpsOff) => {
    const e0 = ifd0.slice();
    if (exif) e0.push([0x8769, 4, [exOff]]); if (gps) e0.push([0x8825, 4, [gpsOff]]);
    if (opts.xmp) e0.push([700, 7, Buffer.from(opts.xmp, "utf8")]);
    return tiffIFD(e0, 8);
  };
  let d0 = pass(0, 0); const exOff = 8 + d0.length; const de = exif ? tiffIFD(exif, exOff) : Buffer.alloc(0);
  const gpsOff = exOff + de.length; const dg = gps ? tiffIFD(gps, gpsOff) : Buffer.alloc(0);
  d0 = pass(exOff, gpsOff);
  return Buffer.concat([hdr, d0, de, dg]);
}
function seg(marker, payload) { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]); }
function jpeg(tiff, xmp, trailer) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (tiff) parts.push(seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])));
  if (xmp) parts.push(seg(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xmp, "utf8")])));
  parts.push(Buffer.from([0xff, 0xd9])); if (trailer) parts.push(trailer);
  return Buffer.concat(parts);
}
function xmpPacket(ns, props) {
  const nsd = Object.entries(ns).map(([p, u]) => ` xmlns:${p}="${u}"`).join("");
  const at = Object.entries(props).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""${nsd}${at}/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
const CAMNS = "http://pix4d.com/camera/1.0/", DLSNS = "http://micasense.com/DLS/1.0/", SFNS = "http://ns.sensefly.com/xmp/1.0/";
const dto = s => [0x9003, 2, s];
const gpsBlock = (lat, lon, alt) => [[1, 2, "N"], [2, 5, [[Math.floor(lat), 1], [0, 1], [0, 1]]], [3, 2, "E"], [4, 5, [[Math.floor(lon), 1], [0, 1], [0, 1]]], [5, 7, Buffer.from([0])], [6, 5, [[Math.round(alt * 100), 100]]]];

/* synthetic Sequoia sunshine record list: 3 records of 28 bytes */
function sunshine() {
  const b = Buffer.alloc(28 * 3);
  [[1000000, 1000, 500], [1200000, 1100, 550], [1400000, 1200, 600]].forEach(([t, c0, c1], i) => {
    const o = 28 * i; b.writeUInt32LE(t, o); b.writeUInt32LE(0, o + 4); b.writeUInt16LE(c0, o + 8); b.writeUInt16LE(c1, o + 10); b.writeUInt16LE(2, o + 12); b.writeUInt16LE(50, o + 14);
    b.writeFloatLE(10, o + 16); b.writeFloatLE(1, o + 20); b.writeFloatLE(-1, o + 24);
  });
  return b.toString("base64");
}

/* ---- thermal (Reader 1.5.0): DJI R-JPEG APP3/APP4/APP7, FLIR FFF in APP1, ThermoTIFF TIFF; layouts as in ExifTool DJI.pm and FLIR.pm, values synthetic */
function jpegSegs(tiff, xmp, segs) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (tiff) parts.push(seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])));
  if (xmp) parts.push(seg(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xmp, "utf8")])));
  for (const [m, b] of segs) parts.push(seg(m, b));
  parts.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(parts);
}
function djiApp4v2(v) { /* 32-byte prefix "iirp", floats at +32, detection bytes 2c 01 20 00 at +64 */
  const b = Buffer.alloc(256); Buffer.from([0xff, 0xd2, 0xd1, 0xff]).copy(b, 0); b.write("iirp", 4, "latin1");
  [v.amb, v.dist, v.e, v.rh, v.refl].forEach((x, i) => b.writeFloatLE(x, 32 + 4 * i)); Buffer.from([0x2c, 0x01, 0x20, 0x00]).copy(b, 64); return b;
}
function djiApp4v3(v) { const b = Buffer.alloc(64); Buffer.from([0xaa, 0x55, 0x38, 0x00]).copy(b, 32); b.writeUInt16LE(v.rh, 36); b.writeUInt16LE(v.dist * 10, 38); b.writeUInt16LE(v.e * 100, 40); b.writeUInt16LE(v.refl * 10, 42); return b; }
const djiDbg = id => Buffer.concat([Buffer.from("DJI-DBG\0[sensor_id:" + id, "latin1"), Buffer.alloc(6), Buffer.from("]", "latin1")]);
const DJINS = { "drone-dji": "http://www.dji.com/drone-dji/1.0/" };
const djiThermalJpeg = (app4, xmpProps) => jpegSegs(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleT"]], [dto("2030:06:01 12:00:00")], null),
  xmpPacket(DJINS, Object.assign({ "drone-dji:RelativeAltitude": "+60.000", "drone-dji:GimbalPitchDegree": "-90.00" }, xmpProps)),
  [[0xe3, Buffer.alloc(32)], [0xe4, app4], [0xe7, djiDbg("SYN0000TEST")]]);
function flirJpeg() {
  /* FFF: 64-byte header (big-endian, version 100), directory of 2 records (RawData, CameraInfo); records little-endian */
  const raw = Buffer.alloc(32 + 4 * 2 * 2); raw.writeUInt16LE(2, 0); raw.writeUInt16LE(4, 2); raw.writeUInt16LE(2, 4);
  const ci = Buffer.alloc(0x470); ci.writeUInt16LE(2, 0);
  const fl = (o, x) => ci.writeFloatLE(x, o), K = c => c + 273.15;
  fl(0x20, 0.97); fl(0x24, 30); fl(0x28, K(15)); fl(0x2c, K(18)); fl(0x30, K(18)); fl(0x34, 1); fl(0x3c, 0.6);
  fl(0x58, 12345.6); fl(0x5c, 1400); fl(0x60, 1); fl(0x70, 0.0066); fl(0x74, 0.0126); fl(0x78, -0.0023); fl(0x7c, -0.0067); fl(0x80, 1.9);
  fl(0x90, K(150)); fl(0x94, K(-25)); ci.writeInt32LE(-500, 0x308); fl(0x30c, 0.5); ci.writeUInt16LE(9, 0x464);
  const hdr = Buffer.alloc(64); hdr.write("FFF\0", 0, "latin1"); hdr.write("SYNTH", 4, "latin1"); hdr.writeUInt32BE(100, 0x14); hdr.writeUInt32BE(64, 0x18); hdr.writeUInt32BE(2, 0x1c);
  const dir = Buffer.alloc(64), o1 = 128, o2 = o1 + raw.length;
  dir.writeUInt16BE(1, 0); dir.writeUInt32BE(o1, 12); dir.writeUInt32BE(raw.length, 16); dir.writeUInt16BE(0x20, 32); dir.writeUInt32BE(o2, 44); dir.writeUInt32BE(ci.length, 48);
  const fff = Buffer.concat([hdr, dir, raw, ci]), half = 700;
  const chunk = (k, d) => Buffer.concat([Buffer.from("FLIR\0", "latin1"), Buffer.from([1, k, 1]), d]);
  return jpegSegs(tiffBlock([[0x10f, 2, "ExampleIR"], [0x110, 2, "Duo"]], [dto("2030:06:01 12:00:00")], null), null, [[0xe1, chunk(0, fff.subarray(0, half))], [0xe1, chunk(1, fff.subarray(half))]]);
}
const TT_DESC = "Temperature in degrees Celsius (float32). Converted from DJI_0001_T.JPG by ThermoTIFF 0.1.0 using DJI Thermal SDK API 0x103. distance=20 m; humidity=55 %; emissivity=0.96; reflection=21.5 C; ambient=19 C";

/* ---- Wingtra (Reader 1.5.0): a Sony JPEG after WingtraHub geotagging. DateTimeOriginal rewritten, CreateDate kept from an unset camera clock,
   APP1 rewritten with zero padding after EOI so that the MPF preview offset stays valid; the MP image list (32 bytes) is stored as a value array */
function hubSonyJpeg() {
  const tiff = tiffBlock([[0x10f, 2, "SONY"], [0x110, 2, "ExampleCam"]], [dto("2030:06:01 12:00:00"), [0x9004, 2, "2019:01:01 00:04:50"], [0x9011, 2, "+01:00"]], null);
  const mpfSeg = start => { // MPF payload: "MPF\0" + little-endian TIFF with version, number of images and a 2-entry image list
    const list = Buffer.alloc(32); list.writeUInt32LE(0x20030000, 0); list.writeUInt32LE(999999, 4); list.writeUInt32LE(0, 8); list.writeUInt32LE(0x00010002, 16); list.writeUInt32LE(4, 20); list.writeUInt32LE(start, 24);
    const t = Buffer.concat([Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]), tiffIFD([[0xb000, 7, Buffer.from("0100", "latin1")], [0xb001, 4, [2]], [0xb002, 7, list]], 8)]);
    return seg(0xe2, Buffer.concat([Buffer.from("MPF\0", "latin1"), t]));
  };
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]))]);
  const base = head.length + 4 + 4, pad = Buffer.alloc(37), tail = Buffer.from([0xff, 0xd9]), preview = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const mp = mpfSeg(0), end = head.length + mp.length + tail.length;
  return Buffer.concat([head, mpfSeg(end + pad.length - base), tail, pad, preview]);
}
/* DJI M3T (2026): MPF image 1 declares a length past its EOI, filled with non-zero bytes; MPF image 2 starts right after that length */
function djiMpfGapJpeg() {
  const tiff = tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleT"]], [dto("2030:06:01 12:00:00")], null);
  const mpfSeg = (len1, start) => { const list = Buffer.alloc(32); list.writeUInt32LE(0x20030000, 0); list.writeUInt32LE(len1, 4); list.writeUInt32LE(0, 8); list.writeUInt32LE(0x00010001, 16); list.writeUInt32LE(4, 20); list.writeUInt32LE(start, 24);
    const t = Buffer.concat([Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]), tiffIFD([[0xb000, 7, Buffer.from("0100", "latin1")], [0xb001, 4, [2]], [0xb002, 7, list]], 8)]);
    return seg(0xe2, Buffer.concat([Buffer.from("MPF\0", "latin1"), t])); };
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]))]);
  const base = head.length + 4 + 4, gap = Buffer.alloc(51, 0xff), tail = Buffer.from([0xff, 0xd9]), preview = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const end = head.length + mpfSeg(0, 0).length + tail.length, len1 = end + gap.length;
  return Buffer.concat([head, mpfSeg(len1, len1 - base), tail, gap, preview]);
}
const CASES = [
  ["dls2_irradiance.tif", () => tiffBlock([[0x10f, 2, "MicaSense"], [0x110, 2, "RedEdge-P"]], [dto("2030:06:01 10:00:00")], null,
    { xmp: xmpPacket({ Camera: CAMNS, DLS: DLSNS }, { "Camera:BandName": "Blue", "Camera:CentralWavelength": "475", "Camera:Irradiance": "50.5", "DLS:HorizontalIrradiance": "48.0", "DLS:SpectralIrradiance": "50.5" }) }),
    r => Math.abs(r.summary.irradiance.value - 50.5) < 1e-9 && r.summary.irradiance.unit === "uW/cm2/nm"],
  ["dls1_irradiance.tif", () => tiffBlock([[0x10f, 2, "MicaSense"], [0x110, 2, "RedEdge-M"]], [dto("2030:06:01 10:00:00")], null,
    { xmp: xmpPacket({ Camera: CAMNS }, { "Camera:BandName": "Blue", "Camera:CentralWavelength": "475", "Camera:Irradiance": "0.505" }) }),
    r => Math.abs(r.summary.irradiance.value - 50.5) < 1e-9],
  ["rational_accuracy.jpg", () => jpeg(tiffBlock([[0x10f, 2, "ExampleCam"], [0x110, 2, "TIR"]], [dto("2030:06:01 12:00:00")], gpsBlock(50, 14, 300)),
    xmpPacket({ Camera: CAMNS }, { "Camera:GPSXYAccuracy": "25/10", "Camera:GPSZAccuracy": "40/10" })),
    r => Math.abs(r.summary.rtk.sx - 2.5) < 1e-9 && Math.abs(r.summary.rtk.sz - 4) < 1e-9],
  ["sensefly_xmp.tif", () => tiffBlock([[0x10f, 2, "senseFly"], [0x110, 2, "ExampleThermal"]], [dto("2030:06:01 05:00:00")], gpsBlock(49, 16, 700),
    { xmp: xmpPacket({ sensefly: SFNS }, { "sensefly:Roll": "3.5", "sensefly:Pitch": "-1.5", "sensefly:Yaw": "120", "sensefly:GPSXYAccuracy": "4.5", "sensefly:GPSZAccuracy": "6" }) }),
    r => r.summary.flight.yaw === 120 && r.summary.flight.src === "XMP:sensefly" && r.summary.rtk.sx === 4.5 && r.summary.utc === "2030-06-01T05:00:00.000Z"
      && M.imageLog(r).find(c => c.column === "alt_ellipsoid_m").note === "ellipsoid-sensefly"],
  ["sequoia_sunshine.tif", () => tiffBlock([[0x10f, 2, "Parrot"], [0x110, 2, "Sequoia"]], [dto("2030:06:01 09:00:00")], null,
    { xmp: xmpPacket({ Camera: CAMNS }, { "Camera:BandName": "Green", "Camera:CentralWavelength": "550", "Camera:CalibrationPicture": "1", "Camera:IrradianceList": sunshine() }) }),
    r => r.summary.sunshine && r.summary.sunshine.n === 3 && Math.abs(r.summary.sunshine.rel - (1000 + 1100 + 1200) / 3 / 100) < 1e-9 && r.summary.panel && r.summary.utc === "2030-06-01T09:00:00.000Z"],
  ["sensor_temp_invalid.jpg", () => jpeg(tiffBlock([[0x10f, 2, "senseFly"], [0x110, 2, "ExampleIR"]], [dto("2030:06:01 08:00:00")], null),
    xmpPacket({ Camera: CAMNS }, { "Camera:SensorTemperature": "6553.1" })),
    r => r.summary.sensorTempInvalid === true],
  ["mapir_clock.jpg", () => jpeg(tiffBlock([[0x10f, 2, "MAPIR"], [0x110, 2, "Survey3N_OCN"]], [dto("2019:01:01 00:01:00")], null), null,
    Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from([0xff, 0xd8, 0xff, 0xd9])])),
    r => r.summary.band && r.summary.band.name === "Orange,Cyan,NIR" && r.summary.clockSuspect === "reset" && r.warnings.some(w => /JPEG at \+3/.test(w.text))
      && M.imageLog(r).find(c => c.column === "timestamp_utc").note === "clock-suspect"],
  ["dji_rjpeg_params2.jpg", () => djiThermalJpeg(djiApp4v2({ amb: 22, dist: 5, e: 0.95, rh: 0.6, refl: 20 }), { "drone-dji:LRFStatus": "Normal", "drone-dji:LRFTargetDistance": "0.000" }),
    r => { const T = r.summary.thermal, P = T && T.params; return P && P.emissivity === 0.95 && P.object_distance_m === 5 && P.relative_humidity_pct === 60 && P.reflected_temperature_c === 20 && P.ambient_temperature_c === 22
      && T.sensorId === "SYN0000TEST" && r.summary.lrf && r.summary.lrf.measured === false && r.summary.sensorType === "thermal_LWIR" && T.checks.some(c => c[0] === "object_distance_m")
      && r.groups.some(g => g.id === "APP4:DJI" && g.tags.some(t => t.name === "ThermalParamsPrefix" && t.value === "iirp")) && M.imageLog(r).find(c => c.column === "fpa_temp_c").note === "not-written"; }],
  ["dji_rjpeg_params3.jpg", () => djiThermalJpeg(djiApp4v3({ rh: 70, dist: 12.5, e: 0.9, refl: 23.4 }), { "drone-dji:LRFStatus": "Normal", "drone-dji:LRFTargetDistance": "61.250" }),
    r => { const P = r.summary.thermal.params; return P.relative_humidity_pct === 70 && P.object_distance_m === 12.5 && P.emissivity === 0.9 && Math.abs(P.reflected_temperature_c - 23.4) < 1e-9 && P.ambient_temperature_c == null && r.summary.lrf.measured === true && r.summary.lrf.distance === 61.25; }],
  ["flir_fff.jpg", flirJpeg,
    r => { const T = r.summary.thermal, P = T && T.params; return T.kind === "FLIR radiometric JPEG" && P.emissivity === 0.97 && P.object_distance_m === 30 && P.reflected_temperature_c === 15 && P.atmospheric_temperature_c === 18 && P.relative_humidity_pct === 60
      && T.planck.B === 1400 && T.planck.O === -500 && T.planck.R2 === 0.5 && T.range[0] === -25 && T.range[1] === 150 && /4 x 2/.test(T.encoding)
      && r.groups.some(g => g.id === "APP1:FLIR" && g.tags.some(t => t.name === "CreatorSoftware" && t.value === "SYNTH") && g.tags.some(t => t.name === "FrameRate" && t.value === 9)); }],
  ["thermotiff.tif", () => tiffBlock([[0x10e, 2, TT_DESC], [0x10f, 2, "DJI"], [0x110, 2, "ExampleT"], [0x131, 2, "ThermoTIFF 0.1.0"], [0x102, 3, [32]], [0x153, 3, [3]],
    [0xa480, 2, '<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">degC</Item></GDALMetadata>']], [dto("2030:06:01 12:00:00")], null),
    r => { const T = r.summary.thermal; return T && T.kind === "ThermoTIFF" && T.thermotiff.version === "0.1.0" && T.thermotiff.sdk_api === "0x103" && T.thermotiff.source === "DJI_0001_T.JPG"
      && T.thermotiff.params.object_distance_m === 20 && T.thermotiff.params.relative_humidity_pct === 55 && T.thermotiff.params.emissivity === 0.96 && T.thermotiff.params.reflected_temperature_c === 21.5 && T.thermotiff.params.ambient_temperature_c === 19
      && T.params === null && /UNITTYPE degC/.test(T.encoding) && r.summary.sensorType === "thermal_LWIR"; }],
  ["dji_rtk_int.jpg", () => jpeg(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleDrone"]], [dto("2030:06:01 12:00:00")], null),
    xmpPacket({ "drone-dji": "http://www.dji.com/drone-dji/1.0/" }, { "drone-dji:RtkFlag": "49", "drone-dji:RtkStdLon": "0.1", "drone-dji:RtkStdLat": "0.1", "drone-dji:RtkStdHgt": "0.2" })),
    r => r.summary.rtk.state === "int" && M.imageLog(r).find(c => c.column === "rtk_flag").value === "int"],
  ["dji_gps_time.jpg", () => jpeg(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleDrone"]], [dto("2030:06:01 14:00:00")], null),
    xmpPacket({ "drone-dji": "http://www.dji.com/drone-dji/1.0/" }, { "drone-dji:UTCAtExposure": "2030-06-01T12:00:18.500000", "drone-dji:RtkFlag": "50" })),
    r => r.summary.utc === "2030-06-01T12:00:00.500Z" && r.summary.tz === 120 && Math.abs(r.summary.clockOffset + 0.5) < 1e-6],
  ["dji_no_rtk.jpg", () => jpeg(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleDrone"]], [dto("2030:06:01 14:00:00")], gpsBlock(50, 14, 300)),
    xmpPacket({ "drone-dji": "http://www.dji.com/drone-dji/1.0/" }, { "drone-dji:RtkFlag": "0" })),
    r => r.summary.rtk.state === "single" && r.summary.rtk.noRtk === true],
  ["wingtra_hub_sony.jpg", hubSonyJpeg,
    r => r.summary.clockSuspect === "rewritten" && r.warnings.some(w => w.code === "clock") && !r.warnings.some(w => w.code === "trailer")
      && r.structure.some(x => x.segment === "zero padding before MPF image" && x.length === 37) && r.structure.some(x => /^MPF image 2/.test(x.segment))],
  ["dji_mpf_gap.jpg", djiMpfGapJpeg,
    r => !r.warnings.some(w => w.code === "trailer") && r.structure.some(x => x.segment === "data after EOI within MPF image 1" && x.length === 51) && r.structure.some(x => /^MPF image 2/.test(x.segment))],
  ["gps_whole_seconds.tif", () => tiffBlock([[0x10f, 2, "MicaSense"], [0x110, 2, "RedEdge-P"]], [dto("2030:06:01 12:00:00"), [0x9291, 2, "408"]],
    gpsBlock(50, 14, 400).concat([[7, 5, [[11, 1], [0, 1], [0, 1]]], [29, 2, "2030:06:01"]])),
    r => r.summary.tz === 60 && r.summary.clockOffset === 0 && r.summary.utc === "2030-06-01T11:00:00.000Z"],
];

(async () => {
  let fail = 0;
  for (const [name, mk, check] of CASES) {
    const b = mk(); let ok = false, err = "";
    try { const r = await M.parse(new Uint8Array(b), name); ok = !!check(r); if (!ok) err = JSON.stringify({ s: { irr: r.summary.irradiance, rtk: r.summary.rtk, flight: r.summary.flight, utc: r.summary.utc, band: r.summary.band, clock: r.summary.clockSuspect }, w: r.warnings }).slice(0, 600); }
    catch (e) { err = e.stack; }
    if (!ok) fail++;
    console.log((ok ? "ok   " : "FAIL ") + name + (err ? "  " + err : ""));
  }
  console.log(CASES.length + " cases, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
