/* targeted fuzzing of the JUMBF/C2PA region and of the CBOR decoder */
const fs = require("fs"), path = require("path");
const S = __dirname, M = require(path.join(S, "..", "src", "metadata-reader_lib.js"));
let seed = 987; const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ri = n => Math.floor(rand() * n);
(async () => {
  let runs = 0, maxMs = 0, worst = "", errs = 0, withC2PA = 0;
  const run = async (f, nm, b) => {
    const t0 = Date.now();
    try {
      const r = await Promise.race([M.parse(b, f), new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), 5000))]);
      M.imageLog(r); M.toCSV(r); M.toExiftoolJSON([r]); JSON.stringify(r.summary); if (r.summary.c2pa) withC2PA++;
    } catch (e) { errs++; console.log("FAIL", f, nm, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e); }
    const dt = Date.now() - t0; runs++; if (dt > maxMs) { maxMs = dt; worst = f + " " + nm; }
  };
  for (const f of process.argv.slice(2)) {
    const orig = new Uint8Array(fs.readFileSync(path.resolve(f)));
    const r0 = await M.parse(orig, f), cs = r0.structure.filter(s => s.kind === "c2pa");
    if (!cs.length) { console.log("no c2pa region in", f); continue; }
    const a = Math.min(...cs.map(s => s.offset)), z = Math.max(...cs.map(s => s.offset + s.length));
    for (let k = 0; k < 300; k++) { const c = orig.slice(); const n = 1 + ri(20); for (let j = 0; j < n; j++) c[a + ri(z - a)] = ri(256); await run(f, "flip" + k, c); }
    for (let k = 0; k < 150; k++) { const c = orig.slice(); const p = a + ri(z - a - 4); const v = [[255, 255, 255, 255], [0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 8], [0, 0, 0, 9], [0x7f, 0xff, 0xff, 0xff], [0x9f, 0x9f, 0x9f, 0x9f], [0xbf, 0xbf, 0xbf, 0xbf], [0x5b, 0xff, 0xff, 0xff], [0xd8, 0x12, 0x84, 0x40]][ri(10)]; c.set(v, p); await run(f, "word" + k, c); }
    for (let k = 0; k < 60; k++) await run(f, "trunc" + k, orig.slice(0, a + ri(z - a)));
    for (let k = 0; k < 40; k++) { const c = orig.slice(); const p = a + ri(z - a - 64); c.copyWithin(p, a + ri(z - a - 64), z); await run(f, "shift" + k, c); }
  }
  /* raw CBOR decoder: random and nested inputs */
  let cerr = 0, cok = 0; const t0 = Date.now();
  for (let k = 0; k < 20000; k++) {
    const n = 1 + ri(64), b = new Uint8Array(n); for (let j = 0; j < n; j++) b[j] = ri(256);
    try { M.cborDecode(b); cok++; } catch (e) { if (!/^CBOR /.test(e.message)) { console.log("CBOR non-CBOR error", e.message); errs++; } cerr++; }
  }
  for (const bad of [new Uint8Array(5000).fill(0x81), new Uint8Array(5000).fill(0x9f), new Uint8Array(5000).fill(0xbf), Uint8Array.from([0x9b, 255, 255, 255, 255, 255, 255, 255, 255]), Uint8Array.from([0x5b, 0, 0, 0, 255, 255, 255, 255, 255]), Uint8Array.from([0x7f, 0x61, 0x41, 0x7f, 0xff, 0xff])]) {
    try { M.cborDecode(bad); cok++; } catch (e) { if (!/^CBOR /.test(e.message)) { console.log("CBOR non-CBOR error", e.message); errs++; } cerr++; }
  }
  for (let k = 0; k < 3000; k++) { const n = 1 + ri(200), b = new Uint8Array(n); b[0] = 0x30; for (let j = 1; j < n; j++) b[j] = ri(256); try { M._x509(b); } catch (e) { errs++; console.log("x509 threw", e.message); } }
  console.log("parse runs", runs, "errors", errs, "max ms", maxMs, worst, "| results with C2PA summary", withC2PA, "| cbor ok", cok, "rejected", cerr, "in", Date.now() - t0, "ms");
  process.exitCode = errs ? 1 : 0;
})();
