# Tally

An offline-first expense tracker: an installable PWA that keeps working with no
connection, queues writes on the device, and syncs them when the network comes
back. When two devices change the same field of the same entry, a person is
asked which value wins — nothing is silently overwritten.

<p align="center">
  <img src="screenshots/offline.png" width="31%" alt="Cold start with the network off, showing one queued write" />
  <img src="screenshots/conflict.png" width="31%" alt="A conflict card showing this device's value and the server's value side by side" />
  <img src="screenshots/synced.png" width="31%" alt="Everything synced" />
</p>

FastAPI on the server (SQLite locally, Supabase Postgres when hosted), React +
TypeScript on the device, one hand-written service worker. Sign-in is Supabase
Auth, and every row belongs to one account. An entry is `occurred_on`, `amount_cents`,
`category`, `merchant`, `note` — amounts are integer cents, never floats.

## Running it

Verified on Python 3.14 and Node 24 on Windows. Lower versions probably work
but were not tested; the one hard floor is SQLite 3.35+, for
`UPDATE ... RETURNING`.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements-dev.txt   # Windows
# .venv/bin/python -m pip install -r backend/requirements-dev.txt     # macOS / Linux

cd frontend && npm install && npm run build && cd ..

cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

The frontend needs a Supabase project to sign in against: put
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `frontend/.env.local`
before building, and set `SUPABASE_URL` for the backend so it can check tokens
(plus `SUPABASE_JWT_SECRET` if the project still signs with a shared secret).
For backend-only work, `TALLY_DEV_USER=<name>` makes every request without a
token run as that user.

Then open <http://localhost:8000>.

Build the frontend first — with no `frontend/dist`, `/` returns a 503 telling
you to build rather than an app. Serving the built frontend from the Python
process is deliberate: a service worker only controls pages on its own origin,
so same-origin hosting is what makes the offline shell work at all. Add
`--host 0.0.0.0` to reach it from a phone on the same network, and set
`TALLY_DATABASE_URL` to move the database off its default
(`backend/data/tally.db`).

For frontend work, `npm run dev` serves Vite on :5173 and proxies `/api` to
:8000. It skips the service worker build step, so test install and offline
behaviour against the built app on :8000 instead.

Installing on a real phone needs HTTPS — Chrome only treats plain HTTP as a
secure context on localhost — so put it behind a tunnel (`cloudflared tunnel
--url http://localhost:8000`) or a proxy with a certificate. The queue, the
conflict handling and the offline shell all work fine over plain HTTP.

## Deploying

It runs on Vercel: `vercel.json` builds the frontend for the CDN and sends
`/api/*` to `api/index.py`, which serves the FastAPI app as a function. Same
origin, so the service worker still controls the page. Set these on the
Vercel project:

| Variable | What it is |
| --- | --- |
| `TALLY_DATABASE_URL` | Supabase Postgres, through the connection pooler |
| `TALLY_DB_SCHEMA` | a Postgres schema of Tally's own, not exposed by Supabase's Data API |
| `SUPABASE_URL` | for checking sign-in tokens against the project's published keys |
| `SUPABASE_JWT_SECRET` | only for projects that still sign with a shared secret |
| `TALLY_ALLOWED_USERS` | comma-separated user ids allowed in; the Supabase project is shared with another app |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | baked into the frontend build; public by design |
| `VITE_ALLOW_SIGNUP` | `true` to show a sign-up option |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | from dashboard.plaid.com; without them the Banks panel stays hidden |
| `PLAID_ENV` | `sandbox` (test banks, the default) or `production` |
| `TALLY_SECRET_KEY` | any long random string; encrypts stored bank logins. Changing it disconnects every bank |
| `PLAID_REDIRECT_URI` | production only: this app's `/`, registered in the Plaid dashboard, for banks that sign in on their own site |
| `PLAID_WEBHOOK_URL` | optional; otherwise worked out from the request |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | the notification key pair; `python tools/make_vapid_keys.py` makes one. A new pair means every device turns notifications on again |
| `VAPID_SUBJECT` | `mailto:` an address push services can reach |
| `CRON_SECRET` | any long random string; Vercel Cron signs the daily reminder run with it |

On Vercel the backend refuses to start without `TALLY_DATABASE_URL` rather than
fall back to SQLite on a read-only disk. Then `vercel deploy --prod`.

## Banks

Connecting a bank goes through Plaid Link. The server keeps the login
(encrypted) and turns new transactions into ops from a device called `bank`,
pushed through the same protocol as a phone's: they reach every device on its
next pull, and an offline edit made meanwhile merges with them or conflicts as
usual. The rules are in `backend/app/banking.py`:

- Only money going out comes in. Income, refunds, transfers between accounts
  and credit card payments are skipped (the card's purchases already count).
- A bank charge with the same amount as an expense typed in within 3 days is
  **matched** to it: the typed-in entry gets a bank label and keeps its own
  merchant, date and amount. Otherwise it becomes a new entry.
- A pending charge that posts keeps its entry, so edits carry over; an
  imported entry follows the bank's final amount (a tip, say). A pending
  charge that drops off deletes the imported entry, or unlinks a matched one.
- New transactions arrive by Plaid webhook (signature-checked) and on each
  app open. That's as live as banks get: Plaid checks most of them a few
  times a day.
- **Subscriptions** come from Plaid's recurring-transactions product when the
  account has it, and otherwise from the ledger itself: the same merchant at
  a steady price and gap.
- **Moving your own money isn't spending.** Besides what Plaid labels a
  transfer, money that leaves one connected account and arrives in another
  (same amount, within 4 days, one side reading like a transfer) is left out,
  and taken back out if it was imported before the other side arrived. For
  accounts that aren't connected, marking one bank expense as a transfer makes
  a rule from the bank's description: it, its look-alikes and future ones go.
  The Spending tab asks about bank charges that read like transfers, and
  before a rule is made it says what else it would catch - an e-Transfer to
  yourself and one to a friend can be described the same way.
- **Subscriptions can be added by hand**, and replace a detected one with
  the same name. Their renewal date rolls forward by their frequency.
- **Credit scores are entered by hand.** No bank or Plaid API offers a
  consumer's score (in Canada it's Equifax and TransUnion, with no consumer
  API), so the Money tab keeps a history of the ones you enter, next to card
  utilisation worked out from the connected cards.
- **Notifications** (Web Push; on an iPhone only from the Home Screen):
  the day before a subscription renews, from a once-a-day Vercel Cron at
  14:00 UTC, and when a new bank charge matches a subscription. Each is sent
  once; devices that have gone away are forgotten.
- **Budgets** are monthly limits per category, shown against spending on the
  Spending tab. Reaching 80% and going over each notify once a month,
  checked after every push and bank import.
- **Money in** comes from the banks: income (what Plaid calls income) is
  counted; other money arriving is shown but not counted; moves from your
  own connected accounts and payments onto cards are left out. The Spending
  tab sets it against the month's spending, over six months.
- **Leftovers:** expenses from a bank that has since been disconnected (a
  test bank, say) are offered for removal on the Money tab.
- **Balances** (the Money tab) are the ones Plaid sends with each sync. A
  credit card or loan's balance counts as owed, anything else as yours.

The app has four tabs: Expenses (the ledger), Spending (each month by
category, worked out on the device so it works offline), Subscriptions (by
next renewal) and Money (have vs owe, accounts, connected banks). Balances
and subscriptions are cached on the device for showing with no signal.

## Trying the conflict behaviour

Open the **Try the sync behaviour** panel at the bottom of the app. It has a
*Simulate offline* switch plus buttons that make the server act as a second,
already-synced device, so no second phone and no devtools are needed.

- **Conflict:** go offline → edit an amount → *another device edits the amount*
  → go back online. Same field, so you get asked.
- **Auto-merge:** the same, but edit the *note* instead. Different fields, so
  both edits survive and nobody is interrupted.

## How sync works

Nothing writes straight to the server. A tap appends an **op** to an outbox in
IndexedDB, and the UI renders the last server snapshot with the outbox replayed
on top — so a write appears instantly and survives being killed offline. Every
op carries a `base_rev`: *"the newest version of this entry I had seen was N."*

The server answers each op with one of five statuses:

| Status | When | Effect |
| --- | --- | --- |
| `applied` | `base_rev` was current | clean fast-forward |
| `merged` | stale, but you and the server touched **different** fields | both edits kept |
| `conflict` | stale **and** the same field, or delete vs. edit | nothing applied, both versions returned |
| `invalid` | unknown entry or a bad field value | rejected |
| `blocked` | an earlier op in the same batch conflicted | deferred until that one is resolved |

`merged` is possible because the server keeps an append-only log of which
fields changed at which revision (`entry_changes`), so given your `base_rev` it
can intersect what moved while you were away with what you changed. Conflicts
are parked in a local `conflicts` store and shown as a card with both values;
resolving builds a fresh op against the revision the server *actually* holds,
so it lands first try.

Retries are idempotent: every result, conflicts included, is stored per `op_id`
in `applied_ops` and replayed, so a push whose response got lost does not apply
twice. The outbox is compacted before each push — repeated edits to one entry
collapse into one op, and an entry created *and* deleted while offline is never
sent at all. Deletes are tombstones with revisions, so a deletion propagates
instead of the entry reappearing on the next pull.

## Layout

```
backend/
  app/sync.py        the protocol: conflict detection, merging, cursors
  app/models.py      entries, per-revision change log, idempotency ledger
  app/schemas.py     field schema and patch validation
  app/main.py        endpoints + static hosting for the built PWA
  tests/             protocol tests and two-device narratives
frontend/
  public/sw.js       the service worker (~150 lines, no Workbox)
  scripts/           post-build service worker stamping
  src/lib/           sync engine, outbox compaction, IndexedDB, transport
  src/components/    sync bar, entry list, conflict cards, install banner
tools/
  make_icons.py      PNG icon generation using only the stdlib
  smoke_test.py      HTTP-level end-to-end checks
  browser_check.mjs  real-Chromium checks
  check_all.py       run everything
```

## Tests

```bash
python tools/check_all.py      # everything below, in order
```

| Suite | Count | Covers |
| --- | --- | --- |
| `cd backend && pytest` |  | the protocol, every conflict path, idempotency, two-device stories, keeping accounts apart, bank import and webhooks |
| `cd frontend && npm test` | 39 | the client engine: queueing, restart durability, lost responses, compaction, resolution |
| `python tools/smoke_test.py` | 34 | a real uvicorn process over HTTP: app shell, SPA fallback, SW and manifest headers, asset caching, push/pull |
| `node tools/browser_check.mjs` | 34 | real Chromium: SW install, installability, offline cold start, conflict resolution end to end |

All four pass; the counts are from an actual run, not aspirations. The
browser check signs in for real: it builds the app against a stand-in
Supabase project, runs the server with a throwaway signing secret, and
starts the page with a session holding a token signed with it. The browser
check starts its own server, writes an expense with the network off, reloads
*while still offline*, reconnects, watches the queue drain, then drives a
conflict through to resolution — and produces the screenshots above. It needs
Chromium (`cd frontend && npx playwright install chromium`); `check_all.py`
skips it if Playwright is absent.

## Surprising things

- **The sync protocol is implemented twice.** The vitest suite drives the
  engine against a `MemoryStore` and `src/lib/testing/fakeServer.ts`, ~400
  lines that reimplement the Python conflict rules in TypeScript. It makes the
  client testable in plain Node, but the two can drift, and nothing but
  `smoke_test.py` and `browser_check.mjs` would notice. It also means
  **IndexedDB, the real HTTP transport and the service worker are not covered
  by the unit tests at all** — only by the browser check.
- **`/api/demo/*` is off unless `TALLY_DEMO=1`.** It exists so the conflict
  UI can be demonstrated from one browser, and the "Try the sync behaviour"
  panel only shows when it's on. The tests and checks switch it on; the
  hosted app leaves it off. There's no CORS: the app and API share an origin.
- **`server_notes` is dead code.** `models.py` declares a `ServerNote` table
  whose docstring claims the demo endpoints and health checks use it. Nothing
  references it; the table is created and stays empty.
- **`navigator.onLine` is treated as a hint, not proof** — it reads true on a
  captive portal. Being offline is a UI state; only a server actually refusing
  is an error. Pushes are triggered by the `online` event, tab visibility, a
  30-second interval, and a Background Sync nudge.
- **Background Sync only wakes a live page.** The push logic lives in the page,
  not the worker, so with no client alive the queue waits for the app to be
  opened. Chromium-only; elsewhere the three triggers above cover it.
- **The service worker is stamped after the build.** Vite copies `public/sw.js`
  through untouched, then `scripts/finalize-sw.mjs` fills in the precache
  manifest and a version hashed from `dist`, so an identical rebuild does not
  invalidate every client's cache. It throws if run twice on the same output.
- **Compaction discards intermediate history.** Ten offline edits to one amount
  arrive as one op: current intent survives, keystrokes do not.
- **Conflicts are per field, not per character.** Two people editing the same
  note get asked which note they want; there is no three-way text merge.

## Limits

Decisions made without being able to ask, and what a real deployment would need
next:

- **One ledger per account, no sharing.** Every table is keyed by `user_id`
  first, and the pull cursor is per user. Two people can't share a household
  ledger yet.
- **Plaid is faked in the tests.** `test_bank.py` scripts Plaid's responses;
  nothing in the suite talks to Plaid's sandbox.
- **No migrations.** Tables are created on startup if missing; a schema change
  to an existing database has to be applied by hand.
- **Nothing is ever purged.** Tombstones and the `entry_changes` and
  `applied_ops` logs grow forever — fine at household scale, but not a
  retention policy. Pull is a cursor scan over `entries`, 200 rows a page
  (max 500).
- **The expense domain is a thin layer.** The sync machinery is field-generic:
  bodies are JSON validated against one schema (`backend/app/schemas.py`,
  `frontend/src/lib/fields.ts`), so swapping expenses for workouts means
  editing that schema, not the protocol.
