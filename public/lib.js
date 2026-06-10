// Shared pure logic for curl-runner, imported by BOTH the Node server
// (server.js) and the browser UI (app.js). Plain ESM: no dependencies, no DOM,
// no Node-only APIs — anything here must run in either environment.

// --- tokenizing ---------------------------------------------------------------

// Decode one bash ANSI-C ($'...') escape. `input[i]` is the char right after the
// backslash. Returns [decodedString, nextIndex]. Handles the simple escapes plus
// \xHH, \uHHHH, \UHHHHHHHH, and \nnn octal (Chrome emits \uHHHH for non-ASCII).
function ansiCEscape(input, i) {
  const c = input[i];
  const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  if (c in simple) return [simple[c], i + 1];
  let m;
  if (c === "x" && (m = /^[0-9A-Fa-f]{1,2}/.exec(input.slice(i + 1, i + 3)))) return [String.fromCharCode(parseInt(m[0], 16)), i + 1 + m[0].length];
  if (c === "u" && (m = /^[0-9A-Fa-f]{1,4}/.exec(input.slice(i + 1, i + 5)))) return [String.fromCodePoint(parseInt(m[0], 16)), i + 1 + m[0].length];
  if (c === "U" && (m = /^[0-9A-Fa-f]{1,8}/.exec(input.slice(i + 1, i + 9)))) return [String.fromCodePoint(parseInt(m[0], 16)), i + 1 + m[0].length];
  if (c >= "0" && c <= "7" && (m = /^[0-7]{1,3}/.exec(input.slice(i, i + 3)))) return [String.fromCharCode(parseInt(m[0], 8)), i + m[0].length];
  return [c, i + 1]; // unknown escape — keep the char literally
}

// Tokenize a shell command into { value, start, end } spans over the raw text
// (analyze uses the spans to splice the original string). Handles '...', "...",
// \-escapes, line continuations, and bash ANSI-C $'...' quoting.
export function tokenizeSpans(input) {
  const tokens = [];
  let cur = "", quote = null, ansiC = false, start = -1, has = false;
  const begin = (i) => { if (start < 0) start = i; has = true; };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (quote === "'" && ansiC) {
        if (c === "\\") { const [dec, next] = ansiCEscape(input, i + 1); cur += dec; i = next - 1; }
        else if (c === "'") { quote = null; ansiC = false; }
        else cur += c;
      } else if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"') {
        cur += input[++i] ?? "";
      } else cur += c;
      continue;
    }
    if (c === "$" && input[i + 1] === "'") { begin(i); quote = "'"; ansiC = true; i++; }
    else if (c === "'" || c === '"') { begin(i); quote = c; }
    else if (c === "\\") {
      const n = input[i + 1];
      if (n === "\n" || n === "\r") i++;
      else if (n !== undefined) { begin(i); cur += n; i++; }
    } else if (/\s/.test(c)) {
      if (has) { tokens.push({ value: cur, start, end: i }); cur = ""; has = false; start = -1; }
    } else { begin(i); cur += c; }
  }
  if (has) tokens.push({ value: cur, start, end: input.length });
  return tokens;
}

// --- curl parsing ---------------------------------------------------------------

// Flags that consume the following token as their value.
export const VALUE_FLAGS = new Set([
  "-X", "--request",
  "-H", "--header",
  "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
  "-u", "--user",
  "-b", "--cookie",
  "-A", "--user-agent",
  "-e", "--referer",
  "--url",
]);

// Boolean flags we accept and ignore (they take no argument).
export const BOOL_FLAGS = new Set([
  "-s", "--silent", "-S", "--show-error", "-k", "--insecure",
  "-L", "--location", "-i", "--include", "-v", "--verbose",
  "--compressed", "-g", "--globoff", "-f", "--fail",
]);

// Data flags whose value is a request body (used by analyze too).
export const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"]);

export function parseCurl(command) {
  const tokens = tokenizeSpans(command.trim()).map((t) => t.value);
  if (tokens[0] === "curl") tokens.shift();

  let url = null;
  let method = null;
  let basicAuth = null;
  let useGet = false;
  const headers = {};
  const dataParts = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Support --flag=value form.
    let flag = t;
    let inlineVal = null;
    if (t.startsWith("--") && t.includes("=")) {
      const eq = t.indexOf("=");
      flag = t.slice(0, eq);
      inlineVal = t.slice(eq + 1);
    }

    if (VALUE_FLAGS.has(flag)) {
      const val = inlineVal !== null ? inlineVal : tokens[++i];
      switch (flag) {
        case "-X": case "--request":
          method = val;
          break;
        case "-H": case "--header": {
          const idx = val.indexOf(":");
          if (idx !== -1) {
            headers[val.slice(0, idx).trim()] = val.slice(idx + 1).trim();
          }
          break;
        }
        case "-d": case "--data": case "--data-raw":
        case "--data-binary": case "--data-ascii": case "--data-urlencode":
          dataParts.push(val);
          break;
        case "-u": case "--user":
          // Keep the raw "user:pass" so {{vars}} inside it can be substituted
          // before we base64-encode (done in applyVars).
          basicAuth = val;
          break;
        case "-b": case "--cookie":
          headers["Cookie"] = val;
          break;
        case "-A": case "--user-agent":
          headers["User-Agent"] = val;
          break;
        case "-e": case "--referer":
          headers["Referer"] = val;
          break;
        case "--url":
          url = val;
          break;
      }
      continue;
    }

    if (flag === "-G" || flag === "--get") { useGet = true; continue; }
    if (BOOL_FLAGS.has(flag)) continue;
    if (flag.startsWith("-")) continue; // unknown flag — skip defensively

    // Bare token => the URL.
    if (!url) url = t;
  }

  let body = dataParts.length ? dataParts.join("&") : null;
  // -G/--get: the data goes onto the URL as a query string instead of the body.
  if (useGet && body && url) {
    url += (url.includes("?") ? "&" : "?") + body;
    body = null;
  }
  if (!method) method = body ? "POST" : "GET";

  return { url, method: method.toUpperCase(), headers, body, basicAuth };
}

// --- variable substitution ---------------------------------------------------

export function substitute(str, vars) {
  if (str == null) return str;
  return str.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name)
      ? String(vars[name])
      : whole; // leave unresolved placeholders for pruneUnresolved to drop
  });
}

// Matches a leftover placeholder, i.e. a variable that wasn't provided.
export const UNRESOLVED = /\{\{\s*[\w.-]+\s*\}\}/;

// Drop a JSON body field whose value is an unresolved placeholder. The template
// is often invalid JSON (an unquoted {{num}} placeholder), so this is a textual
// strip of  "key": {{x}}  /  "key": "{{x}}"  pairs, cleaning up commas after.
// The marker is NUL (\\u0000), which can't appear in user data — using a
// plain space here once stripped the spaces out of every kept string value.
export function stripUnresolvedBodyFields(body) {
  const M = "\u0000";
  const PAIR = /"[\w.-]+"\s*:\s*"?\{\{\s*[\w.-]+\s*\}\}"?/g;
  let s = body.replace(PAIR, M);
  s = s.replace(/\u0000\s*,\s*/g, "")   // marker then comma
       .replace(/\s*,\s*\u0000/g, "")   // comma then marker
       .replace(/\u0000/g, "");           // a lone marker
  return s.replace(/\{\s*,/g, "{").replace(/,\s*\}/g, "}");
}

// Remove anything still referencing an undefined variable: query params,
// headers, and JSON body fields all get dropped rather than sent literally.
export function pruneUnresolved(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (UNRESOLVED.test(k) || UNRESOLVED.test(v)) continue; // drop the header
    headers[k] = v;
  }

  let url = req.url;
  const qi = url.indexOf("?");
  if (qi !== -1) {
    const kept = url.slice(qi + 1).split("&").filter((p) => !UNRESOLVED.test(p));
    url = kept.length ? url.slice(0, qi) + "?" + kept.join("&") : url.slice(0, qi);
  }

  let body = req.body;
  if (body && UNRESOLVED.test(body)) body = stripUnresolvedBodyFields(body);

  return { url, method: req.method, headers, body };
}

// UTF-8 safe base64 that works in both Node and the browser.
function toBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function applyVars(req, vars) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[substitute(k, vars)] = substitute(v, vars);
  }
  // Substitute inside the credentials first, then encode — otherwise {{vars}}
  // would be trapped inside the base64. An explicit -H Authorization wins.
  if (req.basicAuth && !("Authorization" in headers)) {
    headers["Authorization"] = "Basic " + toBase64(substitute(req.basicAuth, vars));
  }
  // Substitute, then drop anything that referenced an undefined variable.
  return pruneUnresolved({
    url: substitute(req.url, vars),
    method: req.method,
    headers,
    body: substitute(req.body, vars),
  });
}

// Normalize the variables JSON into an ordered list of variable-sets.
// Object => single set (repeat the same request). Array => one set per element.
export function toVarSets(parsed) {
  if (Array.isArray(parsed)) return parsed.map((x) => x ?? {});
  if (parsed && typeof parsed === "object") return [parsed];
  return [{}];
}

// Turn V8's "... in JSON at position 51 (line 1 column 52)" into something that
// actually shows *where* the problem is: a snippet with a marker at that spot.
export function explainJsonError(text, err) {
  // Most common mistake: a comma-separated list of objects with no surrounding
  // [ ]. If wrapping it in brackets parses cleanly, that's almost certainly it.
  try {
    JSON.parse(`[${text}]`);
    return "looks like a list of items missing the surrounding [ ]. " +
      "Wrap the whole thing in [ … ] to run one request per item.";
  } catch { /* not the bracket case — fall through to the generic explainer */ }

  const base = err.message
    .replace(/\s*in JSON at position \d+/, "")
    .replace(/\s*\(line \d+ column \d+\)/, "");
  const m = /position (\d+)/.exec(err.message);
  if (!m) return base;
  const pos = Number(m[1]);
  const start = Math.max(0, pos - 25);
  const end = Math.min(text.length, pos + 25);
  const snippet =
    (start > 0 ? "…" : "") +
    text.slice(start, pos) + "◀here▶" + text.slice(pos, end) +
    (end < text.length ? "…" : "");
  // Collapse newlines so the snippet stays on one line in the output box.
  return `${base} — near: ${snippet.replace(/\s+/g, " ")}`;
}

// --- JWT helpers ---------------------------------------------------------------

export function looksLikeJwt(v) { return typeof v === "string" && v.split(".").length === 3; }

export function decodeJwt(tok) {
  const parts = tok.split(".");
  if (parts.length < 2) return null;
  let p = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (p.length % 4) p += "=";
  try { return JSON.parse(atob(p)); } catch { return null; }
}

export function fmtExpiry(exp) {
  const ms = exp * 1000 - Date.now();
  const mins = Math.round(Math.abs(ms) / 60000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const at = new Date(exp * 1000).toLocaleTimeString();
  return ms >= 0 ? { text: `expires in ${dur} (≈ ${at})`, expired: false }
                 : { text: `EXPIRED ${dur} ago (≈ ${at})`, expired: true };
}

// If a value is a JWT with an exp claim, return live countdown parts:
//   short ("27m" / "1h 4m" / "45s") for the chip, long for the tooltip.
export function expiryParts(value) {
  if (!looksLikeJwt(value)) return null;
  const claims = decodeJwt(value);
  if (!claims?.exp) return null;
  const ms = claims.exp * 1000 - Date.now();
  const a = Math.abs(ms);
  const h = Math.floor(a / 3600000), m = Math.floor((a % 3600000) / 60000), s = Math.floor((a % 60000) / 1000);
  const short = h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
  const at = new Date(claims.exp * 1000).toLocaleTimeString();
  const expired = ms < 0;
  return { expired, short, long: expired ? `EXPIRED ${short} ago (≈ ${at})` : `expires in ${short} (≈ ${at})` };
}

// --- CSV ---------------------------------------------------------------

// Parse CSV into rows of fields. Handles quoted fields, embedded commas and
// newlines, "" escapes, CRLF, and a leading BOM.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Drop fully-blank rows (e.g. trailing newline).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

// CSV -> array of objects, header row as keys. Values stay strings (they get
// substituted into the curl as text anyway).
export function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ""; });
    return obj;
  });
}

// --- display helpers ---------------------------------------------------------------

// Single-quote a value for a shell command, escaping embedded quotes so the
// reconstructed curl is actually copy-pasteable.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Reconstruct the curl that was actually sent (vars already substituted).
export function reqToCurl(method, url, headers, body) {
  const lines = [`curl -X ${method} ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(headers || {})) lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  if (body) lines.push(`  --data ${shellQuote(body)}`);
  return lines.join(" \\\n");
}
