import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 2875;
// Cap how much response body we stream back per run so a huge payload can't
// blow up the browser output box.
const MAX_BODY_CHARS = Number(process.env.MAX_BODY_CHARS || 20000);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- curl parsing ------------------------------------------------------------

// Split a curl command string into argv-style tokens, honoring single/double
// quotes and backslash line continuations (the trailing "\" that curl examples
// love to wrap with).
function tokenize(input) {
  const tokens = [];
  let cur = "";
  let quote = null; // "'" or '"' when inside a quoted run
  let has = false; // did we start a token (so empty "" produces a token)
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"') {
        // In double quotes, backslash escapes the next char.
        const next = input[++i];
        cur += next ?? "";
      } else {
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\") {
      // Line continuation or escaped char outside quotes.
      const next = input[i + 1];
      if (next === "\n" || next === "\r") {
        i++;
      } else if (next !== undefined) {
        cur += next;
        i++;
        has = true;
      }
    } else if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

// Flags that consume the following token as their value.
const VALUE_FLAGS = new Set([
  "-X", "--request",
  "-H", "--header",
  "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
  "-u", "--user",
  "-b", "--cookie",
  "-A", "--user-agent",
  "-e", "--referer",
  "--url",
]);

// Boolean flags we simply ignore (they take no argument).
const BOOL_FLAGS = new Set([
  "-s", "--silent", "-S", "--show-error", "-k", "--insecure",
  "-L", "--location", "-i", "--include", "-v", "--verbose",
  "--compressed", "-g", "--globoff", "-f", "--fail", "-G", "--get",
]);

function parseCurl(command) {
  const tokens = tokenize(command.trim());
  if (tokens[0] === "curl") tokens.shift();

  let url = null;
  let method = null;
  let basicAuth = null;
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

    if (BOOL_FLAGS.has(flag)) continue;
    if (flag.startsWith("-")) continue; // unknown flag — skip defensively

    // Bare token => the URL.
    if (!url) url = t;
  }

  const body = dataParts.length ? dataParts.join("&") : null;
  if (!method) method = body ? "POST" : "GET";

  return { url, method: method.toUpperCase(), headers, body, basicAuth };
}

// --- variable substitution ---------------------------------------------------

// Turn V8's "... in JSON at position 51 (line 1 column 52)" into something that
// actually shows *where* the problem is: a snippet with a marker at that spot.
function explainJsonError(text, err) {
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

function substitute(str, vars) {
  if (str == null) return str;
  return str.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name)
      ? String(vars[name])
      : whole; // leave unresolved placeholders visible rather than blanking them
  });
}

function applyVars(req, vars) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[substitute(k, vars)] = substitute(v, vars);
  }
  // Substitute inside the credentials first, then encode — otherwise {{vars}}
  // would be trapped inside the base64. An explicit -H Authorization wins.
  if (req.basicAuth && !("Authorization" in headers)) {
    headers["Authorization"] =
      "Basic " + Buffer.from(substitute(req.basicAuth, vars)).toString("base64");
  }
  return {
    url: substitute(req.url, vars),
    method: req.method,
    headers,
    body: substitute(req.body, vars),
  };
}

// --- the run loop ------------------------------------------------------------

// Normalize the variables JSON into an ordered list of variable-sets.
// Object => single set (repeat the same request). Array => one set per element.
function toVarSets(parsed) {
  if (Array.isArray(parsed)) return parsed.map((x) => x ?? {});
  if (parsed && typeof parsed === "object") return [parsed];
  return [{}];
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    }
  });

app.post("/api/run", async (req, res) => {
  const { curl, vars, delayMs = 1000, repeat = false, dryRun = false } = req.body || {};

  // Stream NDJSON: one JSON object per line, flushed as it happens.
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  // Stop when the client aborts the fetch (the Stop button). Detect this via
  // the *response* closing before we've finished writing it — a client
  // disconnect. (req's "close" is unreliable here: it also fires the moment the
  // request body is fully read, which would abort us on the very first run.)
  const ac = new AbortController();
  let stopped = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      stopped = true;
      ac.abort();
    }
  });

  let parsedReq;
  try {
    parsedReq = parseCurl(String(curl || ""));
    if (!parsedReq.url) throw new Error("No URL found in curl command.");
  } catch (e) {
    send({ type: "error", message: `Could not parse curl: ${e.message}` });
    return res.end();
  }

  let varSets;
  try {
    const parsed = vars && vars.trim() ? JSON.parse(vars) : {};
    varSets = toVarSets(parsed);
  } catch (e) {
    send({ type: "error", message: `Variables must be valid JSON: ${explainJsonError(vars || "", e)}` });
    return res.end();
  }

  send({
    type: "start",
    method: parsedReq.method,
    url: parsedReq.url,
    sets: varSets.length,
    repeat: !!repeat,
    dryRun: !!dryRun,
  });

  let runNo = 0;
  do {
    for (let i = 0; i < varSets.length && !stopped; i++) {
      runNo++;
      const finalReq = applyVars(parsedReq, varSets[i]);

      // Dry run: show the fully-substituted request without sending it.
      if (dryRun) {
        send({
          type: "dry",
          run: runNo,
          setIndex: i,
          method: finalReq.method,
          url: finalReq.url,
          headers: finalReq.headers,
          body: ["GET", "HEAD"].includes(finalReq.method) ? undefined : finalReq.body,
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        const resp = await fetch(finalReq.url, {
          method: finalReq.method,
          headers: finalReq.headers,
          body: ["GET", "HEAD"].includes(finalReq.method) ? undefined : finalReq.body,
          signal: ac.signal,
        });
        const text = await resp.text();
        send({
          type: "result",
          run: runNo,
          setIndex: i,
          status: resp.status,
          ok: resp.ok,
          ms: Date.now() - startedAt,
          url: finalReq.url,
          method: finalReq.method,
          body: text.length > MAX_BODY_CHARS
            ? text.slice(0, MAX_BODY_CHARS) + `\n…(truncated, ${text.length} chars)`
            : text,
        });
      } catch (e) {
        if (stopped) break;
        send({
          type: "result",
          run: runNo,
          setIndex: i,
          status: 0,
          ok: false,
          ms: Date.now() - startedAt,
          url: finalReq.url,
          method: finalReq.method,
          error: e.message,
        });
      }

      // Delay before the next run (skip after the very last one).
      const isLast = !repeat && i === varSets.length - 1;
      if (!stopped && !isLast) await sleep(Number(delayMs) || 0, ac.signal);
    }
  } while (repeat && !stopped && !dryRun);

  if (!stopped) send({ type: "done", runs: runNo, dryRun: !!dryRun });
  res.end();
});

app.listen(PORT, () => {
  console.log(`curl-runner listening on http://localhost:${PORT}`);
});
