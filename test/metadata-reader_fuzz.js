const fs = require("fs"), path = require("path");
const S = __dirname, M = require(path.join(S, "..", "src", "metadata-reader_lib.js"));
let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const files = process.argv.slice(2);
(async () => {
  let runs = 0, maxMs = 0, worst = "", errs = 0;
  for (const f of files) {
    const orig = new Uint8Array(fs.readFileSync(path.resolve(f)));
    const variants = [];
    for (let k = 0; k < 60; k++) variants.push(["trunc" + k, orig.slice(0, Math.floor(rand() * orig.length))]);
    for (let k = 0; k < 150; k++) { const c = orig.slice(); const n = 1 + Math.floor(rand() * 40); for (let j = 0; j < n; j++) c[Math.floor(rand() * c.length)] = Math.floor(rand() * 256); variants.push(["flip" + k, c]); }
    for (let k = 0; k < 40; k++) { const c = orig.slice(); const p = Math.floor(rand() * (c.length - 8)); const v = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0x7f, 0xff][Math.floor(rand() * 10)]; for (let j = 0; j < 4; j++) c[p + j] = v; variants.push(["word" + k, c]); }
    variants.push(["empty", new Uint8Array(0)], ["one", orig.slice(0, 1)], ["hdr", orig.slice(0, 4)]);
    for (const [nm, b] of variants) {
      const t0 = Date.now();
      try {
        const r = await Promise.race([M.parse(b, f), new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), 5000))]);
        M.imageLog(r); M.toCSV(r); M.toExiftoolJSON([r]); JSON.stringify(r.summary);
      } catch (e) { errs++; console.log("FAIL", f, nm, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e); }
      const dt = Date.now() - t0; runs++; if (dt > maxMs) { maxMs = dt; worst = f + " " + nm; }
    }
  }
  console.log("runs", runs, "errors", errs, "max ms", maxMs, worst);
  process.exitCode = errs ? 1 : 0;
})();
