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
// Run:  deno run --allow-net --allow-read --allow-env --env-file=../.env lms-simulator/server.ts
// Open: http://localhost:8010

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PORT = Number(Deno.env.get("SIM_PORT") ?? 8010);
const DIR = new URL("./public/", import.meta.url);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("FINERACT_WEBHOOK_SECRET") ?? "";
const BACKEND_URL = (Deno.env.get("BACKEND_URL") ?? "http://localhost:8000").replace(/\/$/, "");
const SIM_ENTERPRISE_ID = Deno.env.get("SIM_ENTERPRISE_ID") ?? "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";

const LIVE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && WEBHOOK_SECRET);
const supa = LIVE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

console.log(`[sim] mode=${LIVE ? "LIVE" : "OFFLINE"} backend=${BACKEND_URL} enterprise=${SIM_ENTERPRISE_ID}`);
if (!LIVE) {
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
  lastBackendResult?: unknown;
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

function action(tier: Tier, p: Phone): string {
  switch (tier) {
    case "undisbursed": return "baseline · full use";
    case "disbursed": return "full use";
    case "due_2d": return "reminder announcement";
    case "overdue_2d":
      return p.platform === "android"
        ? "payment-only KIOSK + block installs"
        : (p.supervised ? "restrictions + notice (no kiosk yet)" : "announcement only (unsupervised)");
    case "locked": return 'LOCK device + "Pay now"';
    case "released": return "unlock, drop kiosk/restrict → full use";
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
  productId: number;
  productName: string | null;
  status: "active" | "closed" | "written_off" | "overpaid" | "pending" | "approved" | "rejected" | "unknown";
  externalId: string | null;
  disbursedOn: string | null;
  dueOn: string | null;
  dpd: number;
  totalOutstanding: number;
};

type WebhookResponse = { data?: { trigger?: string; kind?: string; source?: string; result?: unknown; error?: string; note?: string } };

async function postWebhook(payload: {
  actionName: "DISBURSE" | "REPAYMENT" | "DAILY_TICK";
  loanId: string;
  loan: FineractLoanSummary;
}): Promise<WebhookResponse | { error: string }> {
  const body = JSON.stringify({
    entityName: "LOAN",
    actionName: payload.actionName,
    loanId: payload.loanId,
    loan: payload.loan,
  });
  const sig = await hmacHex(WEBHOOK_SECRET, body);
  try {
    const res = await fetch(`${BACKEND_URL}/api/fineract/hooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Fineract-Signature": sig },
      body,
    });
    const text = await res.text();
    try { return JSON.parse(text) as WebhookResponse; } catch { return { error: `non-json http ${res.status}: ${text.slice(0, 200)}` }; }
  } catch (e) {
    return { error: `network: ${String(e)}` };
  }
}

function buildSummary(p: Phone, status: FineractLoanSummary["status"], disbursedISO: string, dueISO: string): FineractLoanSummary {
  const loan = p.loan!;
  const pr = PRODUCTS[loan.productId];
  return {
    loanId: loan.fineractLoanId,
    accountNo: `SIM-${loan.fineractLoanId}`,
    clientId: null,
    clientName: `SIM/${p.name}`,
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

async function addLivePhoneByDeviceId(deviceId: string): Promise<Phone | null> {
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
  const p: Phone = {
    id: data.id,
    name: data.device_name as string ?? `Device-${data.id.slice(0, 6)}`,
    platform,
    supervised: Boolean(data.is_supervised),
    day: 0,
    loan: null,
    tier: "undisbursed",
    externalId: `SIM-${serial}`,
    live: true,
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
  const loanId = `SIM-${String(simLoanCounter++).padStart(6, "0")}`;
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
  };
}

function state() {
  return {
    live: LIVE,
    enterprise: SIM_ENTERPRISE_ID,
    backend: BACKEND_URL,
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

// Seed one offline phone of each platform so the UI is never empty.
addOfflinePhone("android");
addOfflinePhone("ios");

Deno.serve({ port: PORT, onListen: () => console.log(`LMS Simulator on http://localhost:${PORT}`) }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/state") return json(state());
  if (path === "/api/available-devices") return json({ devices: await listAvailableDevices() });

  if (path === "/api/phones" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (b.deviceId) {
      if (!LIVE) return json({ error: "live mode is off; set SUPABASE/FINERACT env to use real devices" }, 412);
      const p = await addLivePhoneByDeviceId(String(b.deviceId));
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

  if (path === "/api/reset-all" && req.method === "POST") {
    // close any live links first
    if (LIVE && supa) {
      for (const p of phones.values()) if (p.live) await closeActiveLink(p.id);
    }
    phones.clear();
    feed.length = 0;
    seq = 1;
    simLoanCounter = 1;
    addOfflinePhone("android");
    addOfflinePhone("ios");
    return json(state());
  }

  return serveStatic(path);
});
