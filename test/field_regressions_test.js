// Regression tests for vendor conventions found in field data (Reader 1.2.0).
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
  ["dji_rtk_int.jpg", () => jpeg(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleDrone"]], [dto("2030:06:01 12:00:00")], null),
    xmpPacket({ "drone-dji": "http://www.dji.com/drone-dji/1.0/" }, { "drone-dji:RtkFlag": "49", "drone-dji:RtkStdLon": "0.1", "drone-dji:RtkStdLat": "0.1", "drone-dji:RtkStdHgt": "0.2" })),
    r => r.summary.rtk.state === "int" && M.imageLog(r).find(c => c.column === "rtk_flag").value === "int"],
  ["dji_gps_time.jpg", () => jpeg(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleDrone"]], [dto("2030:06:01 14:00:00")], null),
    xmpPacket({ "drone-dji": "http://www.dji.com/drone-dji/1.0/" }, { "drone-dji:UTCAtExposure": "2030-06-01T12:00:18.500000", "drone-dji:RtkFlag": "50" })),
    r => r.summary.utc === "2030-06-01T12:00:00.500Z" && r.summary.tz === 120 && Math.abs(r.summary.clockOffset + 0.5) < 1e-6],
  ["dji_no_rtk.jpg", () => jpeg(tiffBlock([[0x10f, 2, "DJI"], [0x110, 2, "ExampleDrone"]], [dto("2030:06:01 14:00:00")], gpsBlock(50, 14, 300)),
    xmpPacket({ "drone-dji": "http://www.dji.com/drone-dji/1.0/" }, { "drone-dji:RtkFlag": "0" })),
    r => r.summary.rtk.state === "single" && r.summary.rtk.noRtk === true]
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
