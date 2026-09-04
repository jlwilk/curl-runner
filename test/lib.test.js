import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeSpans, parseCurl,
  substitute, stripUnresolvedBodyFields, pruneUnresolved, applyVars,
  toVarSets, explainJsonError,
  looksLikeJwt, decodeJwt, fmtExpiry, expiryParts,
  parseCSV, csvToObjects, reqToCurl,
  matchesFilter, filterBuckets,
} from "../public/lib.js";

const BS = "\\"; // a literal backslash, kept out of string literals for clarity

// --- tokenizeSpans -------------------------------------------------------------

test("tokenizeSpans: basic quoting and continuations", () => {
  const vals = (s) => tokenizeSpans(s).map((t) => t.value);
  assert.deepEqual(vals("curl -X POST url"), ["curl", "-X", "POST", "url"]);
  assert.deepEqual(vals("curl 'a b' \"c d\""), ["curl", "a b", "c d"]);
  // line continuation
  assert.deepEqual(vals(`curl ${BS}\n  -s url`), ["curl", "-s", "url"]);
  // escaped char outside quotes
  assert.deepEqual(vals(`a${BS} b`), ["a b"]);
  // backslash escapes inside double quotes only
  assert.deepEqual(vals(`"a${BS}"b"`), ['a"b']);
});

test("tokenizeSpans: ANSI-C $'...' quoting (Chrome Copy as cURL)", () => {
  const vals = (s) => tokenizeSpans(s).map((t) => t.value);
  // \' inside $'...'
  assert.deepEqual(vals(`$'Let${BS}'s test'`), ["Let's test"]);
  // \uHHHH, \xHH, octal, \t
  assert.deepEqual(vals(`$'${BS}u0021${BS}x21${BS}101${BS}t'`), ["!!A\t"]);
  // \U with 8 digits
  assert.deepEqual(vals(`$'${BS}U00000041'`), ["A"]);
  // unknown escape keeps the char
  assert.deepEqual(vals(`$'${BS}q'`), ["q"]);
});

test("tokenizeSpans: spans cover the original text", () => {
  const input = "curl  'a b'  tail";
  const tok = tokenizeSpans(input)[1];
  assert.equal(input.slice(tok.start, tok.end), "'a b'");
});

// --- parseCurl -------------------------------------------------------------

test("parseCurl: methods, headers, data, defaults", () => {
  const r = parseCurl(`curl -X PUT https://x.test/a -H 'X-One: 1' -H 'X-Two: 2' -d '{"a":1}'`);
  assert.equal(r.method, "PUT");
  assert.equal(r.url, "https://x.test/a");
  assert.deepEqual(r.headers, { "X-One": "1", "X-Two": "2" });
  assert.equal(r.body, '{"a":1}');
  // default method: POST with data, GET without
  assert.equal(parseCurl("curl https://x.test").method, "GET");
  assert.equal(parseCurl("curl https://x.test -d a=1").method, "POST");
});

test("parseCurl: --flag=value form, --url, bool flags, unknown flags", () => {
  const r = parseCurl("curl --request=PATCH --url=https://x.test -s -L --compressed --no-such-flag");
  assert.equal(r.method, "PATCH");
  assert.equal(r.url, "https://x.test");
});

test("parseCurl: multiple -d parts join with &", () => {
  assert.equal(parseCurl("curl https://x.test -d a=1 -d b=2").body, "a=1&b=2");
});

test("parseCurl: -u keeps raw creds for later substitution", () => {
  assert.equal(parseCurl("curl https://x.test -u bob:s3cret").basicAuth, "bob:s3cret");
});

test("parseCurl: -b/-A/-e map to headers", () => {
  const r = parseCurl("curl https://x.test -b 'k=v' -A agent007 -e https://ref.test");
  assert.deepEqual(r.headers, { Cookie: "k=v", "User-Agent": "agent007", Referer: "https://ref.test" });
});

test("parseCurl: -G moves data onto the URL as a query string", () => {
  const r = parseCurl("curl -G https://x.test/search -d q=hello -d lang=en");
  assert.equal(r.method, "GET");
  assert.equal(r.url, "https://x.test/search?q=hello&lang=en");
  assert.equal(r.body, null);
  // appends to an existing query string
  assert.equal(parseCurl("curl -G 'https://x.test/s?a=1' -d b=2").url, "https://x.test/s?a=1&b=2");
});

test("parseCurl: ANSI-C quoted body parses correctly (server-side regression)", () => {
  // This used to mangle the body when run directly without analyze.
  const r = parseCurl(`curl --data-raw $'{"note":"Let${BS}'s test ${BS}u0021"}' https://x.test`);
  assert.equal(r.body, `{"note":"Let's test !"}`);
  assert.equal(r.url, "https://x.test");
});

// --- substitution & pruning -------------------------------------------------------------

test("substitute: defined, undefined, whitespace, types", () => {
  assert.equal(substitute("a {{x}} b", { x: 1 }), "a 1 b");
  assert.equal(substitute("{{ x }}", { x: "v" }), "v");
  assert.equal(substitute("{{missing}}", {}), "{{missing}}");
  assert.equal(substitute(null, {}), null);
});

test("stripUnresolvedBodyFields: preserves spaces in kept values (bug regression)", () => {
  // The old space-marker implementation turned "Note runner test" into
  // "Noterunnertest" whenever any field was dropped.
  assert.equal(
    stripUnresolvedBodyFields(`{"account_id":{{account_id}},"note":"Note runner test"}`),
    `{"note":"Note runner test"}`
  );
});

test("stripUnresolvedBodyFields: positions and counts", () => {
  assert.equal(stripUnresolvedBodyFields(`{"a":{{a}},"b":1}`), `{"b":1}`);
  assert.equal(stripUnresolvedBodyFields(`{"b":1,"a":{{a}}}`), `{"b":1}`);
  assert.equal(stripUnresolvedBodyFields(`{"a":{{a}}}`), `{}`);
  assert.equal(stripUnresolvedBodyFields(`{"a":{{a}},"b":{{b}},"c":1}`), `{"c":1}`);
  assert.equal(stripUnresolvedBodyFields(`{"c":1,"a":{{a}},"b":{{b}}}`), `{"c":1}`);
  assert.equal(stripUnresolvedBodyFields(`{"a":"{{a}}","b":"x y"}`), `{"b":"x y"}`);
});

test("pruneUnresolved: drops query params, headers, body fields", () => {
  const r = pruneUnresolved({
    url: "https://x.test/p?keep=1&drop={{gone}}",
    method: "POST",
    headers: { Keep: "v", Drop: "{{gone}}" },
    body: `{"keep":"a b","drop":{{gone}}}`,
  });
  assert.equal(r.url, "https://x.test/p?keep=1");
  assert.deepEqual(r.headers, { Keep: "v" });
  assert.equal(r.body, `{"keep":"a b"}`);
});

test("pruneUnresolved: removes ? entirely when all params drop", () => {
  const r = pruneUnresolved({ url: "https://x.test/p?a={{x}}", method: "GET", headers: {}, body: null });
  assert.equal(r.url, "https://x.test/p");
});

test("applyVars: substitutes everywhere, encodes basic auth after substitution", () => {
  const req = {
    url: "https://x.test/{{id}}",
    method: "POST",
    headers: { "X-T": "{{tag}}" },
    body: `{"n":{{id}}}`,
    basicAuth: "{{user}}:{{pass}}",
  };
  const r = applyVars(req, { id: 7, tag: "a", user: "bob", pass: "s3cret" });
  assert.equal(r.url, "https://x.test/7");
  assert.equal(r.headers["X-T"], "a");
  assert.equal(r.body, `{"n":7}`);
  assert.equal(r.headers.Authorization, "Basic " + Buffer.from("bob:s3cret").toString("base64"));
});

test("applyVars: explicit Authorization header wins over -u", () => {
  const r = applyVars(
    { url: "https://x.test", method: "GET", headers: { Authorization: "Bearer t" }, body: null, basicAuth: "a:b" },
    {}
  );
  assert.equal(r.headers.Authorization, "Bearer t");
});

test("toVarSets: object, array, junk", () => {
  assert.deepEqual(toVarSets({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(toVarSets([{ a: 1 }, null]), [{ a: 1 }, {}]);
  assert.deepEqual(toVarSets("nope"), [{}]);
});

// --- explainJsonError -------------------------------------------------------------

function jsonErr(text) {
  try { JSON.parse(text); throw new Error("expected parse failure"); }
  catch (e) { return explainJsonError(text, e); }
}

test("explainJsonError: detects a list missing its [ ]", () => {
  const msg = jsonErr(`{"a":1},\n{"a":2}`);
  assert.match(msg, /missing the surrounding \[ \]/);
});

test("explainJsonError: points at the failure position", () => {
  const msg = jsonErr(`{"id":"1","token":"abc" "name":"W"}`);
  assert.match(msg, /◀here▶/);
  assert.doesNotMatch(msg, /at position \d/);
});

// --- JWT helpers -------------------------------------------------------------

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const makeJwt = (claims) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;

test("decodeJwt / looksLikeJwt", () => {
  const tok = makeJwt({ sub: "jason@wilk.in", exp: 123 });
  assert.equal(looksLikeJwt(tok), true);
  assert.equal(looksLikeJwt("abc"), false);
  assert.deepEqual(decodeJwt(tok), { sub: "jason@wilk.in", exp: 123 });
  assert.equal(decodeJwt("garbage"), null);
});

test("fmtExpiry / expiryParts: future and past", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(fmtExpiry(now + 1800).expired, false);
  assert.equal(fmtExpiry(now - 1800).expired, true);

  const p = expiryParts(makeJwt({ exp: now + 90 }));
  assert.equal(p.expired, false);
  assert.match(p.short, /^1m$/);
  const past = expiryParts(makeJwt({ exp: now - 30 }));
  assert.equal(past.expired, true);
  assert.match(past.long, /^EXPIRED/);
  // sub-minute precision
  assert.match(expiryParts(makeJwt({ exp: now + 45 })).short, /^4[0-9]s$/);
  // non-JWT and missing exp
  assert.equal(expiryParts("abc"), null);
  assert.equal(expiryParts(makeJwt({ sub: "x" })), null);
});

// --- CSV -------------------------------------------------------------

test("csvToObjects: quoted commas, newlines, escapes, BOM, short rows", () => {
  assert.deepEqual(
    csvToObjects('accountId,note\n1,"Note, with comma"\n2,plain'),
    [{ accountId: "1", note: "Note, with comma" }, { accountId: "2", note: "plain" }]
  );
  assert.deepEqual(
    csvToObjects('id,text\n1,"line1\nline2"\n2,"say ""hi"""'),
    [{ id: "1", text: "line1\nline2" }, { id: "2", text: 'say "hi"' }]
  );
  assert.deepEqual(csvToObjects("﻿a,b\r\n1,2\r\n\r\n"), [{ a: "1", b: "2" }]);
  assert.deepEqual(csvToObjects("a,b,c\n1,2"), [{ a: "1", b: "2", c: "" }]);
  assert.deepEqual(parseCSV(""), []);
});

// --- reqToCurl -------------------------------------------------------------

test("reqToCurl: shell-escapes single quotes so it's copy-pasteable", () => {
  const out = reqToCurl("POST", "https://x.test", { "X-H": "v" }, `{"note":"Let's go"}`);
  assert.match(out, /curl -X POST 'https:\/\/x\.test'/);
  assert.match(out, /-H 'X-H: v'/);
  // the apostrophe must be escaped as '\''
  assert.ok(out.includes(`'{"note":"Let'${BS}''s go"}'`));
});

// --- output filtering -------------------------------------------------------

test("matchesFilter: all, ok, and failed groups", () => {
  // "all" keeps everything, including network errors.
  for (const s of [0, 200, 204, 301, 404, 500]) {
    assert.equal(matchesFilter(s, "all"), true);
  }
  // "ok" is the 2xx range only — same rule as fetch's resp.ok.
  assert.equal(matchesFilter(200, "ok"), true);
  assert.equal(matchesFilter(299, "ok"), true);
  assert.equal(matchesFilter(301, "ok"), false);
  assert.equal(matchesFilter(500, "ok"), false);
  // "failed" is everything that isn't 2xx, network errors included.
  assert.equal(matchesFilter(500, "failed"), true);
  assert.equal(matchesFilter(404, "failed"), true);
  assert.equal(matchesFilter(301, "failed"), true);
  assert.equal(matchesFilter(0, "failed"), true);
  assert.equal(matchesFilter(200, "failed"), false);
});

test("matchesFilter: a single status code, and ERR for network failures", () => {
  assert.equal(matchesFilter(500, "500"), true);
  assert.equal(matchesFilter(200, "500"), false);
  // status 0 is what the server sends when fetch itself threw.
  assert.equal(matchesFilter(0, "ERR"), true);
  assert.equal(matchesFilter(500, "ERR"), false);
  // a network error is never counted as a status code
  assert.equal(matchesFilter(0, "0"), false);
});

test("filterBuckets: groups first, then status codes ascending with ERR last", () => {
  const results = [
    { status: 200 }, { status: 500 }, { status: 200 },
    { status: 0 }, { status: 401 }, { status: 500 }, { status: 200 },
  ];
  assert.deepEqual(filterBuckets(results), [
    { value: "all", label: "all (7)", count: 7, group: null },
    { value: "failed", label: "failed (4)", count: 4, group: "groups" },
    { value: "ok", label: "ok (3)", count: 3, group: "groups" },
    { value: "200", label: "200 (3)", count: 3, group: "status" },
    { value: "401", label: "401 (1)", count: 1, group: "status" },
    { value: "500", label: "500 (2)", count: 2, group: "status" },
    { value: "ERR", label: "ERR (1)", count: 1, group: "status" },
  ]);
});

test("filterBuckets: omits buckets that would be empty", () => {
  // A clean run offers no "failed" entry to pick.
  assert.deepEqual(filterBuckets([{ status: 200 }, { status: 204 }]), [
    { value: "all", label: "all (2)", count: 2, group: null },
    { value: "ok", label: "ok (2)", count: 2, group: "groups" },
    { value: "200", label: "200 (1)", count: 1, group: "status" },
    { value: "204", label: "204 (1)", count: 1, group: "status" },
  ]);
  // Before a run there is nothing to filter but "all".
  assert.deepEqual(filterBuckets([]), [
    { value: "all", label: "all (0)", count: 0, group: null },
  ]);
});

test("filterBuckets: keeps the active filter selectable when its bucket is empty", () => {
  // A sticky "failed" must survive a run where nothing failed — otherwise the
  // selection silently snaps back to "all" the moment the pane refreshes.
  assert.deepEqual(filterBuckets([{ status: 200 }], "failed"), [
    { value: "all", label: "all (1)", count: 1, group: null },
    { value: "failed", label: "failed (0)", count: 0, group: "groups" },
    { value: "ok", label: "ok (1)", count: 1, group: "groups" },
    { value: "200", label: "200 (1)", count: 1, group: "status" },
  ]);
  // Same for a status code this run didn't produce — and it still sorts by code.
  assert.deepEqual(filterBuckets([{ status: 200 }], "500"), [
    { value: "all", label: "all (1)", count: 1, group: null },
    { value: "ok", label: "ok (1)", count: 1, group: "groups" },
    { value: "200", label: "200 (1)", count: 1, group: "status" },
    { value: "500", label: "500 (0)", count: 0, group: "status" },
  ]);
  // An emptied pane still offers whatever filter is active.
  assert.deepEqual(filterBuckets([], "ERR"), [
    { value: "all", label: "all (0)", count: 0, group: null },
    { value: "ERR", label: "ERR (0)", count: 0, group: "status" },
  ]);
  // "all" forces nothing extra.
  assert.deepEqual(filterBuckets([{ status: 200 }], "all").map((b) => b.value), ["all", "ok", "200"]);
});
