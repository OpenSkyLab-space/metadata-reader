// Build metadata-reader.html (teaching version) and metadata-reader_tool.html (tool version: no tasks, tool header texts)
// from its parts (text files only). Run: node metadata-reader_build.js [output dir] [cs|en: language of the pre-rendered texts, default cs]
"use strict";
const fs = require("fs"), path = require("path");
const D = __dirname, rd = f => fs.readFileSync(path.join(D, f), "utf8");
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : D;
fs.mkdirSync(OUT, { recursive: true });
const SL = process.argv[3] === "en" ? "en" : "cs";
const p1 = rd("metadata-reader_p1.html");
const lib = rd("metadata-reader_lib.js").replace(/\s+$/, "");
const osl = rd("metadata-reader_osl.js").replace(/\s+$/, "");
const tx = rd("metadata-reader_t.js").replace(/\s+$/, "");
const ui = rd("metadata-reader_ui.js").replace(/\s+$/, "");
const fl = rd("metadata-reader_flight.js").replace(/\s+$/, ""), flui = rd("metadata-reader_flight_ui.js").replace(/\s+$/, "");
if (!/^\/\*OSL-FLIGHT-START\*\//.test(fl.trim()) || !/\/\*OSL-FLIGHT-END\*\/$/.test(fl)) throw new Error("flight markers missing");
if (!/^\/\*OSL-META-READER-START\*\//.test(lib.trim()) || !/\/\*OSL-META-READER-END\*\/$/.test(lib)) throw new Error("lib markers missing");

// embedded samples come from one text file (base64), never from binary image files
const SJ = JSON.parse(rd("metadata-reader_samples.json")), SAMPLES = {};
for (const k of Object.keys(SJ)) {
  const s = SJ[k], buf = Buffer.from(s.data, "base64");
  if (buf.length !== s.bytes || require("crypto").createHash("sha256").update(buf).digest("hex") !== s.sha256) throw new Error("sample " + k + " corrupted");
  SAMPLES[k] = { name: s.name, data: s.data };
}
const FLIGHT = JSON.parse(rd("metadata-reader_flight.json"));

// fonts: embedded as data URIs (SIL OFL 1.1, LICENSES/OFL-1.1_*.txt), so the page loads nothing from other servers.
// Faces are read from fonts/viz-fonts.css (the website's self-hosted set); variable fonts served once for several weights become one face with a weight range.
const FONTS_CSS = (() => {
  const css = rd("fonts/viz-fonts.css"), faces = new Map();
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const g = k => (m[1].match(new RegExp(k + ":\\s*([^;]+);")) || [])[1];
    const fam = g("font-family"), style = g("font-style"), w = +g("font-weight"), file = (g("src").match(/url\(\.\.\/fonts\/viz\/([^)]+)\)/) || [])[1], ur = g("unicode-range");
    if (!fam || !file || !ur) throw new Error("font face not understood");
    const data = fs.readFileSync(path.join(D, "fonts", file)), h = require("crypto").createHash("sha256").update(data).digest("hex"), k = fam + "|" + style + "|" + h;
    if (!faces.has(k)) faces.set(k, { fam, style, ws: [], data, ur }); faces.get(k).ws.push(w);
  }
  return "<style>\n/* fonts: Atkinson Hyperlegible, Familjen Grotesk, JetBrains Mono (SIL Open Font License 1.1), embedded */\n" + [...faces.values()].map(f => "@font-face{font-family:" + f.fam + ";font-style:" + f.style + ";font-weight:" + (Math.min(...f.ws) === Math.max(...f.ws) ? f.ws[0] : Math.min(...f.ws) + " " + Math.max(...f.ws)) + ";font-display:swap;src:url(data:font/woff2;base64," + f.data.toString("base64") + ") format(\"woff2\");unicode-range:" + f.ur + "}").join("\n") + "\n</style>";
})();
if (p1.split("<!--OSL-FONTS-->").length !== 2) throw new Error("font marker missing in p1");

// texts for the static (pre-rendered) version of the page
const T = new Function(tx + "\nreturn T;")();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// tool version: tool eyebrow and lead, a line with related links, no tasks
const TASKS_HTML = '<h2 class="tasks-h" data-i="tasksH"></h2>\n<section id="tasks" class="tasks"></section>\n';
if (p1.split(TASKS_HTML).length !== 2 || !/data-i="eyebrow"/.test(p1) || !/<p class="lead" data-i="lead"><\/p>/.test(p1)) throw new Error("p1 markers for the tool version missing");
const p1tool = p1.replace(TASKS_HTML, "").replace('data-i="eyebrow"', 'data-i="eyebrowTool"')
  .replace('<p class="lead" data-i="lead"></p>', '<p class="lead" data-i="leadTool"></p>\n    <p class="note" style="margin-top:8px" data-i="toolMeta"></p>');

// tool version: English only (no language switch, no Czech texts, no teaching tasks) and no embedded samples
const LANG_BLOCK = /\n  <div class="lang" role="group"[^]*?<\/div>\n/, SAMPLES_BLOCK = /\n    <div class="ctl">\n      <span class="small" style="font-weight:700" data-i="samplesH"><\/span>[^]*?data-i="samplesNote"><\/p>\n    <\/div>\n/;
const LANG_DETECT = /let L = \/\^\(cs\|sk\)[^\n]*\n(?:[^\n]*\n){3}/;
if (!LANG_BLOCK.test(p1tool) || !SAMPLES_BLOCK.test(p1tool) || !LANG_DETECT.test(ui)) throw new Error("tool-version markers missing");
const p1toolEn = p1tool.replace(LANG_BLOCK, "\n").replace(SAMPLES_BLOCK, "\n").replace(/<title>[^<]*<\/title>/, "<title>" + T.en.title + "</title>").replace('<html lang="cs"', '<html lang="en"');
const SETLANG = /function setLang\(l\) \{[^\n]*\n/;
if (!SETLANG.test(ui)) throw new Error("setLang marker missing");
const uiToolEn = ui.replace(LANG_DETECT, 'let L = "en"; // tool version: English only\n').replace(SETLANG, "function setLang() { /* English only */ }\n");
// texts: evaluated here, written back with the English set only (functions kept as source); T.cs points to it for fallbacks
function ser(v) {
  if (typeof v === "function") { const f = v.toString(); return /^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(f) ? f : "function " + f; }
  if (Array.isArray(v)) return "[" + v.map(ser).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).map(k => JSON.stringify(k) + ":" + ser(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const toolFoot = f => f.replace(" The samples are synthetic and for teaching only.", "").replace(" Sample 6 carries a deliberately unsigned manifest.", ""); // no samples in the tool version
const txToolEn = (() => { const pre = tx.slice(0, tx.indexOf("const T = {")); const en = Object.assign({}, T.en); delete en.tasks; en.batchEmpty = "The batch view needs at least two files. Choose several images from one flight.";
  // no samples in the tool version: their texts go too
  en.footer = toolFoot(en.footer); en.noFile = "Load an image.";
  for (const k of Object.keys(en)) if (/^(samplesH|samplesNote|smp_|smpT_|smpFlight)/.test(k)) delete en[k];
  return pre + "const T = { en: " + ser(en) + " };\nT.cs = T.en;"; })();
function page(p1, tool) {
const SL_ = tool ? "en" : SL;
let html = p1.replace("<!--OSL-FONTS-->", () => FONTS_CSS).replace(/(<(\w+)\b[^>]*\bdata-i="(\w+)"[^>]*>)([\s\S]*?)(<\/\2>)/g, (m, open, tag, k, inner, close) => {
  const v = T[SL_][k]; if (typeof v !== "string") throw new Error("missing text " + k); return open + v + close;
});
html = html.replace(/(\bdata-ia="(\w+)")/g, (m, a, k) => a + ' aria-label="' + esc(T[SL_][k]) + '"');
const tasks = T[SL_].tasks.map((x, i) => '<article class="task"><h3>' + (i + 1) + " · " + esc(x[0]) + "</h3><p>" + x[1] + "</p></article>").join("\n");
if (!tool) html = html.replace('<section id="tasks" class="tasks"></section>', '<section id="tasks" class="tasks">\n' + tasks + "\n</section>");
html = html.replace('<footer id="foot"></footer>', '<footer id="foot">' + (tool ? toolFoot(T[SL_].footer) : T[SL_].footer) + "</footer>");
if (tool === /<article class="task">|id="tasks"/.test(html) || !/<footer id="foot"><h2>/.test(html)) throw new Error("static tasks/footer not injected");

const script = "<script>\n(() => {\n\"use strict\";\nconst SAMPLES = " + JSON.stringify(tool ? {} : SAMPLES) + ";\nconst FLIGHT = " + JSON.stringify(tool ? {} : FLIGHT) + ";\n" +
  lib + "\n" + osl + "\n" + fl + "\n" + (tool ? txToolEn : tx) + "\n" + flui + "\n" + (tool ? uiToolEn : ui) + "\n})();\n</script>\n";
if (tool && (/id="lang-cs"|id="samples"|"sample1_|Čtečka metadat|"tasks":|sample flight|samples are synthetic|Sample 6|samplesNote|or a sample/.test(script + html))) throw new Error("tool version still has Czech texts, samples or tasks");
if (/<\/script/i.test(lib + osl + fl + tx + ui + flui)) throw new Error("</script inside script");
const out = html.replace(/\s+$/, "") + "\n" + script;

// the parser in the page must be byte-identical to the lib file
const a = out.indexOf("/*OSL-META-READER-START*/"), b = out.indexOf("/*OSL-META-READER-END*/") + "/*OSL-META-READER-END*/".length;
if (out.slice(a, b) !== lib.trim()) throw new Error("embedded parser differs from lib");
const ext = out.match(/(?:src|href)="(https?:[^"]+)"/g) || [];
const bad = ext.filter(x => !/^href=/.test(x)); // links the user clicks are fine; nothing may be loaded from another server
if (/fonts\.(googleapis|gstatic)\.com/.test(html)) throw new Error("web fonts must be embedded, not loaded from Google");
if (bad.length) throw new Error("external resource: " + bad.join(" "));
return out;
}
for (const [name, src, tool] of [["metadata-reader.html", p1, false], ["metadata-reader_tool.html", p1toolEn, true]]) {
  const out = page(src, tool);
  fs.writeFileSync(path.join(OUT, name), out);
  console.log("wrote", name, out.length, "bytes" + (tool ? "" : "; tasks " + T.cs.tasks.length + " / " + T.en.tasks.length));
}
