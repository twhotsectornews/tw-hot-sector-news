// 純前端：讀 news.json，以「今日漲停看板（依族群）」呈現，可收合、可篩選。無建置步驟。

const $app = document.getElementById("app");
const $status = document.getElementById("status");
const LS_KEY = "twhsn-open-sectors";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function slug(s) { return "sec-" + encodeURIComponent(String(s)).replace(/[^a-zA-Z0-9]/g, ""); }
function fmtTime(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" }); }
function relTime(p) {
  const d = new Date(p); if (isNaN(d)) return "";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 60) return `${Math.max(m, 0)} 分前`;
  if (m < 1440) return `${Math.round(m / 60)} 小時前`;
  return d.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
}

// 漲停個股 chip（一律漲停樣式）：代碼 名稱 +漲幅%
function stockChip(s, withReason) {
  const pct = typeof s.pct === "number" ? ` <span class="pct">+${s.pct.toFixed(1)}%</span>` : "";
  const reason = withReason && s.reason ? `<span class="reason">— ${esc(s.reason)}</span>` : "";
  return `<span class="chip limitup"><span class="code">${esc(s.symbol)}</span><span class="name">${esc(s.name)}</span>${pct}${reason}</span>`;
}

function newsItem(n) {
  const sub = [n.source, relTime(n.pubDate)].filter(Boolean).join("・");
  return `<div class="news"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` +
    (sub ? ` <span class="news-sub">${esc(sub)}</span>` : "") + `</div>`;
}

function sectorSection(s, openSet) {
  const id = slug(s.sector);
  const open = openSet.has(s.sector) ? "open" : "";
  const lu = s.limitUpStocks || [];
  const luBadge = s.limitUpCount ? `<span class="b-lu">🔴 ${s.limitUpCount} 漲停</span>` : "";
  const newsBadge = s.newsCount ? `<span class="b-news">📰 ${s.newsCount}</span>` : "";
  // 收合時就能看到的漲停股預覽
  const preview = lu.slice(0, 16).map((x) => stockChip(x, false)).join("");
  const more = lu.length > 16 ? `<span class="more">+${lu.length - 16}</span>` : "";

  const stockBlock = lu.length
    ? `<div class="block-title">漲停股（${lu.length}）</div><div class="stocks">${lu.map((x) => stockChip(x, true)).join("")}</div>`
    : "";
  const newsList = (s.news || []);
  const newsBlock = newsList.length
    ? `<div class="block-title">相關新聞（${newsList.length}）</div><div class="news-list">${newsList.map(newsItem).join("")}</div>`
    : "";

  return `<details class="sector" id="${id}" data-sector="${esc(s.sector)}" ${open}>
    <summary>
      <span class="chev"></span>
      <span class="sector-name">${esc(s.sector)}</span>
      <span class="sector-badges">${luBadge}${newsBadge}</span>
      <div class="preview">${preview}${more}</div>
    </summary>
    <div class="body">${stockBlock}${newsBlock}</div>
  </details>`;
}

function loadOpen() { try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) || "[]")); } catch { return new Set(); } }
function saveOpen(set) { try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch {} }

function render(data) {
  const sectors = data.sectors || [];
  const mode = data.intraday ? "盤中即時" : "盤後";
  $status.innerHTML =
    `更新 ${esc(fmtTime(data.asOf))}　·　市場日 ${esc(data.marketDate || "")}（${mode}）　·　今日漲停 <b>${data.limitUpTotal || 0}</b> 檔` +
    (data.aiSource === "none" ? "　·　（未啟用 AI 分類）" : "");

  if (!sectors.length) {
    $app.innerHTML = `<div class="empty">目前尚無資料，請稍後再回來看看。</div>`;
    return;
  }

  let openSet = loadOpen();
  if (!localStorage.getItem(LS_KEY)) {
    // 預設展開：族群焦點 + 漲停最多的前 2 個族群
    openSet = new Set();
    const strong = sectors.filter((s) => s.limitUpCount > 0).slice(0, 2).map((s) => s.sector);
    for (const s of ["📌 熱門族群焦點", ...strong]) if (sectors.some((x) => x.sector === s)) openSet.add(s);
  }

  const pills = sectors.map((s) => {
    const n = s.limitUpCount ? `<span class="pill-lu">🔴${s.limitUpCount}</span>` : `<span class="pill-n">📰${s.newsCount}</span>`;
    return `<button class="pill" data-target="${slug(s.sector)}">${esc(s.sector)}${n}</button>`;
  }).join("");

  $app.innerHTML = `
    <div class="toolbar">
      <input id="filter" class="filter" type="search" placeholder="篩選：股號 / 股名 / 族群 / 標題…" />
      <button id="toggle-all" class="btn">全部展開</button>
    </div>
    <div class="rank"><span class="rank-label">強勢族群（依漲停家數）</span>${pills}</div>
    <div id="sections">${sectors.map((s) => sectorSection(s, openSet)).join("")}</div>`;
  wire();
}

function wire() {
  document.querySelectorAll("details.sector").forEach((d) => {
    d.addEventListener("toggle", () => {
      const set = loadOpen();
      const name = d.getAttribute("data-sector");
      if (d.open) set.add(name); else set.delete(name);
      saveOpen(set);
      syncToggleAllLabel();
    });
  });
  document.querySelectorAll(".pill").forEach((b) => {
    b.addEventListener("click", () => {
      const el = document.getElementById(b.dataset.target);
      if (!el) return;
      el.open = true;
      el.dispatchEvent(new Event("toggle"));
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  const $toggleAll = document.getElementById("toggle-all");
  $toggleAll.addEventListener("click", () => {
    const all = [...document.querySelectorAll("details.sector")];
    const anyClosed = all.some((d) => !d.open);
    all.forEach((d) => { d.open = anyClosed; d.dispatchEvent(new Event("toggle")); });
  });
  syncToggleAllLabel();
  const $filter = document.getElementById("filter");
  $filter.addEventListener("input", () => applyFilter($filter.value.trim()));
}

function syncToggleAllLabel() {
  const all = [...document.querySelectorAll("details.sector")];
  const btn = document.getElementById("toggle-all");
  if (btn) btn.textContent = all.some((d) => !d.open) ? "全部展開" : "全部收合";
}

function applyFilter(q) {
  const ql = q.toLowerCase();
  document.querySelectorAll("details.sector").forEach((d) => {
    const sector = (d.getAttribute("data-sector") || "").toLowerCase();
    const hit = !q || sector.includes(ql) || d.querySelector(".body")?.textContent.toLowerCase().includes(ql) ||
      d.querySelector(".preview")?.textContent.toLowerCase().includes(ql);
    d.style.display = hit ? "" : "none";
    if (q && hit) d.open = true;
  });
}

async function load() {
  try {
    const res = await fetch("news.json?_=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    render(await res.json());
  } catch (e) {
    $status.textContent = "載入失敗";
    $app.innerHTML = `<div class="empty">無法載入 news.json（${esc(e.message)}）</div>`;
  }
}

load();
