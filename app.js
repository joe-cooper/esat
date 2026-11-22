/* ESAT test builder: page logic. Needs builder.js and pdf-lib. */
(function () {
  "use strict";
  const E = window.ESAT, $ = id => document.getElementById(id);
  const subtle = window.crypto && window.crypto.subtle;
  const S = { m: null, key: null, cache: new Map(), sel: [], pool: [], used: loadUsed(),
    browse: [], shown: 0, view: null, viewToken: 0 };
  const STORE_PW = "esat_pw", STORE_USED = "esat_used";
  const MAX_Q = 60, PAGE_ROWS = 40;
  // pdf.js renders the cropped question PDFs for previews; loaded on first use only
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";

  // ------------------------------------------------------------ storage (may be unavailable)
  function loadUsed() {
    try { return new Set(JSON.parse(localStorage.getItem(STORE_USED) || "[]")); } catch (e) { return new Set(); }
  }
  function saveUsed() { try { localStorage.setItem(STORE_USED, JSON.stringify([...S.used])); } catch (e) { } }
  function getPw() { try { return sessionStorage.getItem(STORE_PW) || localStorage.getItem(STORE_PW); } catch (e) { return null; } }
  function setPw(pw, remember) {
    try { sessionStorage.setItem(STORE_PW, pw); if (remember) localStorage.setItem(STORE_PW, pw); } catch (e) { }
  }

  // ------------------------------------------------------------ start
  async function init() {
    try {
      const r = await fetch("questions.json", { cache: "no-cache" });
      S.m = await r.json();
    } catch (e) {
      document.body.insertAdjacentHTML("beforeend", '<p class="card" style="margin:30px">Could not load questions.json.</p>');
      return;
    }
    $("gen").textContent = `${S.m.questions.length} questions, updated ${S.m.generated}`;
    if (S.m.encrypted) {
      if (!subtle) { $("lock").classList.remove("hidden"); $("lockStatus").textContent = "This page must be opened over https."; return; }
      const saved = getPw();
      if (saved && await unlock(saved)) return start();
      $("lock").classList.remove("hidden");
      $("lockForm").addEventListener("submit", async ev => {
        ev.preventDefault();
        $("lockStatus").textContent = "Checking…";
        const pw = $("pw").value;
        if (await unlock(pw)) { setPw(pw, $("remember").checked); $("lock").classList.add("hidden"); start(); }
        else $("lockStatus").textContent = "That password didn't work.";
      });
    } else start();
  }

  async function unlock(pw) {
    try {
      const k = await E.deriveKey(pw, S.m.crypto, subtle);
      if (await E.checkKey(k, S.m.crypto, subtle)) { S.key = k; return true; }
    } catch (e) { }
    return false;
  }

  // ------------------------------------------------------------ filter UI
  function chip(container, value, label, checked) {
    const l = document.createElement("label"); l.className = "chip";
    l.innerHTML = `<input type="checkbox" value="${value}" ${checked ? "checked" : ""}><span></span>`;
    l.querySelector("span").textContent = label;
    container.appendChild(l);
  }
  const checked = id => [...$(id).querySelectorAll("input:checked")].map(i => i.value);

  function start() {
    $("app").classList.remove("hidden");
    const Q = S.m.questions;
    const short = { "Mathematics 1": "Maths 1", "Mathematics 2": "Maths 2" };
    E.MODULES.forEach(m => chip($("modules"), m, short[m] || m, m === "Chemistry"));
    [["S1", "Section 1 style"], ["S2", "Section 2 (harder)"]].forEach(([v, l]) => chip($("sections"), v, l, true));
    ["NSAA", "ENGAA"].forEach(p => chip($("papers"), p, p, true));
    [["Yes", "Yes"], ["Partly", "Partly"], ["No", "No"]].forEach(([v, l]) => chip($("inspec"), v, l, v !== "No"));
    E.QTYPES.forEach(t => {
      const l = document.createElement("label");
      l.innerHTML = `<input type="checkbox" value="${t}"> `; l.append(t); $("types").appendChild(l);
    });
    for (let d = 1; d <= 5; d++) { $("dmin").add(new Option(d, d)); $("dmax").add(new Option(d, d)); }
    $("dmax").value = 5;
    const years = [...new Set(Q.map(q => +q.year))].sort();
    years.forEach(y => { $("ymin").add(new Option(y, y)); $("ymax").add(new Option(y, y)); });
    $("ymax").value = years[years.length - 1];

    renderTopics();
    document.querySelectorAll("#app input, #app select").forEach(el => el.addEventListener("change", onFilter));
    ["specs", "search"].forEach(id => $(id).addEventListener("input", onFilter));
    $("modules").addEventListener("change", renderTopics);
    $("pickBtn").onclick = () => pickAll();
    $("fillBtn").onclick = () => fillRest();
    $("n").addEventListener("input", updateFillBtn);
    $("addBtn").onclick = () => addOne();
    $("clearBtn").onclick = () => clearAll();
    $("testBtn").onclick = () => makeTest("download");
    $("previewBtn").onclick = () => makeTest("preview");
    $("keyBtn").onclick = () => makeKey();
    $("clearUsed").onclick = () => { S.used.clear(); saveUsed(); onFilter(); status(`History cleared.`); };
    ["order"].forEach(id => $(id).addEventListener("change", () => { S.sel = E.sortSelection(S.sel, $("order").value); renderSel(); }));
    $("browseBtn").onclick = () => {
      const open = $("browse").classList.toggle("hidden") === false;
      $("browseBtn").setAttribute("aria-expanded", open);
      $("browseBtn").textContent = open ? "Hide list" : "Browse and choose";
      if (open) renderBrowse();
    };
    $("moreBtn").onclick = () => { S.shown += PAGE_ROWS; renderBrowse(); };
    $("browseScroll").addEventListener("scroll", () => {      // load more rows as the list nears its end
      const el = $("browseScroll");
      if (S.shown < S.browse.length && el.scrollTop + el.clientHeight > el.scrollHeight - 80) { S.shown += PAGE_ROWS; renderBrowse(); }
    }, { passive: true });
    initViewer();
    onFilter();
  }

  function renderTopics() {
    const mods = checked("modules");
    const prev = new Set(checked("topics"));
    const counts = new Map();
    S.m.questions.forEach(q => {
      if (mods.length && !mods.includes(q.esat_module)) return;
      const k = q.esat_module + "|" + q.spec_topic;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const box = $("topics"); box.innerHTML = "";
    const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    E.MODULES.forEach(m => {
      const ts = [...counts.keys()].filter(k => k.startsWith(m + "|")).map(k => k.split("|")[1]).sort(nat);
      if (!ts.length) return;
      if (mods.length !== 1) box.insertAdjacentHTML("beforeend", `<div class="mod">${m}</div>`);
      ts.forEach(t => {
        const code = t.split(" ")[0];
        const l = document.createElement("label");
        l.innerHTML = `<input type="checkbox" value="${code}" ${prev.has(code) ? "checked" : ""}>`;
        l.append(t); l.insertAdjacentHTML("beforeend", `<small>${counts.get(m + "|" + t)}</small>`);
        l.querySelector("input").addEventListener("change", onFilter);
        box.appendChild(l);
      });
    });
    onFilter();
  }

  function filters() {
    let dmin = +$("dmin").value, dmax = +$("dmax").value; if (dmin > dmax) [dmin, dmax] = [dmax, dmin];
    let ymin = +$("ymin").value, ymax = +$("ymax").value; if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
    return {
      modules: checked("modules"), topics: checked("topics"),
      specs: $("specs").value.split(/[\s,;]+/).filter(Boolean), primaryOnly: $("primaryOnly").checked,
      dmin, dmax, ymin, ymax, types: checked("types"), inSpec: checked("inspec"),
      sections: checked("sections"), papers: checked("papers"), search: $("search").value.trim(),
      avoidUsed: $("avoidUsed").checked,
    };
  }

  function onFilter() {
    if (!S.m) return;
    S.pool = E.filterQuestions(S.m.questions, filters(), S.used);
    $("poolCount").textContent = S.pool.length;
    $("pickBtn").disabled = !S.pool.length;
    $("browseBtn").disabled = !S.pool.length;
    S.browse = E.sortSelection(S.pool, "topic");
    S.shown = PAGE_ROWS;
    $("browseScroll").scrollTop = 0;
    renderBrowse();
    updateFillBtn();
  }

  // ------------------------------------------------------------ browse and choose by hand
  const inSel = q => S.sel.some(s => s.id === q.id);

  function toggleSel(q) {
    const i = S.sel.findIndex(s => s.id === q.id);
    if (i >= 0) S.sel.splice(i, 1);
    else {
      if (S.sel.length >= MAX_Q) return status(`A test can have at most ${MAX_Q} questions.`);
      S.sel = E.sortSelection(S.sel.concat([q]), $("order").value);
    }
    renderSel();
  }

  function renderBrowse() {
    const box = $("poolList");
    if ($("browse").classList.contains("hidden")) return;
    if (!S.browse.length) { box.innerHTML = '<div class="empty">No questions match these filters.</div>'; $("moreBtn").classList.add("hidden"); return; }
    const rows = S.browse.slice(0, S.shown);
    box.innerHTML = rows.map((q, i) => {
      const on = inSel(q);
      return `<div class="qrow${on ? " on" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="Preview: ${esc(q.topic)}">
        <button class="add" type="button" aria-pressed="${on}" title="${on ? "Remove from test" : "Add to test"}"
          aria-label="${on ? "Remove from test" : "Add to test"}">${on ? "✓" : "+"}</button>
        <div><b>${esc(q.spec_topic)}</b>${S.used.has(q.id) ? '<span class="tag">used</span>' : ""}<div class="t">${esc(q.topic)}</div></div>
        <span class="diff" title="difficulty">${q.difficulty}</span>
        <div class="t meta">${esc(q.q_type)}<br>${esc(q.source)}</div></div>`;
    }).join("");
    box.querySelectorAll(".qrow").forEach(row => {
      const i = +row.dataset.i;
      row.querySelector(".add").onclick = ev => { ev.stopPropagation(); toggleSel(S.browse[i]); };
      row.onclick = () => openViewer(S.browse, i);
      row.onkeydown = ev => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === row) { ev.preventDefault(); openViewer(S.browse, i); } };
    });
    const left = S.browse.length - rows.length;
    $("moreBtn").classList.toggle("hidden", left <= 0);
    $("moreBtn").textContent = `Show more (${left} left)`;
  }

  // ------------------------------------------------------------ question preview
  let pdfjsP = null;
  function loadPdfjs() {
    if (!pdfjsP) pdfjsP = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PDFJS + "pdf.min.js";
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; res(window.pdfjsLib); };
      s.onerror = () => { pdfjsP = null; s.remove(); rej(new Error("the PDF viewer could not be loaded")); };
      document.head.appendChild(s);
    });
    return pdfjsP;
  }

  let lastFocus = null;
  function initViewer() {
    const v = $("viewer");
    v.querySelectorAll("[data-close]").forEach(el => el.onclick = closeViewer);
    $("vPrev").onclick = () => stepViewer(-1);
    $("vNext").onclick = () => stepViewer(1);
    $("vToggle").onclick = () => { toggleSel(S.view.list[S.view.i]); updateViewerButtons(); };
    $("vAnswer").onclick = () => {
      $("vAns").textContent = "Answer: " + S.view.list[S.view.i].answer;
      $("vAns").classList.remove("hidden"); $("vAnswer").classList.add("hidden");
      $("vToggle").focus();
    };
    document.addEventListener("keydown", ev => {
      if (!S.view) return;
      if (ev.key === "Escape") closeViewer();
      else if (ev.key === "ArrowLeft") stepViewer(-1);
      else if (ev.key === "ArrowRight") stepViewer(1);
      else if (ev.key === "Tab") {          // keep focus inside the panel
        const f = [...v.querySelectorAll("button:not([disabled])")].filter(b => b.offsetParent);
        if (!f.length) return;
        if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
        else if (!ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    });
  }

  function openViewer(list, i) {
    if (!list.length) return;
    if (!S.view) lastFocus = document.activeElement;
    S.view = { list: list.slice(), i };
    $("viewer").classList.remove("hidden");
    document.body.classList.add("noscroll");
    showViewerQuestion();
    $("vClose").focus();
  }

  function closeViewer() {
    S.view = null; S.viewToken++;
    $("viewer").classList.add("hidden");
    document.body.classList.remove("noscroll");
    $("vBody").innerHTML = "";
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function stepViewer(d) {
    const j = S.view.i + d;
    if (j < 0 || j >= S.view.list.length) return;
    S.view.i = j;
    showViewerQuestion();
  }

  function updateViewerButtons() {
    if (!S.view) return;
    const q = S.view.list[S.view.i], on = inSel(q);
    $("vToggle").textContent = on ? "Remove from test" : "Add to test";
    $("vToggle").className = on ? "" : "primary";
    $("vPrev").disabled = S.view.i === 0;
    $("vNext").disabled = S.view.i === S.view.list.length - 1;
  }

  function showViewerQuestion() {
    const { list, i } = S.view, q = list[i];
    $("vPos").textContent = `${i + 1} of ${list.length}`;
    $("vTitle").textContent = q.spec_topic;
    $("vDesc").textContent = q.topic;
    const spec = q.spec_primary + (q.spec_secondary ? "; " + q.spec_secondary : "");
    $("vMeta").textContent = [`Difficulty ${q.difficulty}`, q.q_type, spec, q.source,
      q.in_esat_spec !== "Yes" ? `In ESAT spec: ${q.in_esat_spec}` : ""].filter(Boolean).join(" · ");
    $("vAns").classList.add("hidden"); $("vAnswer").classList.remove("hidden");
    updateViewerButtons();
    renderQuestion(q);
    const nxt = list[i + 1];                // fetch the next one in the background
    if (nxt) getBytes(nxt.file).catch(() => { });
  }

  async function renderQuestion(q) {
    const token = ++S.viewToken, box = $("vBody");
    box.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const [L, bytes] = await Promise.all([loadPdfjs(), getBytes(q.file)]);
      if (token !== S.viewToken) return;
      // pdf.js takes ownership of the buffer, so give it a copy (the cache is reused for the test PDF)
      const doc = await L.getDocument({ data: bytes.slice(), standardFontDataUrl: PDFJS + "standard_fonts/",
        cMapUrl: PDFJS + "cmaps/", cMapPacked: true }).promise;
      const avail = box.clientWidth - 2 * parseFloat(getComputedStyle(box).paddingLeft), dpr = window.devicePixelRatio || 1;
      const canvases = [], jobs = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const css = Math.min(avail / base.width, 1.5);
        const vp = page.getViewport({ scale: css * dpr });
        const c = document.createElement("canvas");
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        c.style.width = Math.floor(base.width * css) + "px";
        c.setAttribute("aria-label", "Question image");
        jobs.push(page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise);
        canvases.push(c);
      }
      await Promise.all(jobs);
      doc.destroy();
      if (token !== S.viewToken) return;
      box.innerHTML = ""; canvases.forEach(c => box.appendChild(c));
      box.scrollTop = 0;
    } catch (e) {
      console.error(e);
      if (token === S.viewToken) box.innerHTML = `<div class="empty">Couldn't show this question: ${esc(e.message)}.</div>`;
    }
  }

  // ------------------------------------------------------------ selection
  function pickAll() {
    const n = Math.max(1, Math.min(60, +$("n").value || 10));
    S.sel = E.sortSelection(E.pickQuestions(S.pool, n, $("spread").checked), $("order").value);
    renderSel();
    status(S.sel.length < n ? `Only ${S.sel.length} questions match these filters.` : "");
  }

  const target = () => Math.max(1, Math.min(MAX_Q, +$("n").value || 10));

  function fillRest() {
    const n = target(), need = n - S.sel.length;
    if (need <= 0) return;
    const add = E.pickQuestions(spare(), need, $("spread").checked, undefined, S.sel);
    S.sel = E.sortSelection(S.sel.concat(add), $("order").value);
    renderSel();
    status(add.length < need ? `Only ${add.length} more questions match these filters.` : `Added ${add.length} at random.`);
  }

  function updateFillBtn() {
    const n = target(), need = n - S.sel.length, b = $("fillBtn");
    b.classList.toggle("hidden", !S.sel.length || need <= 0);
    b.textContent = `Fill to ${n} at random`;
    b.disabled = !spare().length;
  }

  function clearAll() {
    const before = S.sel;
    if (!before.length) return;
    S.sel = []; renderSel();
    $("status").className = "status";
    $("status").innerHTML = `Cleared ${before.length} question${before.length === 1 ? "" : "s"}. <button class="linkish" type="button">Undo</button>`;
    const undo = $("status").querySelector("button");
    undo.onclick = () => { S.sel = before; renderSel(); status("Restored."); };
    undo.focus();
  }

  function spare() { const ids = new Set(S.sel.map(q => q.id)); return S.pool.filter(q => !ids.has(q.id)); }

  function addOne() {
    const s = spare(); if (!s.length) return status("No more matching questions.");
    S.sel.push(s[Math.floor(Math.random() * s.length)]); S.sel = E.sortSelection(S.sel, $("order").value); renderSel();
  }

  function swap(i) {
    const cur = S.sel[i], s = spare(); if (!s.length) return status("No other matching questions.");
    const same = s.filter(q => q.code === cur.code), from = same.length ? same : s;
    S.sel[i] = from[Math.floor(Math.random() * from.length)]; renderSel();
  }

  function renderSel() {
    const box = $("selection");
    const has = S.sel.length > 0;
    ["addBtn", "testBtn", "keyBtn", "previewBtn", "clearBtn"].forEach(id => $(id).disabled = !has);
    $("minutes").textContent = has ? `· ${S.sel.length} questions · about ${E.minutesFor(S.sel, S.m.minutes)} min` : "";
    renderBrowse();
    updateViewerButtons();
    updateFillBtn();
    if (!has) { box.innerHTML = '<div class="empty">No questions chosen.</div>'; return; }
    const rows = S.sel.map((q, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(q.spec_topic)}</b><div class="t">${esc(q.topic)}</div></td>
      <td><span class="diff" title="difficulty">${q.difficulty}</span></td>
      <td class="t srccol">${esc(q.q_type)}<br>${esc(q.source)}</td>
      <td class="acts"><button class="small" data-view="${i}" title="Preview this question">view</button>
        <button class="small" data-swap="${i}" title="Replace with another question">swap</button>
        <button class="small" data-del="${i}" title="Remove">✕</button></td></tr>`).join("");
    box.innerHTML = `<table><thead><tr><th>#</th><th>Topic</th><th>Diff</th><th class="srccol">Type / source</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    box.querySelectorAll("[data-view]").forEach(b => b.onclick = () => openViewer(S.sel, +b.dataset.view));
    box.querySelectorAll("[data-swap]").forEach(b => b.onclick = () => swap(+b.dataset.swap));
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { S.sel.splice(+b.dataset.del, 1); renderSel(); });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function status(msg, err) { $("status").textContent = msg || ""; $("status").className = "status" + (err ? " err" : ""); }

  // ------------------------------------------------------------ PDFs
  async function getBytes(file) {
    if (S.cache.has(file)) return S.cache.get(file);
    const r = await fetch(file);
    if (!r.ok) throw new Error(`Could not load ${file}`);
    let b = new Uint8Array(await r.arrayBuffer());
    if (S.m.encrypted) b = await E.decrypt(S.key, b, subtle);
    S.cache.set(file, b);
    return b;
  }

  function titleText() { return $("title").value.trim() || "ESAT practice"; }
  function subtitleText() {
    const f = filters(), bits = [];
    if (f.modules.length) bits.push(f.modules.join(", "));
    if (f.topics.length) {
      const names = new Map(S.m.questions.map(q => [q.code, q.spec_topic]));
      bits.push("Topics: " + f.topics.map(c => names.get(c) || c).join(", "));
    }
    if (f.dmin > 1 || f.dmax < 5) bits.push(`difficulty ${f.dmin}-${f.dmax}`);
    return bits.join(" · ");
  }

  function save(bytes, name, preview) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    if (preview) { window.open(url, "_blank"); return; }
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const fname = (suffix) => titleText().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") + suffix + ".pdf";

  async function makeTest(mode) {
    if (!S.sel.length) return;
    try {
      status("Building…");
      const items = [];
      for (const q of S.sel) items.push({ q, bytes: await getBytes(q.file) });
      const chem = S.sel.some(q => q.esat_module === "Chemistry");
      const periodicBytes = chem && $("periodic").checked && S.m.periodic_table ? await getBytes(S.m.periodic_table) : null;
      const bytes = await E.buildTest(PDFLib, items, {
        title: titleText(), subtitle: subtitleText(), minutes: E.minutesFor(S.sel, S.m.minutes),
        renumber: true, showSource: $("showSource").checked, onePerPage: $("onePerPage").checked, periodicBytes,
      });
      save(bytes, fname(""), mode === "preview");
      if (mode !== "preview") { S.sel.forEach(q => S.used.add(q.id)); saveUsed(); }
      status(mode === "preview" ? "Preview opened in a new tab." : "Test downloaded.");
    } catch (e) { console.error(e); status("Something went wrong: " + e.message, true); }
  }

  async function makeKey() {
    try {
      const bytes = await E.buildKey(PDFLib, S.sel, { title: titleText(), subtitle: subtitleText() });
      save(bytes, fname("_ANSWERS"));
      status("Answer key downloaded.");
    } catch (e) { console.error(e); status("Something went wrong: " + e.message, true); }
  }

  init();
})();
