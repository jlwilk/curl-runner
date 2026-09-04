# Security

## Reporting a vulnerability

Please report privately rather than opening a public issue: go to the
[Security tab](https://github.com/jlwilk/curl-runner/security/advisories) and
choose **Report a vulnerability**. That opens a private advisory only you and
the maintainer can see.

Include what you did, what happened, and what you expected. A curl command that
reproduces it is ideal. I'll acknowledge within a week; since this is a
spare-time project, please don't expect a same-day turnaround.

## What this tool does by design

curl-runner takes a `curl` command you paste and runs it server-side, with
whatever credentials you put in it. That means several alarming-sounding
behaviours are the entire point, not bugs:

- **It makes arbitrary outbound requests**, to any host, with any method,
  headers, and body you give it.
- **It holds credentials.** Shared variables — typically a bearer token — are
  kept in the browser's `localStorage` so a refresh doesn't wipe your session.
- **It has no authentication.** Anyone who can reach the port can use it.

The last two are why the README says to run it **locally**, or on a trusted,
access-controlled host. Exposed to the internet, it is an open request proxy
that will happily attack third parties on a stranger's behalf. Don't do that.

So please don't report "it sends requests to any URL" or "there's no login" —
those are documented properties. What follows is the part worth reporting.

## In scope

- **Escaping bugs in the output pane.** Response bodies, headers, URLs and
  error text all flow into the DOM. Anything that turns a response — or a
  pasted curl — into executing script is a real bug. (One of these was fixed
  in `addRun`, where the request method and fetch error text reached
  `innerHTML` unescaped.)
- **Leaking stored variables.** Any path by which a token in the chip bar
  reaches a host you didn't name in your curl.
- **Server-side flaws** in `/api/run` or the static file serving: path
  traversal out of `public/`, crashes reachable from a request body, a way to
  make the server read local files or hit its own filesystem.
- **Container issues** — anything in the image that widens exposure beyond the
  published port.

## Keeping your own use safe

- Bind it to localhost. If you must run it on a shared host, put it behind
  authentication and don't expose the port.
- Don't commit real tokens. Paste them into the variables bar at runtime — that
  is what it's for, and `.env` is already gitignored.
- Use **⌁ Dry run** before firing a batch of destructive requests; it shows the
  fully-substituted URLs, headers and bodies without sending anything.
- Remember `↺ reset all` clears the stored variables, including tokens, from
  the browser.

## Supported versions

The latest release on `main`. There are no maintenance branches — fixes land on
`main` and go out in the next release.
