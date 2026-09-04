# Contributing

Bug reports, ideas, and pull requests are all welcome. It's a small tool — no
CLA, no template to fill in, no style bikeshedding.

## Getting set up

```bash
make local     # installs deps, runs with hot-reload on http://localhost:2875
make test      # the whole suite (node --test)
```

Node 20+ for the non-Docker path. There is **no build step**: `public/` is plain
ESM served as-is, so a browser refresh picks up UI edits. `make local` watches
`server.js` and restarts it for you.

## The one rule that isn't obvious

`public/lib.js` is imported by **both** `server.js` and the browser
(`public/app.js`). So anything in it must run in either environment:

- no DOM (`document`, `window`, `localStorage`)
- no Node APIs (`fs`, `path`, `process`)
- no dependencies

This isn't style — it's load-bearing. `lib.js` exists because the client and
server each used to have their own curl tokenizer, and they drifted: a Chrome
"Copy as cURL" command worked through the Analyze button and broke when run
directly, because only one of the two tokenizers understood bash `$'...'`
quoting. One tokenizer, no drift.

So when you add logic:

| Kind of code | Where it goes |
| ------------ | ------------- |
| Parsing, substitution, formatting, anything pure | `public/lib.js` |
| DOM wiring, event handlers, rendering | `public/app.js` |
| The run loop, streaming, HTTP | `server.js` |

If you find yourself wanting `document` inside `lib.js`, the logic wants
splitting: the pure part goes in `lib.js`, the part that touches the page stays
in `app.js`.

## Tests

The suite runs on `node --test` with **zero dependencies**, and it stays that
way — please don't add a test framework.

- `test/lib.test.js` — unit tests for the pure logic. New behaviour in `lib.js`
  belongs here.
- `test/api.test.js` — integration tests that mount the Express app on an
  ephemeral port and drive `/api/run` against a local echo server.

Every bug fixed so far has a regression test named for it; if you fix one,
please add the case that would have caught it. DOM wiring in `app.js` is not
unit-tested (no jsdom, on purpose) — verify UI changes in a browser and say what
you checked in the PR.

CI runs `npm test` on every push and pull request.

## Pull requests

- Keep a PR to one change; separate commits for separate concerns.
- Commit subjects are imperative and unprefixed — `Add a status filter`, not
  `feat: add status filter`. Bodies explain *why*, not just what.
- Update the README if you change behaviour someone would notice.
- Make sure `make test` passes before you push.

## Comments

Existing comments explain *why* a thing is the way it is, often citing the bug
that forced it — see the NUL marker in `stripUnresolvedBodyFields`, or why the
run loop listens for `close` on the response rather than the request. Please
match that: skip the comments that restate the code, keep the ones a future
reader would otherwise have to rediscover the hard way.
