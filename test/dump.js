const fs = require("fs"), path = require("path");
const S = __dirname, M = require(path.join(S, "..", "src", "metadata-reader_lib.js"));
// Prints what the parser reads from the given files (a debugging aid). Usage: node test/dump.js FILE...
const files = process.argv.slice(2);
if (!files.length) { console.log("usage: node test/dump.js FILE..."); process.exit(0); }
(async () => {
  for (const f of files) {
    const b = fs.readFileSync(path.resolve(f));
    const r = await M.parse(new Uint8Array(b), path.basename(f), { xml: process.env.XML || "auto" });
    console.log("=== " + f + " type=" + r.file.type + " size=" + r.file.size);
    for (const g of r.groups) console.log("  " + g.id.padEnd(22) + g.tags.length + "  " + g.tags.slice(0, 200).map(t => t.name + "=" + String(t.display).slice(0, 40)).join(" | ").slice(0, process.env.FULL ? 100000 : 300));
    console.log("  warnings:", JSON.stringify(r.warnings));
    console.log("  structure:", r.structure.map(s => s.segment + "@" + s.offset + "+" + s.length + "(" + s.kind + "," + s.depth + ")").join("; "));
    const s = r.summary;
    console.log("  summary:", JSON.stringify({ make: s.make, model: s.model, w: s.width, h: s.height, spw: s.sensorPxW, pitch: s.pixelPitch, sensorW: s.sensorW, hfov: s.hfov, vfov: s.vfov, gsd: s.gsd, gsdH: s.gsdHeight, fp: s.footprint, lat: s.lat, lon: s.lon, utc: s.utc, utcSrc: s.utcSrc, tz: s.tz, tzSrc: s.tzSrc, sun: s.sun && [s.sun.elevation, s.sun.azimuth], rtk: s.rtk, band: s.band, irr: s.irradiance, gain: s.sensorGain, jq: s.jpegQuality, sensorType: s.sensorType, crop: s.crop, lv: s.lv }));
    console.log("  imageLog:", M.imageLog(r).map(x => x.column + "=" + x.value + "[" + x.status[0] + "]").join(" "));
  }
})();
