// LMS Simulator frontend — plain JS, no build step.
// Modern UX pass: in-place diffing to avoid flicker, toast on backend reply,
// animated transitions on tier change, timeline-style signal feed.

const TIERS = ["undisbursed", "disbursed", "due_2d", "overdue_2d", "locked", "released"];
const TIER_LABEL = {
  undisbursed: "Undisbursed", disbursed: "Disbursed", due_2d: "Due 2D",
  overdue_2d: "Overdue 2D", locked: "Locked", released: "Released",
};
const TIER_ICON = {
  undisbursed: "○", disbursed: "●", due_2d: "◐", overdue_2d: "◑", locked: "✕", released: "✓",
};

// ---------- DOM helper
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function svg(path, size = 14) {
  return h("span", { html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>` });
}

// ---------- API
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  return r.json();
}
function hook(id, type, extra = {}) {
  return api(`/api/phones/${id}/hook`, { type, ...extra }).then((s) => {
    render(s);
    // light haptic feedback via toast if the backend returned something interesting
    const p = s.phones?.find((x) => x.id === id);
    if (p?.lastBackendResult) toastFromBackend(p.lastBackendResult);
  });
}

// ---------- toast
let toastTimer = null;
function toast(text, tone = "") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 2800);
}
function toastFromBackend(res) {
  const d = res?.data;
  if (!d) return;
  if (d.error) { toast(`backend: ${d.error}`, "err"); return; }
  const r = d.result;
  if (!r) return;
  const applied = r.applied;
  if (applied?.errors) {
    toast(`applied with ${applied.errors} error(s)`, "err");
  } else if (applied?.moved) {
    const o = applied.outcomes?.[0];
    toast(`→ ${o?.targetGroup ?? "ok"}${applied.announced ? ` · ${o?.announcement ?? "ann"}` : ""}`, "ok");
  } else if (r.changed) {
    toast(`tier → ${r.decisions?.[0]?.to}`, "ok");
  }
}

// ---------- backend summary (used in feed + phone card)
function backendSummary(res) {
  if (!res) return "no reply";
  if (res.error) return `err: ${res.error}`;
  const d = res.data;
  if (!d) return "no data";
  if (d.error) return `${d.source || "?"} → ${d.error}`;
  const r = d.result;
  if (!r) return `${d.source || "?"} → null (unlinked or disabled)`;
  const first = r.decisions && r.decisions[0];
  const grp = first?.intendedGroupName ? ` · group=${first.intendedGroupName}` : (first?.note ? ` · ${first.note}` : "");
  const head = `${d.source || "?"} · ${r.trigger} · considered=${r.considered} changed=${r.changed}${r.held ? " HELD" : ""}${first ? ` · ${first.from ?? "∅"}→${first.to}` : ""}${grp}`;
  const a = r.applied;
  if (!a) return head;
  const skippedBits = Object.entries(a.skipped || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",");
  const applyLine = ` · applied moved=${a.moved} announced=${a.announced}${a.errors ? ` err=${a.errors}` : ""}${skippedBits ? ` skip[${skippedBits}]` : ""}`;
  const o = (a.outcomes || [])[0];
  const targ = o?.targetGroup ? ` → ${o.targetGroup}` : "";
  const ann = o?.announcement ? ` + "${o.announcement}"` : "";
  return head + applyLine + targ + ann;
}
function backendIsError(res) {
  const d = res?.data;
  const r = d?.result;
  return Boolean(d?.error || r?.applied?.errors);
}

// ---------- phone card
function phoneCard(p) {
  const tierIdx = TIERS.indexOf(p.tier);
  const undis = p.tier === "undisbursed";

  const ladder = h("div", { class: "mini-ladder" },
    TIERS.map((t, i) => h("span", {
      class: `dot-cell ${t} ${i <= tierIdx ? "on" : ""} ${t === p.tier ? "cur" : ""}`,
      title: TIER_LABEL[t],
    })),
  );

  const btns = [];
  if (undis) {
    btns.push(h("div", { class: "btn-row" },
      h("span", { class: "lbl" }, "Disburse"),
      h("button", { class: "btn btn-sm btn-primary", onclick: () => hook(p.id, "disburse", { productId: 1 }) }, "7-Day"),
      h("button", { class: "btn btn-sm btn-primary", onclick: () => hook(p.id, "disburse", { productId: 2 }) }, "14-Day"),
      h("button", { class: "btn btn-sm btn-primary", onclick: () => hook(p.id, "disburse", { productId: 3 }) }, "28-Day"),
    ));
  } else {
    btns.push(h("div", { class: "btn-row" },
      h("button", { class: "btn btn-sm btn-ghost", onclick: () => hook(p.id, "advance", { days: 1 }) }, "+1 day"),
      h("button", { class: "btn btn-sm btn-warn", onclick: () => hook(p.id, "skip", { to: "due" }) }, "→ Due 2D"),
      h("button", { class: "btn btn-sm btn-overdue", onclick: () => hook(p.id, "skip", { to: "overdue" }) }, "→ Overdue"),
      h("button", { class: "btn btn-sm btn-danger", onclick: () => hook(p.id, "skip", { to: "lock" }) }, "→ Lock"),
    ));
    btns.push(h("div", { class: "btn-row" },
      h("button", { class: "btn btn-sm btn-ok", onclick: () => hook(p.id, "repay") }, "Repay → Release"),
      h("button", { class: "btn btn-sm btn-ghost", onclick: () => hook(p.id, "reset") }, "Reset"),
    ));
  }

  const livePill = p.live
    ? h("span", {
        class: "live-pill on",
        title: `loan_links row + signed webhook to backend\nexternal_id: ${p.externalId ?? ""}`,
      }, p.loanId ? `LIVE · ${p.loanId}` : "LIVE")
    : h("span", { class: "live-pill off", title: "in-memory only, no backend call" }, "SIM");

  const platformBadge = h("span", { class: `badge ${p.platform}` }, p.platform === "android" ? "Android" : "iPhone");
  const supBtn = p.platform === "ios"
    ? h("button", {
        class: "sup " + (p.supervised ? "on" : "off"),
        title: "toggle supervision (iOS only)",
        onclick: () => hook(p.id, "supervise"),
      }, p.supervised ? "supervised" : "unsupervised")
    : null;

  return h("div", {
    class: `card tier-${p.tier}`,
    "data-pid": p.id,
    "data-tier": p.tier,
  },
    h("div", { class: "card-head" },
      h("div", { class: "card-head-l" },
        platformBadge,
        h("span", { class: "pname", title: p.name }, p.name),
        supBtn,
        livePill,
      ),
      h("button", {
        class: "x",
        title: "remove phone from sim",
        onclick: () => api(`/api/phones/${p.id}/delete`, {}).then(render),
      }, "×"),
    ),
    h("div", { class: "tier-hero" },
      h("span", { class: "tier-pill" }, TIER_ICON[p.tier], " ", TIER_LABEL[p.tier]),
      h("div", { class: "action" }, p.action),
    ),
    h("div", { class: "meta" },
      p.product
        ? [h("span", { class: "meta-k" }, "Product"), h("span", { class: "meta-v" }, p.product), h("span", { class: "dot" }, "·")]
        : [h("span", { class: "meta-k" }, "Stock"), h("span", { class: "dot" }, "·")],
      p.loanStatus
        ? [h("span", { class: "meta-k" }, "Day"), h("span", { class: "meta-v mono" }, String(p.day)),
           h("span", { class: "dot" }, "·"),
           h("span", { class: "meta-k" }, "DPD"), h("span", { class: "meta-v mono" }, String(p.dpd))]
        : h("span", { class: "meta-k" }, "no loan"),
    ),
    (p.clientName || p.clientEmail)
      ? h("div", { class: "meta", title: "debtor on file; reminder emails on due_2d / overdue_2d go to this address" },
          h("span", { class: "meta-k" }, "Debtor"),
          h("span", { class: "meta-v" }, p.clientName || "—"),
          p.clientEmail ? h("span", { class: "dot" }, "·") : null,
          p.clientEmail ? h("span", { class: "meta-v mono" }, p.clientEmail) : null,
        )
      : null,
    ladder,
    p.live && p.lastBackendResult
      ? h("div", {
          class: "backend-line" + (backendIsError(p.lastBackendResult) ? " err" : ""),
          title: "last response from /api/fineract/hooks",
        }, backendSummary(p.lastBackendResult))
      : null,
    h("div", { class: "btns" }, btns),
  );
}

// ---------- feed row
const KIND_ICON = { webhook: "⚡", timer: "⏱", backend: "✓" };
function feedRow(s) {
  const kindTag = s.kind === "webhook" ? "HOOK" : s.kind === "timer" ? "TIMER" : "BACKEND";
  const extra = s.kind === "backend"
    ? h("span", { class: "flabel" }, backendSummary(s.backend))
    : s.label
      ? h("span", { class: "flabel" }, s.label)
      : null;

  return h("div", { class: `frow ${s.to} ${s.kind}` },
    h("div", { class: "ficon" }, KIND_ICON[s.kind] ?? "·"),
    h("div", { class: "fmain" },
      h("div", { class: "ftop" },
        h("span", { class: "ftag" }, kindTag),
        h("span", { class: "fphone" }, s.phone),
        h("span", { class: "fmove" },
          TIER_LABEL[s.from],
          h("span", { class: "fmove-arrow" }, " → "),
          TIER_LABEL[s.to],
        ),
      ),
      s.action ? h("span", { class: "faction" }, s.action) : null,
      extra,
    ),
  );
}

// ---------- render
let lastStateHash = "";
function stateHash(s) {
  // cheap diff key — rerender when something visible changed
  return JSON.stringify({
    live: s.live,
    phones: s.phones.map((p) => [p.id, p.tier, p.day, p.dpd, p.loanId, p.live, p.action, p.supervised, p.lastBackendResult?.data?.result?.changed ?? 0]),
    feedTop: s.feed[0]?.ts ?? 0,
    feedLen: s.feed.length,
  });
}
function render(st) {
  const promise = st && st.phones ? Promise.resolve(st) : api("/api/state");
  promise.then((s) => {
    const hash = stateHash(s);
    if (hash === lastStateHash) return;
    lastStateHash = hash;

    // header stats + mode
    document.getElementById("statPhones").textContent = String(s.phones.length);
    document.getElementById("statFeed").textContent = String(s.feed.length);

    const pill = document.getElementById("modePill");
    const pillText = pill.querySelector(".mode-text");
    pill.classList.remove("mode-on", "mode-off", "mode-sandbox");
    if (s.sandbox) {
      pill.classList.add("mode-sandbox");
      pillText.textContent = "SANDBOX";
      pill.title = "Public demo build · in-memory engine only · no Supabase or backend calls";
    } else if (s.live) {
      pill.classList.add("mode-on");
      pillText.textContent = "LIVE";
      pill.title = `enterprise=${s.enterprise}\nbackend=${s.backend}\nreal devices → loan_links + signed webhook`;
    } else {
      pill.classList.add("mode-off");
      pillText.textContent = "OFFLINE";
      pill.title = "live mode disabled — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FINERACT_WEBHOOK_SECRET in env";
    }

    // Hide the "Real device" controls on sandbox builds so users don't try to
    // use them. Keep the sandbox phone buttons available.
    const liveControls = document.querySelector(".controls-live");
    if (liveControls) liveControls.style.display = s.sandbox ? "none" : "";

    // phones grid
    const wrap = document.getElementById("phones");
    wrap.replaceChildren(...s.phones.map(phoneCard));
    if (!s.phones.length) {
      wrap.append(h("div", { class: "empty" },
        h("span", { class: "empty-strong" }, "No phones yet"),
        "Pick a real device above, or add a sandbox phone.",
      ));
    }

    // signal feed
    const fd = document.getElementById("feed");
    fd.replaceChildren(...s.feed.map(feedRow));
    if (!s.feed.length) {
      fd.append(h("div", { class: "empty" },
        h("span", { class: "empty-strong" }, "No signals yet"),
        "Disburse a phone and advance it to see the engine fire.",
      ));
    }
  });
}

// ---------- device picker
async function refreshDevicePicker() {
  const sel = document.getElementById("deviceSelect");
  if (!sel) return;
  const r = await api("/api/available-devices").catch(() => ({ devices: [] }));
  const devs = r.devices || [];
  const currentValue = sel.value;
  sel.replaceChildren(
    h("option", { value: "" }, devs.length ? `Choose one of ${devs.length} device${devs.length === 1 ? "" : "s"}…` : "No live devices available"),
    ...devs.map((d) => {
      const label = `${d.platform === "ios" ? "iPhone" : "Android"} · ${d.device_name || d.id.slice(0, 8)}${d.serial_number ? ` · ${d.serial_number.slice(0, 10)}` : ""}`;
      return h("option", { value: d.id }, label);
    }),
  );
  if (currentValue && [...sel.options].some((o) => o.value === currentValue)) sel.value = currentValue;
}

// ---------- control bindings
document.getElementById("addAndroid").onclick = async () => {
  await api("/api/phones", { platform: "android" });
  render();
};
document.getElementById("addIphone").onclick = async () => {
  await api("/api/phones", { platform: "ios" });
  render();
};
document.getElementById("addLive").onclick = async () => {
  const sel = document.getElementById("deviceSelect");
  const deviceId = sel && sel.value;
  if (!deviceId) { toast("Pick a real device from the dropdown first", "err"); return; }
  const clientName  = (document.getElementById("debtorName")?.value  ?? "").trim();
  const clientEmail = (document.getElementById("debtorEmail")?.value ?? "").trim();
  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    toast("Enter a valid debtor email, or leave it blank", "err"); return;
  }
  const r = await api("/api/phones", { deviceId, clientName, clientEmail });
  if (r && r.error) { toast(r.error, "err"); return; }
  // Clear the form so the next registration starts fresh — selected device
  // intentionally resets too via refreshDevicePicker on next tick.
  document.getElementById("debtorName").value = "";
  document.getElementById("debtorEmail").value = "";
  const who = clientName ? `${clientName} on ${r.name ?? "device"}` : (r.name ?? "device");
  toast(`Registered ${who}`, "ok");
  render();
};
document.getElementById("resetAll").onclick = async () => {
  if (!confirm("Reset all sim phones?\nLive loan_links will be closed in Supabase.")) return;
  await api("/api/reset-all", {});
  toast("All sim phones reset");
  render();
};

// ---------- tier legend (static)
const legendEl = document.getElementById("ladder");
legendEl.replaceChildren(...TIERS.map((t) => h("span", { class: `legend ${t}` }, TIER_LABEL[t])));

// ---------- Loans tab (PR 3): list loan_links joined with devices + tier state
let currentView = "phones";
let loanFilter = "all";
const LOAN_FILTERS = [
  { key: "all",      label: "All" },
  { key: "active",   label: "Active" },
  { key: "overdue",  label: "Overdue" },
  { key: "locked",   label: "Locked" },
  { key: "closed",   label: "Closed" },
];
const TIER_TONE = {
  undisbursed: "neutral", disbursed: "info", due_2d: "warn",
  overdue_2d: "overdue",  locked: "danger",  released: "ok",
};
let lastLoanSnapshot = "";
async function refreshLoans(force = false) {
  if (currentView !== "loans" && !force) return;
  const r = await fetch("/api/loan-links").then((x) => x.json()).catch(() => ({ loans: [] }));
  const loans = Array.isArray(r.loans) ? r.loans : [];
  // De-dupe render if nothing changed — avoids yanking a scroll position
  // every 2.5s when the data is stable.
  const snap = JSON.stringify({ f: loanFilter, n: loans.length, d: loans.map((l) => [l.id, l.applied_tier, l.observed_state, l.status, l.last_reminder_at]) });
  if (snap === lastLoanSnapshot) return;
  lastLoanSnapshot = snap;

  // Filter + sort (DPD desc via due_on asc)
  const filtered = loans.filter((l) => {
    if (loanFilter === "all") return true;
    if (loanFilter === "closed") return l.status === "closed";
    if (loanFilter === "active") return l.status === "active";
    const tier = l.observed_state ?? l.applied_tier ?? "";
    if (loanFilter === "overdue") return tier === "overdue_2d" || tier === "due_2d";
    if (loanFilter === "locked")  return tier === "locked";
    return true;
  }).sort((a, b) => {
    const ta = (a.observed_state ?? a.applied_tier ?? "");
    const tb = (b.observed_state ?? b.applied_tier ?? "");
    const sev = { locked: 5, overdue_2d: 4, due_2d: 3, disbursed: 2, undisbursed: 1, released: 0 };
    return (sev[tb] ?? 0) - (sev[ta] ?? 0);
  });

  // Chips
  const chipsEl = document.getElementById("loanChips");
  chipsEl.replaceChildren(...LOAN_FILTERS.map((f) =>
    h("button", {
      type: "button",
      class: `loan-chip${loanFilter === f.key ? " active" : ""}`,
      role: "tab",
      "aria-selected": String(loanFilter === f.key),
      onclick: () => { loanFilter = f.key; lastLoanSnapshot = ""; refreshLoans(true); },
    }, f.label)
  ));
  document.getElementById("loanCount").textContent = `${filtered.length} shown · ${loans.length} total`;

  const tableEl = document.getElementById("loansTable");
  if (!filtered.length) {
    tableEl.replaceChildren(h("div", { class: "loans-empty" }, loans.length ? "No loans match this filter." : "No loans linked yet. Register one from the Phones tab."));
    return;
  }

  tableEl.replaceChildren(
    h("div", { class: "loans-row loans-head-row" },
      h("span", {}, "Client"),
      h("span", {}, "Loan#"),
      h("span", {}, "Device"),
      h("span", {}, "Tier"),
      h("span", {}, "Due"),
      h("span", {}, "Status"),
      h("span", {}, "Last reminder"),
    ),
    ...filtered.map((l) => {
      const tier = l.observed_state ?? l.applied_tier ?? "—";
      const tone = TIER_TONE[tier] ?? "neutral";
      const dueOn = l.due_on ?? "—";
      const lastRem = l.last_reminder_at ? new Date(l.last_reminder_at).toLocaleString() : "—";
      return h("div", { class: `loans-row tier-${tier}` },
        h("span", { class: "loans-client" }, h("div", {}, l.client_name ?? "(no name)"), h("div", { class: "muted small" }, l.client_email ?? "")),
        h("span", { class: "mono" }, l.fineract_loan_id ?? "—"),
        h("span", {}, l.device_name ?? "—"),
        h("span", { class: `loan-tier tone-${tone}` }, tier),
        h("span", { class: "mono small" }, dueOn),
        h("span", {}, l.status),
        h("span", { class: "small muted" }, lastRem),
      );
    }),
  );
}
function setView(view) {
  currentView = view === "loans" ? "loans" : "phones";
  document.getElementById("tabPhones").classList.toggle("active", currentView === "phones");
  document.getElementById("tabLoans").classList.toggle("active", currentView === "loans");
  document.getElementById("tabPhones").setAttribute("aria-selected", String(currentView === "phones"));
  document.getElementById("tabLoans").setAttribute("aria-selected", String(currentView === "loans"));
  document.getElementById("viewPhones").hidden = currentView !== "phones";
  document.getElementById("viewLoans").hidden  = currentView !== "loans";
  if (currentView === "loans") refreshLoans(true);
}
document.getElementById("tabPhones").onclick = () => setView("phones");
document.getElementById("tabLoans").onclick  = () => setView("loans");

// ---------- boot + poll
render();
refreshDevicePicker();
setInterval(render, 2500);
setInterval(refreshDevicePicker, 15000);
setInterval(refreshLoans, 3000);
