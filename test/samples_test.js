// Parses the embedded synthetic samples and the sample flight and checks the main results.
// Usage: node test/samples_test.js [--out DIR]   (--out also writes the decoded files, e.g. for the fuzz tests)
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const M = require(path.join(__dirname, "..", "src", "metadata-reader_lib.js"));
const SRC = path.join(__dirname, "..", "src");
const out = process.argv.indexOf("--out") > 0 ? process.argv[process.argv.indexOf("--out") + 1] : null;
const ERR = /^(parse|input|unknown-format|bad-tiff|derive)$/;
const files = [];
const S = JSON.parse(fs.readFileSync(path.join(SRC, "metadata-reader_samples.json"), "utf8"));
for (const k of Object.keys(S)) {
  const b = Buffer.from(S[k].data, "base64");
  if (b.length !== S[k].bytes || crypto.createHash("sha256").update(b).digest("hex") !== S[k].sha256) throw new Error("sample " + k + " corrupted");
  files.push([S[k].name, b]);
}
const F = JSON.parse(fs.readFileSync(path.join(SRC, "metadata-reader_flight.json"), "utf8"));
for (const n of Object.keys(F)) files.push([n, Buffer.from(F[n], "base64")]);
// expectations that must not silently change (synthetic files, values set by their generators)
const EXPECT = {
  "sample1_dji_rgb.jpg": r => r.summary.make === "DJI" && r.summary.lat != null && r.summary.rtk && r.summary.rtk.state === "fixed",
  "sample3_micasense_red.tif": r => r.summary.band != null,
  "sample5_geotiff_dem.tif": r => r.groups.some(g => /geo/i.test(g.id)),
  "sample6_c2pa_synthetic.jpg": r => !!r.summary.c2pa
};
(async () => {
  let fail = 0;
  if (out) fs.mkdirSync(out, { recursive: true });
  for (const [name, b] of files) {
    const r = await M.parse(new Uint8Array(b), name);
    M.imageLog(r); M.toCSV(r); M.toExiftoolJSON([r]);
    const bad = (r.warnings || []).filter(w => ERR.test(w.code));
    const ok = !bad.length && (!EXPECT[name] || EXPECT[name](r));
    if (!ok) fail++;
    console.log((ok ? "ok   " : "FAIL ") + name.padEnd(30) + r.file.type.padEnd(8) + r.groups.reduce((a, g) => a + g.tags.length, 0) + " tags" + (bad.length ? " " + JSON.stringify(bad) : ""));
    if (out) fs.writeFileSync(path.join(out, name), b);
  }
  console.log(files.length + " files, " + fail + " failed; parser OSLMeta " + M.version);
  process.exitCode = fail ? 1 : 0;
})();
