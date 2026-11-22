/* ESAT test builder: selection and PDF assembly (no DOM code here).
   Works in the browser (window.ESAT) and in Node (module.exports). */
(function (root) {
  "use strict";

  const PAGE_W = 595.28, PAGE_H = 841.89;
  const MARGIN_T = 56, MARGIN_B = 48, GAP = 22, SOURCE_H = 11;
  const MODULES = ["Mathematics 1", "Mathematics 2", "Physics", "Chemistry", "Biology"];
  const QTYPES = ["Calculation", "Algebraic manipulation", "Knowledge recall", "Conceptual reasoning",
    "Data/graph interpretation", "Unfamiliar-context comprehension", "Multi-step problem solving"];

  // ---------------------------------------------------------------- crypto
  function b64(s) {
    const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(password, meta, subtle) {
    const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt: b64(meta.salt), iterations: meta.iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  async function decrypt(key, bytes, subtle) {
    const iv = bytes.slice(0, 12), ct = bytes.slice(12);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  }

  async function checkKey(key, meta, subtle) {
    try {
      const out = await decrypt(key, b64(meta.check), subtle);
      return new TextDecoder().decode(out) === "esat-ok";
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- selection
  function specMatch(q, specs, primaryOnly) {
    const prim = [q.spec_primary.toUpperCase()];
    const sec = q.spec_secondary.split(";").map(s => s.trim().toUpperCase()).filter(Boolean);
    const pool = primaryOnly ? prim : prim.concat(sec);
    return specs.some(s => pool.some(p => p === s || p.startsWith(s + ".")));
  }

  function filterQuestions(questions, f, used) {
    const specs = (f.specs || []).map(s => s.toUpperCase());
    let re = null;
    if (f.search) { try { re = new RegExp(f.search, "i"); } catch (e) { re = null; } }
    return questions.filter(q => {
      const d = +q.difficulty, y = +q.year;
      if (f.modules && f.modules.length && !f.modules.includes(q.esat_module)) return false;
      if (f.topics && f.topics.length && !f.topics.includes(q.code)) return false;
      if (specs.length && !specMatch(q, specs, f.primaryOnly)) return false;
      if (d < f.dmin || d > f.dmax) return false;
      if (y < f.ymin || y > f.ymax) return false;
      if (f.types && f.types.length && !f.types.includes(q.q_type)) return false;
      if (f.inSpec && !f.inSpec.includes(q.in_esat_spec)) return false;
      if (f.sections && f.sections.length && !f.sections.includes(q.section.split("-")[0])) return false;
      if (f.papers && f.papers.length && !q.papers.some(p => f.papers.includes(p))) return false;
      if (re && !re.test(q.topic)) return false;
      if (f.avoidUsed && used && used.has(q.id)) return false;
      return true;
    });
  }

  function shuffle(a, rnd) {
    rnd = rnd || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));[a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* already: questions chosen by hand; with spread, topics they cover are used last */
  function pickQuestions(pool, n, spread, rnd, already) {
    const p = shuffle(pool.slice(), rnd);
    if (!spread) return p.slice(0, n);
    const groups = new Map(), have = new Map();
    (already || []).forEach(q => have.set(q.code, (have.get(q.code) || 0) + 1));
    p.forEach(q => { if (!groups.has(q.code)) groups.set(q.code, []); groups.get(q.code).push(q); });
    const keys = shuffle([...groups.keys()], rnd).sort((a, b) => (have.get(a) || 0) - (have.get(b) || 0)), out = [];
    while (out.length < n && keys.some(k => groups.get(k).length)) {
      for (const k of keys) { const g = groups.get(k); if (g.length && out.length < n) out.push(g.pop()); }
    }
    return out;
  }

  function sortSelection(sel, order) {
    const s = sel.slice();
    if (order === "difficulty") s.sort((a, b) => (a.difficulty - b.difficulty) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    else if (order === "topic") s.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || (a.difficulty - b.difficulty));
    return s;
  }

  function minutesFor(sel, table) {
    return Math.round(sel.reduce((t, q) => t + ((table && table[q.section]) || 1.5), 0));
  }

  // ---------------------------------------------------------------- PDF helpers
  function clean(s) {
    return String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "?");
  }

  function wrap(text, font, size, width) {
    const words = clean(text).split(/\s+/).filter(Boolean), lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= width) cur = t;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  function txt(page, s, x, yTop, size, font, color) {
    page.drawText(clean(s), { x, y: PAGE_H - yTop, size, font, color });
  }

  // ---------------------------------------------------------------- the test
  /* items: [{q, bytes}] in order; opts: {title, subtitle, minutes, renumber, showSource,
     onePerPage, periodicBytes} ; returns Uint8Array */
  async function buildTest(PDFLib, items, opts) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle(clean(opts.title));
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const grey = rgb(0.35, 0.35, 0.35);

    // cover
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = 120;
    for (const ln of wrap(opts.title, bold, 22, PAGE_W - 120)) { txt(page, ln, 60, y, 22, bold); y += 28; }
    y += 6;
    for (const ln of wrap(opts.subtitle || "", helv, 11, PAGE_W - 120)) { txt(page, ln, 60, y, 11, helv, grey); y += 15; }
    y += 20;
    for (const t of [`Questions: ${items.length}`, `Suggested time: ${opts.minutes} minutes`,
      "Calculators are not permitted.",
      "Choose one answer for each question and write its letter in the grid below."]) {
      txt(page, t, 60, y, 12, helv); y += 20;
    }
    y += 20; txt(page, "Name ________________________________", 60, y, 12, helv); y += 40;
    const cols = 5, bw = 92, bh = 28;
    for (let i = 0; i < items.length; i++) {
      const c = i % cols, r = Math.floor(i / cols), x0 = 60 + c * (bw + 4), y0 = y + r * (bh + 4);
      if (y0 + bh > PAGE_H - 70) break;
      page.drawRectangle({ x: x0, y: PAGE_H - y0 - bh, width: bw, height: bh, borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 0.6 });
      txt(page, String(i + 1), x0 + 6, y0 + 18, 11, bold);
    }
    txt(page, "Questions are taken from past NSAA and ENGAA papers (c) Cambridge University Press & Assessment, for practice use.",
      60, PAGE_H - 40, 8, helv, rgb(0.45, 0.45, 0.45));

    // questions
    let pageNo = 1, cur = null;
    const usableW = PAGE_W - 48, full = PAGE_H - MARGIN_T - MARGIN_B;
    const newPage = () => {
      cur = doc.addPage([PAGE_W, PAGE_H]); pageNo++;
      txt(cur, opts.title, 40, 30, 9, helv, grey);
      txt(cur, `Page ${pageNo}`, PAGE_W - 70, PAGE_H - 22, 9, helv, grey);
      cur.drawLine({ start: { x: 40, y: PAGE_H - 36 }, end: { x: PAGE_W - 40, y: PAGE_H - 36 }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
      y = MARGIN_T;
    };

    for (let idx = 0; idx < items.length; idx++) {
      const { q, bytes } = items[idx];
      const embedded = await doc.embedPdf(bytes, q.segs.map((_, i) => i));
      const scaled = embedded.map((e, i) => {
        const [w, h] = q.segs[i]; const s = Math.min(1, usableW / w);
        return { e, w, h, s, hs: h * s };
      });
      const labelH = opts.showSource ? SOURCE_H : 0;      // own strip above the question
      const total = scaled.reduce((t, x) => t + x.hs, 0) + labelH;
      const room = PAGE_H - MARGIN_B - (cur ? y : 0);
      if (!cur || opts.onePerPage || (total > room && (total <= full || room < 0.35 * full))) newPage();
      scaled.forEach((seg, j) => {
        let { s, hs } = seg;
        const extra = j === 0 ? labelH : 0;
        if (y + extra + hs > PAGE_H - MARGIN_B) {
          if (extra + hs > full) { s = s * (full - extra) / hs; hs = full - extra; }
          newPage();
        }
        if (extra) {
          const label = clean(q.source), tw = helv.widthOfTextAtSize(label, 7.5);
          txt(cur, label, PAGE_W - 30 - tw, y + 8, 7.5, helv, rgb(0.5, 0.5, 0.5));
          y += extra;
        }
        const xl = (PAGE_W - seg.w * s) / 2;
        cur.drawPage(seg.e, { x: xl, y: PAGE_H - y - hs, width: seg.w * s, height: hs });
        if (j === 0) {
          const [nx0, ny0, nx1, ny1] = q.num;
          const mx0 = xl + nx0 * s, my0 = y + ny0 * s, mx1 = xl + nx1 * s, my1 = y + ny1 * s;
          const mh = my1 - my0;
          if (opts.renumber) {
            cur.drawRectangle({ x: mx0 - 2, y: PAGE_H - my1 - 1, width: (mx1 - mx0) + 5, height: mh + 2, color: rgb(1, 1, 1) });
            const size = Math.max(9, Math.min(12, mh * 0.85));
            txt(cur, String(idx + 1), mx0, my1 - mh * 0.2, size, bold);
          }
        }
        y += hs;
      });
      y += GAP;
    }

    if (opts.periodicBytes) {
      const pt = await PDFDocument.load(opts.periodicBytes);
      const [p] = await doc.copyPages(pt, [0]);
      doc.addPage(p);
    }
    return doc.save();
  }

  // ---------------------------------------------------------------- answer key
  async function buildKey(PDFLib, questions, opts) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle(clean("Answers - " + opts.title));
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const cols = [["Q", 26], ["Ans", 30], ["Source", 120], ["Topic", 175], ["Spec", 62], ["Type", 70], ["Diff", 28]];
    const x0 = 32;
    let page, y;
    const newPage = (first) => {
      page = doc.addPage([PAGE_W, PAGE_H]); y = 50;
      if (first) {
        for (const ln of wrap("Answer key: " + opts.title, bold, 15, PAGE_W - 64)) { txt(page, ln, x0, y, 15, bold); y += 18; }
        for (const ln of wrap(opts.subtitle || "", helv, 9, PAGE_W - 64)) { txt(page, ln, x0, y, 9, helv, rgb(0.35, 0.35, 0.35)); y += 12; }
        y += 12;
      }
      let x = x0;
      for (const [n, w] of cols) { txt(page, n, x, y, 8.5, bold); x += w; }
      page.drawLine({ start: { x: x0, y: PAGE_H - y - 4 }, end: { x: PAGE_W - x0, y: PAGE_H - y - 4 }, thickness: 0.6 });
      y += 16;
    };
    newPage(true);
    questions.forEach((q, i) => {
      const spec = q.spec_primary + (q.spec_secondary ? "; " + q.spec_secondary : "");
      const cells = [String(i + 1), q.answer, q.source, q.topic, spec, q.q_type, String(q.difficulty)];
      const wrapped = cells.map((c, k) => wrap(c, k === 1 ? bold : helv, k === 1 ? 10 : 8, cols[k][1] - 6));
      const h = Math.max(...wrapped.map(w => w.length)) * 10 + 6;
      if (y + h > PAGE_H - 40) newPage(false);
      let x = x0;
      wrapped.forEach((lines, k) => {
        lines.forEach((ln, j) => txt(page, ln, x, y + j * 10, k === 1 ? 10 : 8, k <= 1 ? bold : helv));
        x += cols[k][1];
      });
      page.drawLine({ start: { x: x0, y: PAGE_H - (y + h - 8) }, end: { x: PAGE_W - x0, y: PAGE_H - (y + h - 8) }, thickness: 0.4, color: rgb(0.85, 0.85, 0.85) });
      y += h;
    });
    if (y < PAGE_H - 60) txt(page, "Difficulty: 1 (easy) to 5 (hardest).  Spec: ESAT Content Specification (April 2025) codes, main point first.",
      x0, y + 10, 7.5, helv, rgb(0.4, 0.4, 0.4));
    return doc.save();
  }

  const api = { MODULES, QTYPES, deriveKey, decrypt, checkKey, filterQuestions, pickQuestions,
    sortSelection, minutesFor, buildTest, buildKey, clean };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ESAT = api;
})(typeof window !== "undefined" ? window : globalThis);
