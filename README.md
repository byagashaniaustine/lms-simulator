# LMS Simulator

Standalone Deno app that mimics **Fineract** driving device tiers. Push every
Android / iPhone through all six loan-device tiers from a web UI — without
touching a real device, Zoho, or a live Fineract.

Previously lived under `mdm-platform/lms-simulator/`; moved out so the console
repo stays production-focused and the sim can be deployed on its own.

## Modes

**Sandbox** (set `SIM_SANDBOX_ONLY=true`). In-memory engine only, regardless
of what other env vars are set. `/api/available-devices` returns empty,
adding real devices is rejected. Safe for public URLs — nothing can mutate
Supabase or the backend. **Use this for the deployed demo.**

**Offline** (default, no env). Same engine, but the UI still exposes the
"+ Real device" controls — they just won't find Supabase credentials and
show empty. Local dev before you have creds.

**Live**. Pulls real devices from Supabase, writes `loan_links` rows, and
POSTs signed Fineract-shaped webhooks at the backend. Trips the full apply
path end to end. Needs:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `FINERACT_WEBHOOK_SECRET` (must match the backend's)
- `BACKEND_URL` (defaults to `http://localhost:8000`)
- `SIM_SANDBOX_ONLY` **must be absent or `false`**

Copy `.env.example` → `.env` and fill the fields you want.

### Deno Deploy (public URL)

Set these env vars in the dashboard:

- `SIM_SANDBOX_ONLY=true`

That's it. Everything else can be absent; the sim renders its UI and runs
the tier engine, nothing hits Supabase or the backend. The mode pill shows
`SANDBOX` and the "+ Real device" controls are hidden.

## Run

```bash
deno run --allow-net --allow-read --allow-env --env-file=.env server.ts
```

Open <http://localhost:8010>. Change the port with `SIM_PORT=8020 deno run …`.

No dependencies, no build step — plain `Deno.serve` + static files.

## How the two modes present

- **Sandbox phones** get a dashed `SIM` pill. Signals are purely local — the
  tier engine runs, the feed shows what it decided, nothing leaves the sim.
- **Real-device phones** get a solid `LIVE · SIM-00000N` pill. Every action
  writes to `loan_links` and signs a POST to
  `{BACKEND_URL}/api/fineract/hooks`. The backend reconcile runs for real:
  Zoho group moves + announcement sends per `tier_announcements`.

## What's inside

- `server.ts` — tier engine + API + static server (plain `Deno.serve`).
- `public/index.html` + `app.js` + `styles.css` — the UI. Modern dark theme,
  Inter + JetBrains Mono fonts, timeline-style signal feed, toasts.
- `.env.example` — the full env surface.

## The six tiers

`Undisbursed → Disbursed → Due 2D → Overdue 2D → Locked` (→ `Released` on
payment).

Android `Overdue 2D` = payment-only kiosk + block installs; iPhone (supervised)
= restrictions + lockscreen notice; unsupervised iPhone = announcement only.
Lock + release work on both.

`server.ts::tierFor()` is **identical in behavior** to the backend's
`services/bridge/tiers.ts` so decisions you see here match what the production
reconcile would produce.

## Thresholds (per product)

| Product | Due-soon | Overdue 2D | Locked |
|---|---|---|---|
| 7-Day  | T-2 | DPD 2 | DPD 3 |
| 14-Day | T-2 | DPD 2 | DPD 3 |
| 28-Day | T-2 | DPD 2 | DPD 3 |

`L=3` is an operator override (72h past due uniformly across products). Spec
defaults were 5/8/15; see the backend's `tiers.ts` for the authoritative values.

## Important

- Sandbox state is **in-memory** — restarting the sim wipes offline phones.
  Live-mode state is backed by Supabase.
- The sim never calls Zoho, the console, or Fineract directly. In live mode it
  writes `loan_links` + signs webhooks; the backend owns everything after that.
- `FINERACT_WEBHOOK_SECRET` must match exactly between sim and backend. A
  mismatch gets a 401 at the ingress with no body — easy to miss.
