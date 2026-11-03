// LMS Simulator — Fineract stand-in for the loan→device automation pipeline.
//
// Two modes, picked automatically from env:
//   • Offline: in-memory phones + tier engine only. The classic teaching rig.
//   • Live   : reads real devices from Supabase, writes real loan_links rows,
//              and POSTs signed webhooks to the real backend. The backend runs
//              its reconcile pipeline (device_tier_state, automation_runs) in
//              dry-run — Zoho is never called.
//
// Live mode activates when SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// FINERACT_WEBHOOK_SECRET are all set. Otherwise the UI explains it is offline.
//
// Run (from this directory):
//   ./start.sh
//   # or:  deno run --allow-net --allow-read --allow-env --env-file=.env server.ts
// Open: http://localhost:8010

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PORT = Number(Deno.env.get("PORT") ?? Deno.env.get("SIM_PORT") ?? 8010);
const DIR = new URL("./public/", import.meta.url);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("FINERACT_WEBHOOK_SECRET") ?? "";
// Shared secret for callbacks FROM the backend (PR 3). Verified via
// X-MDM-Signature HMAC-SHA256 header. Blank → callback endpoint 503s so the
// backend's retry queue holds delivery.
const CALLBACK_SECRET = Deno.env.get("SIM_CALLBACK_SECRET") ?? "";
const BACKEND_URL = (Deno.env.get("BACKEND_URL") ?? "http://localhost:8000").replace(/\/$/, "");
const SIM_ENTERPRISE_ID = Deno.env.get("SIM_ENTERPRISE_ID") ?? "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";

// SANDBOX_ONLY: deployed public builds opt in to disable every live-mode path
// regardless of other env. The in-memory engine still runs — users can play
// with sandbox phones — but nothing writes to Supabase or posts webhooks.
// This is how we keep the public .deno.net URL safe to share.
const SANDBOX_ONLY = (Deno.env.get("SIM_SANDBOX_ONLY") ?? "").toLowerCase() === "true";

const LIVE = !SANDBOX_ONLY && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && WEBHOOK_SECRET);
const supa = LIVE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const mode = SANDBOX_ONLY ? "SANDBOX" : LIVE ? "LIVE" : "OFFLINE";
console.log(`[sim] mode=${mode} backend=${BACKEND_URL} enterprise=${SIM_ENTERPRISE_ID}`);
if (SANDBOX_ONLY) {
  console.log(`[sim] SIM_SANDBOX_ONLY=true — all live-mode paths disabled. In-memory engine only.`);
} else if (!LIVE) {
  const missing = [
    !SUPABASE_URL && "SUPABASE_URL",
    !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
    !WEBHOOK_SECRET && "FINERACT_WEBHOOK_SECRET",
  ].filter(Boolean).join(", ");
  console.log(`[sim] offline — missing env: ${missing}. UI will show the in-memory engine only.`);
}

// ----------------------------------------------------------------- domain
const PRODUCTS: Record<number, { name: string; term: number; kSoft: number; L: number }> = {
  1: { name: "7-Day", term: 7, kSoft: 2, L: 5 },
  2: { name: "14-Day", term: 14, kSoft: 2, L: 8 },
  3: { name: "28-Day", term: 28, kSoft: 2, L: 15 },
};
type Tier = "undisbursed" | "disbursed" | "due_2d" | "overdue_2d" | "locked" | "released";

type Loan = {
  productId: number;
  disbursedOn: number;    // sim day of disbursement (day 0 = disburse day)
  dueOn: number;          // sim day the balloon is due
  status: "active" | "closed";
  paidOn?: number;        // sim day of repayment
  fineractLoanId: string; // "SIM-000001" style, also the loan_links.fineract_loan_id
  loanLinkRowId?: string; // loan_links.id, used for UPDATE on repay/reset
};
type Phone = {
  id: string;              // in live mode: real devices.id (uuid). offline: short random id.
  name: string;
  platform: "android" | "ios";
  supervised: boolean;
  day: number;             // this phone's own clock
  loan: Loan | null;
  tier: Tier;
  externalId: string;      // "SIM-<serial>" in live mode; blank offline
  live: boolean;           // true if this phone is backed by a real device + supa writes
  // Debtor identity set by the sim's "register debtor" dashboard. Carried on
  // the webhook payload (loan.clientName, loan.clientEmail) → persisted to
  // loan_links on insertLink → read by backend fireReminderEmail for the
  // due_2d / overdue_2d payment-reminder emails.
  clientName?: string | null;
  clientEmail?: string | null;
  lastBackendResult?: unknown;
  // Last backend-driven terminal apply, surfaced from /api/mdm/callback (PR 3).
  // These let the sim's UI show "backend confirmed overdue_2d at 09:12" instead
  // of the sim's own tier guess. seenJobIds blocks duplicate deliveries.
  backendTier?: Tier | null;
  backendState?: "applied" | "dead";
  backendError?: string | null;
  backendAt?: string;      // ISO
  seenJobIds?: Set<string>;
};

const phones = new Map<string, Phone>();
type Signal = {
  ts: number;
  phone: string;
  platform: string;
  kind: "webhook" | "timer" | "backend";
  label: string;
  from: Tier;
  to: Tier;
  action: string;
  hook?: unknown;
  backend?: unknown;
};
const feed: Signal[] = [];
let seq = 1;
let simLoanCounter = 1;

// Tier engine — identical rules to backend/services/bridge/tiers.ts.
function tierFor(p: Phone): Tier {
  const loan = p.loan;
  if (!loan || p.day < loan.disbursedOn) return "undisbursed";
  if (loan.status === "closed" && loan.paidOn !== undefined && p.day >= loan.paidOn) return "released";
  const dpd = Math.max(0, p.day - loan.dueOn);
  const daysToDue = loan.dueOn - p.day;
  const th = PRODUCTS[loan.productId];
  if (dpd >= th.L) return "locked";
  if (dpd >= th.kSoft) return "overdue_2d";
  if (dpd >= 1) return "overdue_2d";
  if (daysToDue <= 2) return "due_2d";
  return "disbursed";
}

// Action text shown under each tier pill. Reflects what the backend actually
// does for this enterprise's tier_groups + tier_announcements wiring — the
// console puts the policy in Zoho groups, we just shift devices between them.
// Disbursed / Due-2D / Overdue-2D are announcement-only; Locked is where the
// profiles live; Released is a clean group (profiles detach on exit).
function action(tier: Tier, p: Phone): string {
  switch (tier) {
    case "undisbursed": return "baseline group · no action";
    case "disbursed":   return "move to Disbursed group · no profiles, no announcement";
    case "due_2d":      return "move to Due-2D group · fire Due-2D announcement";
    case "overdue_2d":  return "move to Overdue-2D group · fire Overdue-2D announcement";
    case "locked":
      return p.platform === "android"
        ? "move to lockedAndroids · push androidKiosk + AdroidRestrictions · fire Locked announcement"
        : "move to Locked · push payfirst + reset-cmd + banner1 · fire Locked announcement";
    case "released":
      return p.platform === "android"
        ? "move to ReleasedAndroids · profiles detach (clean group)"
        : "move to Released · profiles detach (clean group)";
  }
}

function dpd(p: Phone): number {
  return p.loan ? Math.max(0, p.day - p.loan.dueOn) : 0;
}

// Dar es Salaam ISO date — matches backend's todayDarISO; the backend recomputes
// its own, we only use ours to stamp loan_links.disbursed_on / due_on.
function todayDarISO(): string {
  const dar = new Date(Date.now() + 3 * 3_600_000);
  return `${dar.getUTCFullYear()}-${String(dar.getUTCMonth() + 1).padStart(2, "0")}-${String(dar.getUTCDate()).padStart(2, "0")}`;
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function daysBetweenISO(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// --- loan_links writes (live mode only) --------------------------------
async function closeActiveLink(deviceId: string): Promise<void> {
  if (!supa) return;
  const { error } = await supa.from("loan_links")
    .update({ status: "closed", closed_on: todayDarISO() })
    .eq("enterprise_id", SIM_ENTERPRISE_ID)
    .eq("device_id", deviceId)
    .eq("status", "active");
  if (error) console.log("[sim] closeActiveLink failed:", error.message);
}

async function insertLink(p: Phone, loan: Loan, iso: { disbursed: string; due: string }): Promise<string | null> {
  if (!supa) return null;
  const { data, error } = await supa.from("loan_links").insert({
    enterprise_id: SIM_ENTERPRISE_ID,
    device_id: p.id,
    fineract_loan_id: loan.fineractLoanId,
    fineract_client_id: "SIM",
    external_id: p.externalId,
    product_id: loan.productId,
    disbursed_on: iso.disbursed,
    due_on: iso.due,
    status: "active",
    client_name: p.clientName ?? null,
    client_email: p.clientEmail ?? null,
  }).select("id").single();
  if (error) {
    console.log("[sim] insertLink failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}

async function closeLinkById(linkId: string): Promise<void> {
  if (!supa) return;
  const { error } = await supa.from("loan_links")
    .update({ status: "closed", closed_on: todayDarISO() })
    .eq("id", linkId);
  if (error) console.log("[sim] closeLinkById failed:", error.message);
}

// --- signed webhook POST ------------------------------------------------
async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type FineractLoanSummary = {
  loanId: string;
  accountNo: string;
  clientId: string | null;
  clientName: string | null;
  clientEmail: string | null;
  productId: number;
  productName: string | null;
  status: "active" | "closed" | "written_off" | "overpaid" | "pending" | "approved" | "rejected" | "unknown";
  externalId: string | null;
  disbursedOn: string | null;
  dueOn: string | null;
  dpd: number;
  totalOutstanding: number;
};

type EnqueuedJob = { jobId: string; deviceId: string; loanId: string };
type ApplyJobStatus = {
  id: string;
  state: "pending" | "in_progress" | "applied" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  outcome?: unknown;
  error_code?: string | null;
  error_message?: string | null;
  completed_at?: string | null;
};
type WebhookResponse = { data?: {
  trigger?: string;
  kind?: string;
  source?: string;
  result?: { enqueued?: EnqueuedJob[]; applied?: unknown[]; [k: string]: unknown } | null;
  error?: string;
  note?: string;
  jobResults?: ApplyJobStatus[]; // populated by sim after polling, not from backend
} };

// Pace rapid-fire webhooks so the backend's `withLease("automation:<eid>")`
// (an in-process mutex) doesn't reject the second one with a null result.
// For non-localhost backends the extra latency between request completion and
// next-request start isn't guaranteed to cover the lease-release window — a
// background daily tick running in parallel can also hold the lease briefly.
// 600ms is enough breathing room without making the UI feel sticky.
const MIN_WEBHOOK_GAP_MS = /^(https?:\/\/)?(localhost|127\.)/.test(BACKEND_URL) ? 0 : 600;
let lastWebhookAt = 0;

// Poll a queued apply job (migration 016 / Level 2 async) until it settles.
// The backend's drainApplyQueue runs on the worker loop (~5s tick), so most
// jobs resolve in under 10s. We cap at ~30s to keep the sim UI responsive
// even if the worker is backed up — unresolved jobs show as "pending" and
// the next webhook catches up on the state via the normal reconcile flow.
async function pollApplyJob(jobId: string, deadlineMs: number): Promise<ApplyJobStatus | null> {
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/apply-jobs/${jobId}`);
      if (res.ok) {
        const body = await res.json();
        const job = body?.data as ApplyJobStatus | undefined;
        if (job && (job.state === "applied" || job.state === "failed" || job.state === "dead")) return job;
        if (job) {
          // non-terminal — keep polling, let the body fall through to the sleep
        }
      }
    } catch {
      // transient — try again
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function postWebhook(payload: {
  actionName: "DISBURSE" | "REPAYMENT" | "DAILY_TICK";
  loanId: string;
  loan: FineractLoanSummary;
}): Promise<WebhookResponse | { error: string }> {
  if (MIN_WEBHOOK_GAP_MS > 0) {
    const sinceLast = Date.now() - lastWebhookAt;
    if (sinceLast < MIN_WEBHOOK_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_WEBHOOK_GAP_MS - sinceLast));
    }
  }
  const body = JSON.stringify({
    entityName: "LOAN",
    actionName: payload.actionName,
    loanId: payload.loanId,
    loan: payload.loan,
  });
  const sig = await hmacHex(WEBHOOK_SECRET, body);
  let resp: WebhookResponse | { error: string };
  try {
    const res = await fetch(`${BACKEND_URL}/api/fineract/hooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Fineract-Signature": sig },
      body,
    });
    const text = await res.text();
    try { resp = JSON.parse(text) as WebhookResponse; }
    catch { resp = { error: `non-json http ${res.status}: ${text.slice(0, 200)}` }; }
  } catch (e) {
    resp = { error: `network: ${String(e)}` };
  } finally {
    lastWebhookAt = Date.now();
  }
  // Level 2: the webhook may 202 with `result.enqueued[]`. Follow each job to
  // its terminal state so the sim UI reflects what Zoho actually did.
  if ("data" in resp && resp.data?.result && Array.isArray((resp.data.result as { enqueued?: EnqueuedJob[] }).enqueued)) {
    const enq = (resp.data.result as { enqueued: EnqueuedJob[] }).enqueued;
    if (enq.length) {
      const deadline = Date.now() + 30_000;
      const settled = await Promise.all(enq.map((j) => pollApplyJob(j.jobId, deadline)));
      resp.data.jobResults = settled.filter((j): j is ApplyJobStatus => !!j);
    }
  }
  return resp;
}

function buildSummary(p: Phone, status: FineractLoanSummary["status"], disbursedISO: string, dueISO: string): FineractLoanSummary {
  const loan = p.loan!;
  const pr = PRODUCTS[loan.productId];
  return {
    loanId: loan.fineractLoanId,
    accountNo: `SIM-${loan.fineractLoanId}`,
    clientId: null,
    clientName: p.clientName ?? `SIM/${p.name}`,
    clientEmail: p.clientEmail ?? null,
    productId: loan.productId,
    productName: pr.name,
    status,
    externalId: p.externalId,
    disbursedOn: disbursedISO,
    dueOn: dueISO,
    dpd: dpd(p),
    totalOutstanding: status === "closed" ? 0 : 1_000_000,
  };
}

// --- phones -------------------------------------------------------------
function addOfflinePhone(platform: "android" | "ios"): Phone {
  const n = [...phones.values()].filter((p) => p.platform === platform && !p.live).length + 1;
  const id = crypto.randomUUID().slice(0, 8);
  const p: Phone = {
    id,
    name: `${platform === "android" ? "Android" : "iPhone"}-${n}`,
    platform,
    supervised: platform === "ios",
    day: 0,
    loan: null,
    tier: "undisbursed",
    externalId: "",
    live: false,
  };
  phones.set(id, p);
  return p;
}

async function addLivePhoneByDeviceId(deviceId: string, client?: { name?: string | null; email?: string | null }): Promise<Phone | null> {
  if (!supa) return null;
  const { data, error } = await supa.from("devices")
    .select("id, device_name, platform, serial_number, is_supervised, enterprise_id, is_removed")
    .eq("id", deviceId)
    .maybeSingle();
  if (error || !data) {
    console.log("[sim] addLivePhoneByDeviceId: device not found", error?.message);
    return null;
  }
  if (data.enterprise_id !== SIM_ENTERPRISE_ID) return null;
  if (data.is_removed) return null;
  const platform: "android" | "ios" = data.platform === "ios" ? "ios" : "android";
  const serial = (data.serial_number as string | null) || data.id.slice(0, 8);
  const existing = phones.get(data.id);
  const p: Phone = {
    id: data.id,
    name: data.device_name as string ?? `Device-${data.id.slice(0, 6)}`,
    platform,
    supervised: Boolean(data.is_supervised),
    day: existing?.day ?? 0,
    loan: existing?.loan ?? null,
    tier: existing?.tier ?? "undisbursed",
    externalId: `SIM-${serial}`,
    live: true,
    clientName: client?.name ?? existing?.clientName ?? null,
    clientEmail: client?.email ?? existing?.clientEmail ?? null,
  };
  phones.set(p.id, p);
  return p;
}

// Recompute tier; if it changed, record a signal with the given trigger metadata.
function record(p: Phone, kind: "webhook" | "timer" | "backend", label: string, extra: { hook?: unknown; backend?: unknown }, prevTier?: Tier) {
  const from = prevTier ?? p.tier;
  feed.unshift({
    ts: seq++,
    phone: p.name,
    platform: p.platform,
    kind,
    label,
    from,
    to: p.tier,
    action: action(p.tier, p),
    hook: extra.hook,
    backend: extra.backend,
  });
  if (feed.length > 160) feed.pop();
}

function reconcileLocal(p: Phone, kind: "webhook" | "timer", label: string, hook: unknown): Tier {
  const prev = p.tier;
  const next = tierFor(p);
  if (next !== prev) {
    p.tier = next;
    record(p, kind, label, { hook }, prev);
  }
  return next;
}

// --- Hook/event handlers (live-aware) ----------------------------------
async function disburse(p: Phone, productId: number) {
  const pr = PRODUCTS[productId] ?? PRODUCTS[1];
  // Local sim state
  p.day = 0;
  // Loan IDs include a UUID so they're globally unique across cold starts
  // and re-disburses. The backend keys events on `auto:<loan_id>:<tier>:<op>`;
  // if the same ID ever repeats, previous "succeeded" rows would dedup the
  // retry into a no-op (that's what caused the APPLY_MOVE_NOT_VISIBLE loop).
  const loanId = `SIM-${crypto.randomUUID().slice(0, 12)}`;
  simLoanCounter++;
  const disbursedISO = todayDarISO();
  const dueISO = addDaysISO(disbursedISO, pr.term);
  p.loan = { productId, disbursedOn: 0, dueOn: pr.term, status: "active", fineractLoanId: loanId };
  const hook = { entity: "LOAN", action: "DISBURSE", loanId, productId, product: pr.name, disbursedOnDate: disbursedISO, expectedMaturityDate: dueISO };
  reconcileLocal(p, "webhook", "Fineract hook · DISBURSE", hook);

  if (p.live && supa) {
    await closeActiveLink(p.id);
    const linkRowId = await insertLink(p, p.loan, { disbursed: disbursedISO, due: dueISO });
    if (linkRowId) p.loan.loanLinkRowId = linkRowId;
    const summary = buildSummary(p, "active", disbursedISO, dueISO);
    const resp = await postWebhook({ actionName: "DISBURSE", loanId, loan: summary });
    p.lastBackendResult = resp;
    record(p, "backend", "backend · DISBURSE", { backend: resp });
  }
}

async function advance(p: Phone, days: number) {
  if (!p.loan) return;
  p.day += days;
  const hook = { entity: "TIMER", day: p.day, dpd: dpd(p) };
  reconcileLocal(p, "timer", `daily tick · +${days}d → day ${p.day} (DPD ${dpd(p)})`, hook);
  await sendTick(p);
}

async function skipTo(p: Phone, to: "due" | "overdue" | "lock") {
  if (!p.loan) return;
  const th = PRODUCTS[p.loan.productId];
  p.day = to === "due" ? p.loan.dueOn - 2 : to === "overdue" ? p.loan.dueOn + th.kSoft : p.loan.dueOn + th.L;
  const hook = { entity: "TIMER", day: p.day, dpd: dpd(p) };
  reconcileLocal(p, "timer", `daily tick · jump to ${to} (day ${p.day}, DPD ${dpd(p)})`, hook);
  await sendTick(p);
}

async function sendTick(p: Phone) {
  if (!(p.live && supa && p.loan)) return;
  const disbursedISO = todayDarISO();
  const dueISO = addDaysISO(disbursedISO, PRODUCTS[p.loan.productId].term - p.loan.disbursedOn);
  // Shift disbursement back by `p.day` days so the backend's dueOn - today = our (dueOn - day).
  const simToday = disbursedISO;
  const simDisbursed = addDaysISO(simToday, -p.day);
  const simDue = addDaysISO(simDisbursed, PRODUCTS[p.loan.productId].term);
  const summary = buildSummary(p, "active", simDisbursed, simDue);
  const resp = await postWebhook({ actionName: "DAILY_TICK", loanId: p.loan.fineractLoanId, loan: summary });
  p.lastBackendResult = resp;
  record(p, "backend", `backend · DAILY_TICK (DPD ${summary.dpd})`, { backend: resp });
  // Suppress unused-local lint
  void dueISO;
}

async function repay(p: Phone) {
  if (!p.loan) return;
  p.loan.status = "closed";
  p.loan.paidOn = p.day;
  const hook = { entity: "LOAN", action: "REPAYMENT", loanId: p.loan.fineractLoanId, closed: true, paidOnDate: `day ${p.day}` };
  reconcileLocal(p, "webhook", "Fineract hook · REPAYMENT → CLOSED", hook);

  if (p.live && supa) {
    // POST webhook FIRST so resolveLoanToEnterprise (filters status='active')
    // still finds the loan_links row. Then close the row.
    const disbursedISO = todayDarISO();
    const dueISO = addDaysISO(disbursedISO, -1); // nominal; status closed carries the tier
    const summary = buildSummary(p, "closed", disbursedISO, dueISO);
    const resp = await postWebhook({ actionName: "REPAYMENT", loanId: p.loan.fineractLoanId, loan: summary });
    p.lastBackendResult = resp;
    record(p, "backend", "backend · REPAYMENT", { backend: resp });
    if (p.loan.loanLinkRowId) await closeLinkById(p.loan.loanLinkRowId);
    else await closeActiveLink(p.id);
  }
}

async function reset(p: Phone) {
  const prev = p.tier;
  const loanRef = p.loan;
  p.day = 0;
  p.loan = null;
  p.tier = "undisbursed";
  if (prev !== "undisbursed") record(p, "webhook", "reset → stock", { hook: { entity: "LOAN", action: "RESET" } }, prev);
  if (p.live && supa && loanRef?.loanLinkRowId) await closeLinkById(loanRef.loanLinkRowId);
  else if (p.live) await closeActiveLink(p.id);
}

// ----------------------------------------------------------------- http
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function viewPhone(p: Phone) {
  return {
    id: p.id,
    name: p.name,
    platform: p.platform,
    supervised: p.supervised,
    day: p.day,
    dpd: dpd(p),
    tier: p.tier,
    action: action(p.tier, p),
    product: p.loan ? PRODUCTS[p.loan.productId].name : null,
    dueOn: p.loan ? p.loan.dueOn : null,
    loanStatus: p.loan?.status ?? null,
    live: p.live,
    externalId: p.externalId,
    loanId: p.loan?.fineractLoanId ?? null,
    lastBackendResult: p.lastBackendResult ?? null,
    // Debtor identity set by the register-debtor dashboard; used by backend
    // reminder emails via loan_links.client_name/client_email.
    clientName: p.clientName ?? null,
    clientEmail: p.clientEmail ?? null,
    // Backend-driven apply result, delivered via POST /api/mdm/callback (PR 3).
    // These are the authoritative tier-state the MDM backend confirmed with
    // Zoho — the sim's own `tier` is just its local engine's guess.
    backendTier: p.backendTier ?? null,
    backendState: p.backendState ?? null,
    backendError: p.backendError ?? null,
    backendAt: p.backendAt ?? null,
  };
}

function state() {
  return {
    live: LIVE,
    sandbox: SANDBOX_ONLY,
    enterprise: SANDBOX_ONLY ? null : SIM_ENTERPRISE_ID,
    backend: SANDBOX_ONLY ? null : BACKEND_URL,
    phones: [...phones.values()].map(viewPhone),
    feed,
  };
}

async function listAvailableDevices() {
  if (!supa) return [];
  const { data, error } = await supa.from("devices")
    .select("id, device_name, platform, serial_number, is_supervised")
    .eq("enterprise_id", SIM_ENTERPRISE_ID)
    .eq("is_removed", false)
    .order("added_at", { ascending: false });
  if (error) {
    console.log("[sim] listAvailableDevices failed:", error.message);
    return [];
  }
  return data ?? [];
}

const CT: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css" };
async function serveStatic(path: string): Promise<Response> {
  const file = path === "/" ? "index.html" : path.replace(/^\//, "");
  try {
    const body = await Deno.readFile(new URL(file, DIR));
    const ext = file.split(".").pop() ?? "";
    return new Response(body, { headers: { "content-type": CT[ext] ?? "application/octet-stream", "cache-control": "no-cache" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/**
 * Deno Deploy cold-starts wipe module-memory. Live-mode users would otherwise
 * lose any device they'd added to the UI — but the authoritative state (active
 * loan_links in Supabase) is still there. On boot we re-list the enterprise's
 * active SIM-tagged loan_links, pull the device rows, and recreate each live
 * phone with its loan + synthetic `day` clock aligned to the current date.
 *
 * The sim's day/dpd are stored as integer offsets from the (synthetic) disburse
 * day. We reconstruct the clock from `today - loan_links.disbursed_on` so the
 * phone's displayed tier matches what the backend thinks is current.
 */
// Reconstruct a synthetic (day, loan.status, paidOn) tuple that makes tierFor()
// return the given tier. Used on cold-start rehydrate so the sim's displayed
// state matches the backend's device_tier_state.applied_tier instead of
// drifting with real wall-clock time (Deno Deploy cold-starts previously
// recomputed day = today - disbursed_on and produced phantom "regress to
// disbursed" webhooks that failed against the backend's actual tier).
function syntheticClockForTier(
  tier: Tier | null,
  pr: { term: number; kSoft: number; L: number },
): { day: number; status: "active" | "closed"; paidOn?: number } {
  switch (tier) {
    case "released":   return { day: pr.term, status: "closed", paidOn: pr.term };
    case "locked":     return { day: pr.term + pr.L, status: "active" };
    case "overdue_2d": return { day: pr.term + pr.kSoft, status: "active" };
    case "due_2d":     return { day: Math.max(0, pr.term - 2), status: "active" };
    case "disbursed":
    case "undisbursed":
    case null:
    default:           return { day: 0, status: "active" };
  }
}

async function hydrateLivePhonesFromSupabase(): Promise<void> {
  if (!supa) return;
  try {
    const { data: links, error } = await supa
      .from("loan_links")
      .select("id, device_id, fineract_loan_id, product_id, disbursed_on, due_on")
      .eq("enterprise_id", SIM_ENTERPRISE_ID)
      .eq("fineract_client_id", "SIM")
      .eq("status", "active");
    if (error) { console.log("[sim] hydrate: loan_links query failed:", error.message); return; }
    if (!links || !links.length) { console.log("[sim] hydrate: no active SIM loan_links"); return; }

    const deviceIds = links.map((l) => l.device_id);
    // Fetch devices and prior tier state in one round-trip pair. The tier state
    // is authoritative — if the backend has already moved the device to Locked,
    // we must present the sim in Locked, not whatever wall-clock would suggest.
    const [devRes, tierRes] = await Promise.all([
      supa.from("devices").select("id, device_name, platform, serial_number, is_supervised").in("id", deviceIds),
      supa.from("device_tier_state").select("device_id, applied_tier").in("device_id", deviceIds),
    ]);
    if (devRes.error) { console.log("[sim] hydrate: devices query failed:", devRes.error.message); return; }
    if (tierRes.error) console.log("[sim] hydrate: tier_state query failed (continuing):", tierRes.error.message);
    const devById = new Map((devRes.data ?? []).map((d) => [d.id, d]));
    const tierByDevice = new Map(
      (tierRes.data ?? []).map((t) => [t.device_id as string, t.applied_tier as Tier | null]),
    );

    let hydrated = 0;
    for (const link of links) {
      const dev = devById.get(link.device_id);
      if (!dev) continue;
      if (phones.has(dev.id)) continue; // already present (shouldn't happen on cold start, but safe)
      const productId = Number(link.product_id);
      const pr = PRODUCTS[productId] ?? PRODUCTS[1];
      const platform: "android" | "ios" = dev.platform === "ios" ? "ios" : "android";
      const serial = (dev.serial_number as string | null) || dev.id.slice(0, 8);
      const appliedTier = tierByDevice.get(dev.id) ?? null;
      const clock = syntheticClockForTier(appliedTier, pr);

      const p: Phone = {
        id: dev.id,
        name: (dev.device_name as string | null) ?? `Device-${dev.id.slice(0, 6)}`,
        platform,
        supervised: Boolean(dev.is_supervised),
        day: clock.day,
        loan: {
          productId,
          disbursedOn: 0,
          dueOn: pr.term,
          status: clock.status,
          paidOn: clock.paidOn,
          fineractLoanId: link.fineract_loan_id,
          loanLinkRowId: link.id,
        },
        tier: "undisbursed",
        externalId: `SIM-${serial}`,
        live: true,
      };
      p.tier = tierFor(p);
      phones.set(p.id, p);
      hydrated++;

      // Counter kept only for display / log noise — new loan IDs are UUIDs,
      // so collisions are impossible regardless of this value.
      simLoanCounter++;

      console.log(`[sim] hydrated: ${p.name} loan=${link.fineract_loan_id} applied=${appliedTier ?? "null"} day=${clock.day} tier=${p.tier}`);
    }
    if (hydrated) console.log(`[sim] hydrated ${hydrated} live phone(s)`);
  } catch (e) {
    console.log("[sim] hydrate failed:", String(e));
  }
}

if (LIVE) await hydrateLivePhonesFromSupabase();

Deno.serve({ port: PORT, onListen: () => console.log(`LMS Simulator on http://localhost:${PORT}`) }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/state") return json(state());

  // Loans dashboard (PR 3 of the Fineract integration). Lists loan_links for
  // this enterprise joined with the device + its observed tier state. One row
  // per linked loan, including a last_reminder_at scalar for the inbox-ping
  // audit trail.
  if (path === "/api/loan-links") {
    if (!supa) return json({ loans: [], note: "sim not in LIVE mode" });
    try {
      // No native joins through PostgREST that honor nulls on the dts side
      // the way we want; one scalar query + two side-lookups is clearer.
      const { data: links, error } = await supa.from("loan_links")
        .select("id, device_id, fineract_loan_id, fineract_client_id, client_name, client_email, product_id, disbursed_on, due_on, status, closed_on, created_at")
        .eq("enterprise_id", SIM_ENTERPRISE_ID)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      const deviceIds = [...new Set((links ?? []).map((l) => l.device_id).filter(Boolean))];
      const emails = [...new Set((links ?? []).map((l) => l.client_email).filter(Boolean))];

      const [devicesRes, tierRes, remRes] = await Promise.all([
        deviceIds.length ? supa.from("devices").select("id, device_name, platform").in("id", deviceIds) : Promise.resolve({ data: [] }),
        deviceIds.length ? supa.from("device_tier_state").select("device_id, applied_tier, observed_state, updated_at").in("device_id", deviceIds) : Promise.resolve({ data: [] }),
        emails.length    ? supa.from("events").select("params, updated_at").eq("action", "payment_reminder.email").in("params->>to", emails).order("updated_at", { ascending: false }).limit(500) : Promise.resolve({ data: [] }),
      ]);
      const devByIdM: Record<string, { device_name: string; platform: string }> = {};
      for (const d of (devicesRes.data ?? [])) devByIdM[d.id as string] = { device_name: d.device_name as string, platform: d.platform as string };
      const tierByDeviceM: Record<string, { applied_tier: string | null; observed_state: string | null; updated_at: string | null }> = {};
      for (const t of (tierRes.data ?? [])) tierByDeviceM[t.device_id as string] = { applied_tier: t.applied_tier as string | null, observed_state: t.observed_state as string | null, updated_at: t.updated_at as string | null };
      const lastReminderByEmail: Record<string, string> = {};
      for (const e of (remRes.data ?? [])) {
        const to = (e.params as { to?: string } | null)?.to;
        if (to && !lastReminderByEmail[to]) lastReminderByEmail[to] = e.updated_at as string;
      }

      const rows = (links ?? []).map((l) => ({
        id: l.id,
        fineract_loan_id: l.fineract_loan_id,
        fineract_client_id: l.fineract_client_id,
        client_name: l.client_name,
        client_email: l.client_email,
        product_id: l.product_id,
        disbursed_on: l.disbursed_on,
        due_on: l.due_on,
        status: l.status,
        closed_on: l.closed_on,
        created_at: l.created_at,
        device_id: l.device_id,
        device_name: devByIdM[l.device_id]?.device_name ?? null,
        platform: devByIdM[l.device_id]?.platform ?? null,
        applied_tier:    tierByDeviceM[l.device_id]?.applied_tier    ?? null,
        observed_state:  tierByDeviceM[l.device_id]?.observed_state  ?? null,
        tier_updated_at: tierByDeviceM[l.device_id]?.updated_at      ?? null,
        last_reminder_at: l.client_email ? (lastReminderByEmail[l.client_email] ?? null) : null,
      }));
      return json({ loans: rows });
    } catch (e) {
      console.log("[sim] /api/loan-links failed:", String(e));
      return json({ loans: [], error: String(e) }, 500);
    }
  }

  if (path === "/api/available-devices") {
    // Sandbox-only builds never expose the real device inventory.
    if (SANDBOX_ONLY) return json({ devices: [] });
    return json({ devices: await listAvailableDevices() });
  }

  if (path === "/api/phones" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (b.deviceId) {
      if (SANDBOX_ONLY) return json({ error: "sandbox build: real devices are disabled on this deployment" }, 412);
      if (!LIVE) return json({ error: "live mode is off; set SUPABASE/FINERACT env to use real devices" }, 412);
      // Debtor identity is optional on the API but required by the new register
      // dashboard. Accept whatever's provided and let empty strings pass as null.
      const name  = typeof b.clientName  === "string" && b.clientName.trim()  ? String(b.clientName).trim()  : null;
      const email = typeof b.clientEmail === "string" && b.clientEmail.trim() ? String(b.clientEmail).trim() : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "clientEmail is not a valid email address" }, 400);
      }
      const p = await addLivePhoneByDeviceId(String(b.deviceId), { name, email });
      if (!p) return json({ error: "device not found or not eligible" }, 404);
      return json(viewPhone(p), 201);
    }
    const platform = b.platform === "ios" ? "ios" : "android";
    return json(viewPhone(addOfflinePhone(platform)), 201);
  }

  const m = path.match(/^\/api\/phones\/([a-z0-9-]+)\/(hook|delete)$/i);
  if (m && req.method === "POST") {
    const p = phones.get(m[1]);
    if (!p) return json({ error: "not found" }, 404);
    if (m[2] === "delete") {
      // best-effort close live link
      if (p.live && supa) await closeActiveLink(p.id);
      phones.delete(p.id);
      return json({ ok: true });
    }
    const b = await req.json().catch(() => ({}));
    switch (b.type) {
      case "disburse": await disburse(p, Number(b.productId) || 1); break;
      case "advance":  await advance(p, Number(b.days) || 1); break;
      case "skip":     await skipTo(p, b.to); break;
      case "repay":    await repay(p); break;
      case "reset":    await reset(p); break;
      case "supervise":
        if (p.platform === "ios") {
          p.supervised = !p.supervised;
          record(p, "webhook", `supervision ${p.supervised ? "on" : "off"}`, {});
        }
        break;
      default: return json({ error: "unknown event type" }, 400);
    }
    return json(state());
  }

  // Backend → sim callback (PR 3). HMAC-signed POST from the MDM worker after
  // every apply_jobs terminal transition. Idempotent on apply_job_id so a
  // retry can't double-apply.
  if (path === "/api/mdm/callback" && req.method === "POST") {
    if (!CALLBACK_SECRET) return json({ error: "SIM_CALLBACK_SECRET not configured on this sim" }, 503);
    const raw = await req.text();
    const sig = req.headers.get("x-mdm-signature") ?? "";
    const expected = await hmacHex(CALLBACK_SECRET, raw);
    if (sig.toLowerCase() !== expected) return json({ error: "bad signature" }, 401);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return json({ error: "body not json" }, 400); }
    const jobId = String(body.apply_job_id ?? "");
    const deviceId = String(body.device_id ?? "");
    const state = body.state === "dead" ? "dead" : "applied";
    const finalTier = (body.final_tier ?? null) as Tier | null;
    const errorMessage = body.error_message == null ? null : String(body.error_message);
    const completedAt = String(body.completed_at ?? new Date().toISOString());
    if (!jobId || !deviceId) return json({ error: "missing fields" }, 400);
    const phone = phones.get(deviceId);
    if (!phone) {
      // We don't know about this device — ack so the backend stops retrying.
      // (Could be a device the sim never created a phone card for.)
      return json({ ok: true, note: "device not tracked by sim" });
    }
    phone.seenJobIds ??= new Set<string>();
    if (phone.seenJobIds.has(jobId)) return json({ ok: true, deduped: true });
    phone.seenJobIds.add(jobId);
    phone.backendTier = finalTier;
    phone.backendState = state;
    phone.backendError = errorMessage;
    phone.backendAt = completedAt;
    record(phone, "backend", `backend ${state}${finalTier ? ` → ${finalTier}` : ""}${errorMessage ? ` (${errorMessage.slice(0, 60)})` : ""}`, { backend: { apply_job_id: jobId, state, final_tier: finalTier } });
    return json({ ok: true });
  }

  if (path === "/api/reset-all" && req.method === "POST") {
    // close any live links first
    if (LIVE && supa) {
      for (const p of phones.values()) if (p.live) await closeActiveLink(p.id);
    }
    phones.clear();
    feed.length = 0;
    seq = 1;
    simLoanCounter = 1;
    return json(state());
  }

  return serveStatic(path);
});
