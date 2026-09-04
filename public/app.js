// Browser UI wiring for curl-runner. All pure logic (tokenizing, curl parsing,
// JWT, CSV, substitution) lives in lib.js, shared with the server.
import {
  tokenizeSpans, DATA_FLAGS,
  looksLikeJwt, decodeJwt, fmtExpiry, expiryParts,
  csvToObjects, reqToCurl,
  matchesFilter, filterBuckets,
} from "./lib.js";

const $ = (id) => document.getElementById(id);
let controller = null;

// Grow a textarea to fit its content (CSS max-height caps it, then it scrolls).
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
// Live-resize the two input boxes as you type or paste.
["curl", "vars"].forEach((id) => {
  const el = $(id);
  el.addEventListener("input", () => autoGrow(el));
});

function setRunning(running) {
  $("start").disabled = running;
  $("stop").disabled = !running;
}

function addRun({ run, status, ok, ms, method, url, body, error, reqHeaders, reqBody }) {
  const div = document.createElement("div");
  div.className = "run " + (ok ? "ok" : "err");
  // Tag the row for the output filter. A network error carries no status code
  // (the server sends 0), so it lands in the ERR bucket instead.
  div.dataset.status = status === 0 ? "ERR" : String(status);
  const codeClass = ok ? "ok" : "err";
  const display = error ? `ERR ${error}` : status;
  div.innerHTML =
    `<div class="meta">#${run} <span class="code ${codeClass}">${display}</span> ` +
    `· ${ms}ms · ${method} ${escapeHtml(url)}</div>`;
  // Pretty view (default).
  if (body) {
    const pre = document.createElement("pre");
    pre.className = "pretty";
    pre.textContent = pretty(body);
    div.appendChild(pre);
  }
  // Raw view (shown when the "raw" toggle is on): exact request + raw response.
  const raw = document.createElement("pre");
  raw.className = "raw";
  raw.textContent =
    `# request\n${reqToCurl(method, url, reqHeaders, reqBody)}\n\n` +
    `# response (raw)\n${error ? "ERR " + error : (body || "")}`;
  div.appendChild(raw);

  const out = $("output");
  out.appendChild(div);
  // Honour the active filter for the row we just added, and keep the dropdown's
  // counts and the "nothing matches" note in step as the run streams in.
  paneResults.push({ status: statusOf(div) });
  applyFilterTo(div);
  if (!div.hidden) shownCount++;
  updateEmptyNote();
  refreshFilterOptions();
  out.scrollTop = out.scrollHeight;
}

function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function note(msg, isError) {
  const div = document.createElement("div");
  div.className = "run" + (isError ? " err" : "");
  div.innerHTML = `<div class="meta">${escapeHtml(msg)}</div>`;
  $("output").appendChild(div);
}

// --- output filtering -----------------------------------------------------
// The filter narrows what the output pane shows. Its counts describe what's in
// the pane, which `clear` can empty independently of `runResults` (kept for the
// CSV export), so the tally lives here rather than being derived from that.
let paneResults = [];

// The numeric status a rendered row represents (0 for the ERR bucket).
const statusOf = (el) => (el.dataset.status === "ERR" ? 0 : Number(el.dataset.status));

function applyFilterTo(el) {
  el.hidden = !matchesFilter(statusOf(el), $("filter").value);
}

// How many result rows the active filter is currently showing. Tracked rather
// than recounted so a streaming run stays O(1) per result.
let shownCount = 0;

// Say so rather than going blank — e.g. still filtered to "failed" on a run
// where nothing failed. Sits where the rows would have been, so the run header
// above it and the summary that follows still frame it.
function updateEmptyNote() {
  $("emptyFilter")?.remove();
  if (!paneResults.length || shownCount) return;
  const div = document.createElement("div");
  div.id = "emptyFilter";
  div.textContent = `no results match "${$("filter").value}"`;
  $("output").appendChild(div);
}

// Re-apply the filter across the whole pane. Only result rows carry a
// data-status, so notes, warnings, the run header and dry-run previews always
// stay visible — that's the context you want while looking at failures.
function applyFilter() {
  shownCount = 0;
  $("output").querySelectorAll(".run[data-status]").forEach((el) => {
    applyFilterTo(el);
    if (!el.hidden) shownCount++;
  });
  $("filter").classList.toggle("on", $("filter").value !== "all");
  updateEmptyNote();
}

// Sync the dropdown with the buckets currently in the pane. When the set of
// buckets is unchanged we only retitle the existing options, so a dropdown the
// user has open mid-run doesn't collapse under them.
function refreshFilterOptions() {
  const sel = $("filter");
  const buckets = filterBuckets(paneResults, sel.value);
  const opts = [...sel.querySelectorAll("option")];
  if (opts.length === buckets.length && opts.every((o, i) => o.value === buckets[i].value)) {
    opts.forEach((o, i) => { o.textContent = buckets[i].label; });
    return;
  }

  const wanted = sel.value;
  sel.textContent = "";
  let group, holder = sel;
  for (const b of buckets) {
    if (b.group !== group) {
      group = b.group;
      holder = sel;
      if (group) {
        holder = document.createElement("optgroup");
        holder.label = group;
        sel.appendChild(holder);
      }
    }
    const opt = document.createElement("option");
    opt.value = b.value;
    opt.textContent = b.label;
    holder.appendChild(opt);
  }
  // Keep the selection if its bucket survived, otherwise fall back to all.
  sel.value = buckets.some((b) => b.value === wanted) ? wanted : "all";
}

// Reset the pane's filter state — used by clear and reset all.
function resetFilter() {
  paneResults = [];
  $("filter").value = "all";
  refreshFilterOptions();
  applyFilter();
}
$("filter").addEventListener("change", applyFilter);

let runResults = [];
function runSummary() {
  const ok = runResults.filter((r) => r.ok).length;
  return `${ok} ok · ${runResults.length - ok} failed`;
}

// Non-blocking warning if a variable is an already-expired JWT (would 401).
function preflightTokenWarnings(varsText) {
  let parsed;
  try { parsed = varsText.trim() ? JSON.parse(varsText) : {}; } catch { return []; }
  const sets = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set(), warns = [];
  for (const set of sets) {
    if (!set || typeof set !== "object") continue;
    for (const [k, val] of Object.entries(set)) {
      if (typeof val !== "string" || val.split(".").length !== 3 || seen.has(val)) continue;
      seen.add(val);
      const claims = decodeJwt(val);
      if (claims?.exp) {
        const e = fmtExpiry(claims.exp);
        if (e.expired) warns.push(`⚠ variable "${k}" is an expired JWT — ${e.text}`);
      }
    }
  }
  return warns;
}

// Warn about {{placeholders}} in the curl that nothing provides — they'd be
// dropped from the request (query param, header, or JSON body field).
function unresolvedVarWarnings() {
  const names = new Set();
  const re = /\{\{\s*([\w.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec($("curl").value))) names.add(m[1]);
  if (!names.size) return [];
  const provided = new Set(Object.keys(globals));
  try {
    const parsed = JSON.parse($("vars").value.trim() || "{}");
    for (const s of (Array.isArray(parsed) ? parsed : [parsed])) {
      if (s && typeof s === "object") Object.keys(s).forEach((k) => provided.add(k));
    }
  } catch { /* invalid data JSON — handled by its own error path */ }
  const missing = [...names].filter((n) => !provided.has(n));
  return missing.length
    ? [`⚠ no value for ${missing.map((n) => `{{${n}}}`).join(", ")} — omitted from the request`]
    : [];
}

// Render a dry-run entry: the request that *would* be sent.
function renderDry(msg) {
  const div = document.createElement("div");
  div.className = "run";
  div.style.borderLeftColor = "var(--accent)";
  const hdrs = Object.entries(msg.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  div.innerHTML = `<div class="meta">#${msg.run} <span class="code">DRY</span> · ${msg.method} ${escapeHtml(msg.url)}</div>`;
  const pre = document.createElement("pre");
  pre.textContent = (hdrs ? hdrs + "\n" : "") + (msg.body ? "\n" + pretty(msg.body) : "");
  div.appendChild(pre);
  $("output").appendChild(div);
  $("output").scrollTop = $("output").scrollHeight;
}

async function start(dryRun = false) {
  setRunning(true);
  runResults = [];
  // Each run starts with a fresh pane, keeping whatever filter you had set: the
  // counts then describe this run, and a sticky code filter can't leave rows
  // from an earlier run sitting on screen as if they belonged to this one.
  $("output").innerHTML = "";
  paneResults = [];
  refreshFilterOptions();
  applyFilter();
  $("download").disabled = true;
  $("statusLine").textContent = dryRun ? "previewing…" : "running…";
  // Warn about undefined {{vars}} on both runs and previews; token-expiry only
  // matters for a real run.
  const warns = unresolvedVarWarnings();
  if (!dryRun) warns.push(...preflightTokenWarnings($("vars").value), ...globalsTokenWarnings());
  warns.forEach((w) => note(w, true));
  controller = new AbortController();
  let dryCount = 0;
  try {
    const resp = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        curl: $("curl").value,
        vars: $("vars").value,
        delayMs: Number($("delay").value),
        count: Number($("runs").value) || 1,
        dryRun,
        globals,
      }),
    });
    // Read the NDJSON stream line by line.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === "result") {
          addRun(msg);
          runResults.push({ run: msg.run, method: msg.method, url: msg.url, status: msg.status, ok: msg.ok, ms: msg.ms, error: msg.error || "", response: msg.body || "" });
        } else if (msg.type === "dry") { renderDry(msg); dryCount++; }
        else if (msg.type === "start") note(`${dryRun ? "⌁ dry run" : "▶"} ${msg.method} ${msg.url} — ${msg.runs} run(s)`);
        else if (msg.type === "done") note(dryRun ? `✓ dry run — ${dryCount} request(s) previewed` : `✓ done — ${runSummary()}`);
        else if (msg.type === "error") note(msg.message, true);
      }
    }
    $("statusLine").textContent = dryRun ? `dry run · ${dryCount} request(s)` : `done · ${runSummary()}`;
  } catch (e) {
    if (e.name === "AbortError") $("statusLine").textContent = `stopped · ${runSummary()}`;
    else { note(`Request failed: ${e.message}`, true); $("statusLine").textContent = "error"; }
  } finally {
    setRunning(false);
    controller = null;
    $("download").disabled = runResults.length === 0;
  }
}

// Export the last run's results as CSV.
function downloadResults() {
  if (!runResults.length) return;
  const cols = ["run", "method", "url", "status", "ok", "ms", "error", "response"];
  const esc = (s) => { s = s == null ? "" : String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.join(","), ...runResults.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "curl-runner-results.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- shared variables (globals) -------------------------------------------
let globals = {};

function chipPreview(v) {
  if (v === "" || v == null) return "(empty)";
  const s = String(v);
  return s.length > 16 ? s.slice(0, 14) + "…" : s;
}

let tipEl = null;
// Tooltip text for a global chip: name (+ live expiry) and the full value.
function chipTipText(key) {
  const v = globals[key];
  const p = expiryParts(v);
  return `${key}${p ? " · " + p.long : ""}\n${v}`;
}
function showChipTip(ev, key) {
  hideTip();
  tipEl = document.createElement("div");
  tipEl.id = "tooltip";
  tipEl.dataset.key = key; // lets the ticker refresh it while open
  tipEl.textContent = chipTipText(key);
  document.body.appendChild(tipEl);
  moveTip(ev);
}
function moveTip(ev) {
  if (!tipEl) return;
  const pad = 14;
  tipEl.style.left = Math.min(ev.clientX + pad, window.innerWidth - tipEl.offsetWidth - pad) + "px";
  tipEl.style.top = (ev.clientY + pad) + "px";
}
function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

function renderGlobals() {
  const bar = $("globalsBar"), add = $("addGlobal");
  bar.querySelectorAll(".chip").forEach((c) => c.remove());
  for (const [k, v] of Object.entries(globals)) {
    const p = expiryParts(v);
    const chip = document.createElement("span");
    chip.className = "chip" + (p?.expired ? " expired" : "");
    chip.dataset.key = k; // lets the ticker find this chip
    chip.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(chipPreview(v))}</span>`
      + (p ? `<span class="exp">${escapeHtml(p.short)}</span>` : "");
    chip.addEventListener("mouseenter", (e) => showChipTip(e, k));
    chip.addEventListener("mousemove", moveTip);
    chip.addEventListener("mouseleave", hideTip);
    chip.addEventListener("click", () => { hideTip(); openEditor(k); });
    bar.insertBefore(chip, add);
  }
}

// Tick the JWT countdowns once a second: update each chip's "27m" label (and
// expired state), and refresh an open tooltip — no full re-render, so hover
// and edit state are preserved.
function tickExpiries() {
  $("globalsBar").querySelectorAll(".chip").forEach((chip) => {
    const p = expiryParts(globals[chip.dataset.key]);
    const exp = chip.querySelector(".exp");
    if (p && exp) { exp.textContent = p.short; chip.classList.toggle("expired", p.expired); }
  });
  if (tipEl?.dataset.key) tipEl.textContent = chipTipText(tipEl.dataset.key);
}
setInterval(tickExpiries, 1000);

function openEditor(key) {
  $("globalEditor").style.display = "flex";
  $("gName").value = key || "";
  $("gValue").value = key ? globals[key] : "";
  $("gName").dataset.orig = key || "";
  $("gDelete").style.display = key ? "" : "none";
  (key ? $("gValue") : $("gName")).focus();
}
function closeEditor() {
  $("globalEditor").style.display = "none";
  $("gName").value = ""; $("gValue").value = ""; $("gName").dataset.orig = "";
}
$("addGlobal").addEventListener("click", () => openEditor(""));
$("gSave").addEventListener("click", () => {
  const name = $("gName").value.trim();
  if (!name) { $("gName").focus(); return; }
  const orig = $("gName").dataset.orig;
  if (orig && orig !== name) delete globals[orig];
  globals[name] = $("gValue").value;
  renderGlobals(); saveState(); closeEditor();
});
$("gDelete").addEventListener("click", () => {
  const orig = $("gName").dataset.orig;
  if (orig) delete globals[orig];
  renderGlobals(); saveState(); closeEditor();
});
$("gCancel").addEventListener("click", closeEditor);

// Warn about expired-JWT globals (companion to the data-box check).
function globalsTokenWarnings() {
  const warns = [];
  for (const [k, v] of Object.entries(globals)) {
    if (!looksLikeJwt(v)) continue;
    const claims = decodeJwt(v);
    if (claims?.exp && fmtExpiry(claims.exp).expired) {
      warns.push(`⚠ variable "${k}" is an expired JWT — ${fmtExpiry(claims.exp).text}`);
    }
  }
  return warns;
}

// --- analyze: templatize a pasted curl ------------------------------------

function setCurlNote(text, isError) {
  const el = $("curlNote");
  el.textContent = text;
  el.style.color = isError ? "var(--err)" : "var(--muted)";
}

function analyzeCurl() {
  const text = $("curl").value;
  if (!text.trim()) { setCurlNote("paste a curl first", true); return; }
  const tokens = tokenizeSpans(text);
  const vars = {};
  const repls = [];        // { start, end, text } splices, applied right-to-left
  let tokenInfo = "", expired = false;
  let nUrl = 0, nBody = 0;

  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;

    // Authorization header: pull the Bearer JWT into {{token}}.
    if ((v === "-H" || v === "--header") && tokens[i + 1]) {
      const h = tokens[++i];
      const m = /^(authorization:\s*bearer\s+)(\S+)/i.exec(h.value);
      if (m) {
        globals.token = m[2]; // token lives in the shared-variables bar, not the data box
        repls.push({ start: h.start, end: h.end, text: `'${h.value.replace(m[2], "{{token}}")}'` });
        const claims = decodeJwt(m[2]);
        if (claims?.exp) {
          const e = fmtExpiry(claims.exp);
          expired = e.expired;
          tokenInfo = `token → {{token}} · ${e.text}${claims.sub ? ` · ${claims.sub}` : ""}`;
        } else {
          tokenInfo = "token → {{token}}";
        }
      }
      continue;
    }

    // Data/body: turn each top-level JSON field into a {{var}}.
    if (DATA_FLAGS.has(v) && tokens[i + 1]) {
      const d = tokens[++i];
      try {
        const parsed = JSON.parse(d.value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const fields = Object.entries(parsed).map(([k, val]) => {
            if (val === null || typeof val === "object") return `${JSON.stringify(k)}:${JSON.stringify(val)}`;
            vars[k] = val; nBody++;
            return `${JSON.stringify(k)}:${typeof val === "string" ? `"{{${k}}}"` : `{{${k}}}`}`;
          });
          repls.push({ start: d.start, end: d.end, text: `'{${fields.join(",")}}'` });
        }
      } catch { /* not JSON — leave the body as-is */ }
      continue;
    }

    // Bare URL token: turn query-string values into {{var}}s.
    if (!v.startsWith("-") && i > 0 && /^https?:\/\//i.test(v)) {
      const q = v.indexOf("?");
      if (q !== -1) {
        const base = v.slice(0, q);
        const pairs = v.slice(q + 1).split("&").map((pair) => {
          const eq = pair.indexOf("=");
          if (eq === -1) return pair;
          const key = pair.slice(0, eq);
          const rawVal = pair.slice(eq + 1);
          // Leave empty/optional params as-is — nothing to templatize, and
          // turning them into a {{var}} just creates an undefined-value footgun.
          if (rawVal === "") return pair;
          vars[key] = decodeURIComponent(rawVal); nUrl++;
          return `${key}={{${key}}}`;
        });
        repls.push({ start: tokens[i].start, end: tokens[i].end, text: `'${base}?${pairs.join("&")}'` });
      }
    }
  }

  if (!repls.length) {
    setCurlNote("nothing to templatize — no bearer token, query params, or JSON body found", true);
    return;
  }

  // Apply splices right-to-left so earlier spans stay valid.
  repls.sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of repls) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  $("curl").value = out;
  autoGrow($("curl"));

  // Seed the variables box with the discovered example values.
  $("vars").value = JSON.stringify(vars, null, 2);
  const counts = [nUrl && `${nUrl} url var(s)`, nBody && `${nBody} body field(s)`].filter(Boolean).join(", ");
  $("runs").value = "1"; // fresh curl — don't carry over a previous run count
  setVarsNote(`analyzed${counts ? ` · ${counts}` : ""}`);
  setCurlNote(tokenInfo || "templatized", expired);
  renderGlobals();
  saveState();
}
$("analyze").addEventListener("click", analyzeCurl);

$("start").addEventListener("click", () => start(false));
$("dry").addEventListener("click", () => start(true));
$("stop").addEventListener("click", () => controller && controller.abort());
$("clear").addEventListener("click", () => { $("output").innerHTML = ""; resetFilter(); });
$("download").addEventListener("click", downloadResults);
$("raw").addEventListener("click", () => {
  const on = $("output").classList.toggle("show-raw");
  $("raw").classList.toggle("on", on);
  saveState();
});

// Wipe everything back to a clean slate (curl, data, variables, settings, output).
function resetAll() {
  if (!confirm("Clear everything — curl, data, variables, output, and settings?")) return;
  $("curl").value = "";
  $("vars").value = "";
  $("delay").value = "50";
  $("runs").value = "1";
  globals = {};
  closeEditor();
  $("output").innerHTML = "";
  resetFilter();
  $("download").disabled = true;
  $("output").classList.remove("show-raw");
  $("raw").classList.remove("on");
  setCurlNote("");
  setVarsNote("");        // also refits the data box and updates the runs visibility
  renderGlobals();
  autoGrow($("curl"));
  saveState();
}
$("reset").addEventListener("click", resetAll);

// Persist inputs across refreshes so a reload never wipes a pasted curl.
const LS = { curl: "cr.curl", vars: "cr.vars", delay: "cr.delay", runs: "cr.runs", globals: "cr.globals", raw: "cr.raw" };
function saveState() {
  try {
    localStorage.setItem(LS.curl, $("curl").value);
    localStorage.setItem(LS.vars, $("vars").value);
    localStorage.setItem(LS.delay, $("delay").value);
    localStorage.setItem(LS.runs, $("runs").value);
    localStorage.setItem(LS.globals, JSON.stringify(globals));
    localStorage.setItem(LS.raw, $("output").classList.contains("show-raw") ? "1" : "");
  } catch { /* storage unavailable — ignore */ }
}
function restoreState() {
  try {
    const c = localStorage.getItem(LS.curl); if (c !== null) $("curl").value = c;
    const v = localStorage.getItem(LS.vars); if (v !== null) $("vars").value = v;
    const d = localStorage.getItem(LS.delay); if (d) $("delay").value = d;
    const r = localStorage.getItem(LS.runs); if (r) $("runs").value = r;
    try { globals = JSON.parse(localStorage.getItem(LS.globals) || "{}"); } catch { globals = {}; }
    if (localStorage.getItem(LS.raw)) { $("output").classList.add("show-raw"); $("raw").classList.add("on"); }
    renderGlobals();
    autoGrow($("curl")); autoGrow($("vars"));
    updateRunsVisibility();
  } catch { /* ignore */ }
}
["curl", "vars", "delay", "runs"].forEach((id) => $(id).addEventListener("input", saveState));
$("vars").addEventListener("input", updateRunsVisibility);
restoreState();

// Small status line next to the variables buttons (filename, item count,
// prettify result). isError tints it red.
function setVarsNote(text, isError) {
  const el = $("fileName");
  el.textContent = text;
  el.style.color = isError ? "var(--err)" : "var(--muted)";
  autoGrow($("vars")); // upload/prettify just changed the box — refit it
  updateRunsVisibility();
}

// The "runs" box only applies to a single data set. If the data box holds an
// array of multiple rows, those rows drive the run count, so hide the box.
function updateRunsVisibility() {
  let multi = false, n = 0;
  try {
    const p = JSON.parse($("vars").value.trim() || "{}");
    if (Array.isArray(p) && p.length > 1) { multi = true; n = p.length; }
  } catch { /* invalid JSON — treat as a single set */ }
  $("runsField").style.display = multi ? "none" : "";
  $("runsNote").textContent = multi ? `${n} runs (one per data row)` : "";
}

// Prettify (and gently repair) the variables box. Reformats valid JSON; if the
// text only parses once wrapped in [ ], wraps it for you; otherwise says so.
$("prettify").addEventListener("click", () => {
  const text = $("vars").value.trim();
  if (!text) { setVarsNote("nothing to format"); return; }
  try {
    const parsed = JSON.parse(text);
    $("vars").value = JSON.stringify(parsed, null, 2);
    setVarsNote(`formatted${Array.isArray(parsed) ? ` · ${parsed.length} items` : ""}`);
    return;
  } catch { /* try the missing-brackets case below */ }
  try {
    const wrapped = JSON.parse(`[${text}]`);
    $("vars").value = JSON.stringify(wrapped, null, 2);
    setVarsNote(`wrapped in [ ] and formatted · ${wrapped.length} items`);
  } catch {
    setVarsNote("✗ invalid JSON — can't format until it's fixed", true);
  }
});

// Load a .json or .csv file into the variables box. JSON is pretty-printed
// (raw on parse failure so the inline error can point at the problem); CSV is
// converted to an array of objects.
$("upload").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    let info = "";
    if (/\.csv$/i.test(file.name)) {
      const objs = csvToObjects(text);
      $("vars").value = JSON.stringify(objs, null, 2);
      info = ` · ${objs.length} items`;
    } else {
      try { $("vars").value = JSON.stringify(JSON.parse(text), null, 2); }
      catch { $("vars").value = text; }
      try { const p = JSON.parse($("vars").value); if (Array.isArray(p)) info = ` · ${p.length} items`; }
      catch { /* leave info empty */ }
    }
    setVarsNote(`${file.name}${info}`);
  };
  reader.readAsText(file);
  e.target.value = ""; // allow re-uploading the same file
});
