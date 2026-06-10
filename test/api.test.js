import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../server.js";

const BS = "\\";

// A local echo server: replies with JSON describing the request it received.
// Keeps the integration test fully offline (no httpbin).
function startEcho() {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, hits: () => hits }));
  });
}

// POST /api/run and parse the NDJSON stream into message objects.
async function runApi(apiPort, payload) {
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

test("api /api/run", async (t) => {
  const apiSrv = app.listen(0, "127.0.0.1");
  await new Promise((r) => apiSrv.once("listening", r));
  const apiPort = apiSrv.address().port;
  const echo = await startEcho();
  const target = `http://127.0.0.1:${echo.port}`;
  t.after(() => { apiSrv.close(); echo.srv.close(); });

  await t.test("iterates an array of data rows", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl ${target}/x/{{id}} -H 'X-Tag: {{tag}}'`,
      vars: JSON.stringify([{ id: 1, tag: "a" }, { id: 2, tag: "b" }]),
      delayMs: 0,
    });
    const results = msgs.filter((m) => m.type === "result");
    assert.equal(results.length, 2);
    const echoed = results.map((r) => JSON.parse(r.body));
    assert.deepEqual(echoed.map((e) => e.url), ["/x/1", "/x/2"]);
    assert.deepEqual(echoed.map((e) => e.headers["x-tag"]), ["a", "b"]);
    assert.equal(msgs.at(-1).type, "done");
  });

  await t.test("repeats a single set `count` times", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl ${target}/once`,
      vars: "{}",
      count: 3,
      delayMs: 0,
    });
    assert.equal(msgs.filter((m) => m.type === "result").length, 3);
    assert.equal(msgs.find((m) => m.type === "start").runs, 3);
  });

  await t.test("count is ignored when data has multiple rows", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl ${target}/x/{{id}}`,
      vars: JSON.stringify([{ id: 1 }, { id: 2 }]),
      count: 5,
      delayMs: 0,
    });
    assert.equal(msgs.filter((m) => m.type === "result").length, 2);
  });

  await t.test("globals merge in; row data wins on a clash", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl ${target}/g -H 'Authorization: Bearer {{token}}' -H 'X-Tok: {{token}}'`,
      vars: JSON.stringify([{}, { token: "ROW" }]),
      globals: { token: "GLOBAL" },
      delayMs: 0,
    });
    const echoed = msgs.filter((m) => m.type === "result").map((r) => JSON.parse(r.body));
    assert.equal(echoed[0].headers.authorization, "Bearer GLOBAL");
    assert.equal(echoed[1].headers.authorization, "Bearer ROW");
  });

  await t.test("dry run previews without sending", async () => {
    const before = echo.hits();
    const msgs = await runApi(apiPort, {
      curl: `curl -X DELETE ${target}/danger/{{id}}`,
      vars: JSON.stringify([{ id: 1 }, { id: 2 }]),
      dryRun: true,
      delayMs: 0,
    });
    const dry = msgs.filter((m) => m.type === "dry");
    assert.equal(dry.length, 2);
    assert.equal(dry[0].url, `${target}/danger/1`);
    assert.equal(echo.hits(), before, "dry run must not hit the target");
  });

  await t.test("undefined vars are pruned, spaces preserved (bug regression)", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl -X POST '${target}/notes?account_events_id={{account_events_id}}&keep=1' ` +
        `-H 'X-Drop: {{gone}}' -d '{"account_id":{{account_id}},"note":"Note runner test"}'`,
      vars: "{}",
      delayMs: 0,
    });
    const e = JSON.parse(msgs.find((m) => m.type === "result").body);
    assert.equal(e.url, "/notes?keep=1");
    assert.equal(e.headers["x-drop"], undefined);
    assert.equal(e.body, `{"note":"Note runner test"}`);
  });

  await t.test("ANSI-C quoted curl runs correctly without analyze (bug regression)", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl ${target}/ansi --data-raw $'{"note":"Let${BS}'s test ${BS}u0021"}'`,
      vars: "{}",
      delayMs: 0,
    });
    const e = JSON.parse(msgs.find((m) => m.type === "result").body);
    assert.equal(e.body, `{"note":"Let's test !"}`);
    assert.equal(e.method, "POST");
  });

  await t.test("invalid variables JSON returns a helpful error", async () => {
    const msgs = await runApi(apiPort, {
      curl: `curl ${target}/x`,
      vars: `{"a":1},{"a":2}`,
      delayMs: 0,
    });
    assert.equal(msgs[0].type, "error");
    assert.match(msgs[0].message, /missing the surrounding \[ \]/);
  });

  await t.test("missing URL returns an error", async () => {
    const msgs = await runApi(apiPort, { curl: "curl -X POST", vars: "{}" });
    assert.equal(msgs[0].type, "error");
    assert.match(msgs[0].message, /No URL/);
  });
});
