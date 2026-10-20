(() => {
  const cfg = window.TRACKER_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const PAGE = 50;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString("en-US");

  // Sheets sometimes hands back dates as serial numbers (e.g. 46309).
  function normDate(v) {
    const s = String(v || "").trim();
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    return s;
  }

  function highlight(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&amp;")})`, "ig");
    return safe.replace(re, "<mark>$1</mark>");
  }

  function linkify(text, q) {
    return highlight(text, q).replace(/(https?:\/\/[^\s<]+)/g, (u) => {
      const href = u.replace(/<\/?mark>/g, "");
      return `<a href="${href}" target="_blank" rel="noopener">${u}</a>`;
    });
  }

  function tone(status, kind) {
    const s = status.toLowerCase();
    if (/merged|interview|offer|screen|hired|accepted/.test(s)) return "good";
    if (/reject|declin|closed unmerged|taken/.test(s)) return "bad";
    if (/block|in progress|needs|parked|awaiting|assignment|vouch|vetting|candidate/.test(s)) return "warn";
    if (/submit|sent|applied|registered|open|ready|pr opened|logged/.test(s)) return "info";
    return "neutral";
  }

  // PR tracker statuses look like "Vetted - ready" or "TAKEN - claimed 2026-10-13 by x": group on the stage.
  function prStage(s) {
    const head = String(s || "").split(/\s+[-–—]\s+|\s*\(/)[0].trim();
    if (!head) return "Unknown";
    return head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
  }

  // ---------- data loading ----------
  function sourceUrl(csv, id) {
    if (csv) return csv;
    if (id) return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=Sheet1`;
    return null;
  }

  async function fetchCsv(urls) {
    let lastErr;
    for (const url of urls.filter(Boolean)) {
      try {
        const bust = url.includes("?") ? "&" : "?";
        const res = await fetch(url + bust + "_=" + Date.now(), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) throw new Error("got a sign-in page, the tab isn't published");
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
        return parsed.data;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("no source configured");
  }

  const state = {
    view: "jobs",
    jobs: { rows: [], q: "", status: "", extra: "", sort: { key: "date", dir: -1 }, page: 0 },
    prs: { rows: [], q: "", status: "", extra: "", sort: { key: "date", dir: -1 }, page: 0 },
  };

  function mapJobs(raw) {
    return raw.map((r) => ({
      date: normDate(r["Date"]),
      company: (r["Company"] || "").trim(),
      role: (r["Role"] || "").trim(),
      channel: (r["Channel"] || "").trim(),
      status: (r["Status"] || "").trim() || "Unknown",
      comp: (r["Comp / Rate"] || "").trim(),
      notes: (r["Notes"] || "").trim(),
    })).filter((r) => r.company || r.role);
  }

  function mapPrs(raw) {
    return raw.map((r) => {
      const status = (r["Status"] || "").trim();
      return {
        date: normDate(r["Date Found"]),
        repo: (r["Repo"] || "").trim(),
        issue: (r["Issue #"] || "").trim(),
        title: (r["Issue Title"] || "").trim(),
        issueUrl: (r["Issue URL"] || "").trim(),
        type: (r["Type"] || "").trim(),
        labels: (r["Labels"] || "").trim(),
        status, stage: prStage(status),
        prUrl: (r["PR URL"] || "").trim(),
        branch: (r["Fork / Branch"] || "").trim(),
        files: (r["Files Changed"] || "").trim(),
        notes: (r["Notes / Next Step"] || "").trim(),
      };
    }).filter((r) => r.repo);
  }

  // ---------- rendering: KPIs ----------
  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
  }

  function countBy(rows, key) {
    const m = new Map();
    for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderJobsKpis(rows) {
    const st = (re) => rows.filter((r) => re.test(r.status)).length;
    const out = st(/^(submitted|sent)$/i);
    const rej = st(/reject/i);
    const action = st(/block|in progress/i);
    const days = new Set(rows.map((r) => r.date).filter(Boolean)).size;
    const companies = new Set(rows.map((r) => r.company.toLowerCase())).size;
    const good = st(/interview|offer|screen/i);
    $("#jobs-kpis").innerHTML = [
      kpi("Applications out", fmt(out), "submitted or sent"),
      kpi("Companies", fmt(companies), "unique"),
      kpi("Rows logged", fmt(rows.length), `across ${days} days`),
      kpi("Avg per day", days ? fmt(Math.round(out / days)) : "–", "applications out"),
      kpi("Rejections", fmt(rej), out ? `${((rej / out) * 100).toFixed(1)}% of sent` : ""),
      good ? kpi("Interviews", fmt(good), "screens & offers") : kpi("Needs action", fmt(action), "blocked or in progress"),
    ].join("");
  }

  function renderPrsKpis(rows) {
    const withPr = rows.filter((r) => /github\.com\/.+\/pull\//.test(r.prUrl)).length;
    const merged = rows.filter((r) => /merged/i.test(r.status)).length;
    const repos = new Set(rows.map((r) => r.repo.toLowerCase())).size;
    const ready = rows.filter((r) => /ready/i.test(r.status) && !r.prUrl).length;
    $("#prs-kpis").innerHTML = [
      kpi("Issues tracked", fmt(rows.length), "vetted by Greenlight"),
      kpi("PRs opened", fmt(withPr), "linked pull requests"),
      kpi("Merged", fmt(merged), withPr ? `${Math.round((merged / withPr) * 100)}% of opened` : ""),
      kpi("Repos", fmt(repos), "unique"),
      kpi("Ready to build", fmt(ready), "vetted, no PR yet"),
    ].join("");
  }

  // ---------- rendering: charts ----------
  const tip = $("#tip");
  function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; moveTip(e); }
  function moveTip(e) {
    const w = tip.offsetWidth, x = Math.min(e.clientX + 12, innerWidth - w - 8);
    tip.style.left = x + "px"; tip.style.top = (e.clientY - 36) + "px";
  }
  function hideTip() { tip.hidden = true; }

  function renderActivity(rows) {
    const el = $("#jobs-activity");
    const counts = countBy(rows, "date").filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort((a, b) => a[0].localeCompare(b[0]));
    if (!counts.length) { el.innerHTML = `<div class="empty">No dated rows yet.</div>`; return; }
    const W = 640, H = 220, L = 34, R = 8, T = 10, B = 26;
    const max = Math.max(...counts.map((c) => c[1]));
    const nice = Math.ceil(max / 50) * 50 || 10;
    const bw = (W - L - R) / counts.length;
    const gap = Math.min(2 + bw * 0.2, 8);
    const y = (v) => T + (H - T - B) * (1 - v / nice);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rows logged per day"><g class="grid axis">`;
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i;
      s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    s += `</g><g class="axis">`;
    const every = Math.ceil(counts.length / 8);
    counts.forEach(([d], i) => {
      if (i % every === 0) s += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${d.slice(5).replace("-", "/")}</text>`;
    });
    s += `</g>`;
    counts.forEach(([d, v], i) => {
      const x = L + i * bw + gap / 2, w = Math.max(bw - gap, 2), top = y(v), h = H - B - top, r = Math.min(4, w / 2, h);
      s += `<g class="col" data-d="${d}" data-v="${v}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/>`;
      s += `<path class="bar" d="M${x},${H - B} V${top + r} q0,-${r} ${r},-${r} h${w - 2 * r} q${r},0 ${r},${r} V${H - B} Z"/></g>`;
    });
    s += `</svg>`;
    el.innerHTML = s;
    el.querySelectorAll("g.col").forEach((g) => {
      g.addEventListener("mouseenter", (e) => showTip(e, `<b>${g.dataset.d}</b> · ${g.dataset.v} rows`));
      g.addEventListener("mousemove", moveTip);
      g.addEventListener("mouseleave", hideTip);
    });
    const recent = counts.slice(-7).reduce((a, c) => a + c[1], 0);
    $("#jobs-act-note").textContent = `${fmt(recent)} in the last 7 active days`;
  }

  function renderHBars(el, pairs, which, active) {
    const max = Math.max(1, ...pairs.map((p) => p[1]));
    el.innerHTML = `<div class="hbars">${pairs.map(([k, v]) => `
      <button class="hbar${active === k ? " on" : ""}" data-k="${esc(k)}" type="button">
        <span class="hbar-label" title="${esc(k)}">${esc(k)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="display:block;width:${(v / max) * 100}%"></span></span>
        <span class="hbar-val">${fmt(v)}</span>
      </button>`).join("")}</div>`;
    el.querySelectorAll(".hbar").forEach((b) => b.addEventListener("click", () => {
      const st = state[which];
      st.status = st.status === b.dataset.k ? "" : b.dataset.k;
      $(`#${which}-status-filter`).value = st.status;
      st.page = 0; renderTable(which); renderSide(which);
    }));
  }

  function renderPills(el, pairs, which) {
    el.innerHTML = pairs.map(([k, v]) => `<button class="pill" data-k="${esc(k)}" type="button">${esc(k)}<b>${v}</b></button>`).join("");
    el.querySelectorAll(".pill").forEach((p) => p.addEventListener("click", () => {
      const st = state[which];
      st.q = p.dataset.k; $(`#${which}-q`).value = st.q; st.page = 0; renderTable(which);
      $(`#${which}-q`).scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }

  function renderSide(which) {
    const st = state[which];
    if (which === "jobs") {
      renderHBars($("#jobs-status"), countBy(st.rows, "status").slice(0, 12), "jobs", st.status);
    } else {
      renderHBars($("#prs-status"), countBy(st.rows, "stage"), "prs", st.status);
    }
  }

  // ---------- rendering: table ----------
  const COLS = {
    jobs: [
      { key: "date", label: "Date", cls: "nowrap mono" },
      { key: "company", label: "Company", cls: "strong" },
      { key: "role", label: "Role", cls: "wide" },
      { key: "channel", label: "Channel", cls: "nowrap" },
      { key: "status", label: "Status", chip: true },
      { key: "comp", label: "Comp / Rate", cls: "nowrap" },
      { key: "notes", label: "Notes", cls: "notes", long: true },
    ],
    prs: [
      { key: "date", label: "Found", cls: "nowrap mono" },
      { key: "repo", label: "Repo", cls: "strong nowrap" },
      { key: "issue", label: "Issue", cls: "nowrap", render: (r) => r.issueUrl ? `<a href="${esc(r.issueUrl)}" target="_blank" rel="noopener">#${esc(r.issue)}</a>` : esc(r.issue) },
      { key: "title", label: "Title", cls: "wide" },
      { key: "type", label: "Type", cls: "nowrap" },
      { key: "status", label: "Status", chip: true },
      { key: "prUrl", label: "PR", cls: "nowrap", render: (r) => {
        const m = r.prUrl.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
        return m ? `<a href="${esc(r.prUrl)}" target="_blank" rel="noopener">PR #${m[1]}</a>` : esc(r.prUrl);
      } },
      { key: "notes", label: "Notes / next step", cls: "notes", long: true },
    ],
  };

  function filtered(which) {
    const st = state[which];
    const q = st.q.trim().toLowerCase();
    let rows = st.rows.filter((r) => {
      if (st.status && (which === "prs" ? r.stage : r.status) !== st.status) return false;
      if (st.extra && (which === "prs" ? r.type : r.channel) !== st.extra) return false;
      if (!q) return true;
      return Object.values(r).some((v) => String(v).toLowerCase().includes(q));
    });
    const { key, dir } = st.sort;
    rows = rows.slice().sort((a, b) => {
      const x = a[key] || "", y = b[key] || "";
      const nx = parseFloat(x), ny = parseFloat(y);
      const c = key === "issue" && !isNaN(nx) && !isNaN(ny) ? nx - ny : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
      return c * dir;
    });
    return rows;
  }

  function renderTable(which) {
    const st = state[which];
    const cols = COLS[which];
    const rows = filtered(which);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    st.page = Math.min(st.page, pages - 1);
    const slice = rows.slice(st.page * PAGE, st.page * PAGE + PAGE);
    const q = st.q.trim();
    const head = `<thead><tr>${cols.map((c) => `<th data-k="${c.key}" ${st.sort.key === c.key ? `aria-sort="${st.sort.dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}</th>`).join("")}</tr></thead>`;
    const body = slice.length ? slice.map((r) => `<tr>${cols.map((c) => {
      let inner;
      if (c.render) inner = c.render(r);
      else if (c.chip) inner = r[c.key] ? `<span class="chip ${tone(r[c.key])}" title="${esc(r[c.key])}">${highlight(which === "prs" ? r.stage : r[c.key], q)}</span>` : "";
      else if (c.long) inner = r[c.key] ? `<div class="clamp">${linkify(r[c.key], q)}</div>` : "";
      else inner = highlight(r[c.key], q);
      return `<td class="${c.cls || ""}">${inner}</td>`;
    }).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length}"><div class="empty">${st.err && !st.rows.length ? "This data isn't available right now. Check back soon." : "Nothing matches that search."}</div></td></tr>`;
    const table = $(`#${which}-table`);
    table.innerHTML = head + `<tbody>${body}</tbody>`;
    table.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      st.sort = st.sort.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: k === "date" ? -1 : 1 };
      renderTable(which);
    }));
    table.querySelectorAll(".clamp").forEach((c) => c.addEventListener("click", (e) => { if (e.target.tagName !== "A") c.classList.toggle("open"); }));
    $(`#${which}-shown`).textContent = `${fmt(rows.length)} of ${fmt(st.rows.length)}`;
    const pager = $(`#${which}-pager`);
    pager.innerHTML = pages > 1 ? `
      <button class="btn" data-p="-1" ${st.page === 0 ? "disabled" : ""}>← Prev</button>
      <span class="muted">Page ${st.page + 1} of ${pages}</span>
      <button class="btn" data-p="1" ${st.page >= pages - 1 ? "disabled" : ""}>Next →</button>` : "";
    pager.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      st.page += +b.dataset.p; renderTable(which);
      table.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function fillSelect(sel, values, keep) {
    const first = sel.options[0].outerHTML;
    sel.innerHTML = first + values.map(([v, n]) => `<option value="${esc(v)}">${esc(v)} (${n})</option>`).join("");
    sel.value = keep;
  }

  function wireToolbar(which, extraKey) {
    const st = state[which];
    let t;
    $(`#${which}-q`).addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; st.page = 0; renderTable(which); }, 120); });
    $(`#${which}-status-filter`).addEventListener("change", (e) => { st.status = e.target.value; st.page = 0; renderTable(which); renderSide(which); });
    $(`#${which}-${extraKey}-filter`).addEventListener("change", (e) => { st.extra = e.target.value; st.page = 0; renderTable(which); });
  }

  // ---------- main ----------
  function renderAll() {
    const j = state.jobs, p = state.prs;
    $("#jobs-count").textContent = fmt(j.rows.length);
    $("#prs-count").textContent = fmt(p.rows.length);
    renderJobsKpis(j.rows); renderActivity(j.rows); renderSide("jobs");
    renderPills($("#jobs-top"), countBy(j.rows, "company").slice(0, 24), "jobs");
    fillSelect($("#jobs-status-filter"), countBy(j.rows, "status"), j.status);
    fillSelect($("#jobs-channel-filter"), countBy(j.rows, "channel"), j.extra);
    renderTable("jobs");
    renderPrsKpis(p.rows); renderSide("prs");
    renderPills($("#prs-top"), countBy(p.rows, "repo").slice(0, 24), "prs");
    fillSelect($("#prs-status-filter"), countBy(p.rows, "stage"), p.status);
    fillSelect($("#prs-type-filter"), countBy(p.rows, "type"), p.extra);
    renderTable("prs");
  }

  async function load() {
    $("#refresh").disabled = true;
    const params = new URLSearchParams(location.search);
    const [jobs, prs] = await Promise.allSettled([
      fetchCsv([params.get("jobs"), sourceUrl(cfg.jobsCsv, cfg.jobsSheetId), "data/jobs.csv"]),
      fetchCsv([params.get("prs"), sourceUrl(cfg.prsCsv, cfg.prsSheetId), "data/prs.csv"]),
    ]);
    const errs = [];
    state.jobs.err = jobs.status === "rejected";
    state.prs.err = prs.status === "rejected";
    if (!state.jobs.err) state.jobs.rows = mapJobs(jobs.value); else errs.push("the job tracker sheet");
    if (!state.prs.err) state.prs.rows = mapPrs(prs.value); else errs.push("the PR tracker sheet");
    renderAll();
    const ok = errs.length < 2;
    $("#pulse").classList.toggle("live", ok);
    const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("#sync").textContent = ok ? `Live from Google Sheets · synced ${now}` : "Couldn't reach Google Sheets";
    $("#foot-updated").textContent = `Last sync ${new Date().toLocaleString()}`;
    const err = $("#error");
    err.hidden = !errs.length;
    err.textContent = errs.length ? `Couldn't load ${errs.join(" or ")}. It needs to be shared as "anyone with the link can view" or published to the web.` : "";
    $("#refresh").disabled = false;
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll(".tab").forEach((t) => { const on = t.dataset.view === v; t.classList.toggle("active", on); t.setAttribute("aria-selected", on); });
    $("#view-jobs").hidden = v !== "jobs"; $("#view-prs").hidden = v !== "prs";
    try { history.replaceState(null, "", v === "prs" ? "#prs" : "#"); } catch {}
  }

  // theme toggle (remembered per browser)
  function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
  try { applyTheme(localStorage.getItem("theme")); } catch {}
  $("#theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("theme", next); } catch {}
  });

  if (cfg.owner) { $("#title").textContent = `${cfg.owner}'s Job Search`; document.title = `${cfg.owner} · Job Search Tracker`; }
  if (cfg.github) $("#gh").href = `https://github.com/${cfg.github}`; else $("#gh").hidden = true;
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#refresh").addEventListener("click", load);
  wireToolbar("jobs", "channel"); wireToolbar("prs", "type");
  setView(location.hash === "#prs" ? "prs" : "jobs");
  $("#jobs-kpis").innerHTML = $("#prs-kpis").innerHTML = Array(5).fill(`<div class="kpi"><div class="skeleton"></div></div>`).join("");
  load();
  setInterval(load, Math.max(1, cfg.refreshMinutes || 5) * 60000);
})();
