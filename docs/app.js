// 純前端：讀 news.json，依「強勢族群」分組、可收合、可篩選。無建置步驟。

const $app = document.getElementById("app");
const $status = document.getElementById("status");
const LS_KEY = "twhsn-open-sectors";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function slug(s) {
  return "sec-" + encodeURIComponent(String(s)).replace(/[^a-zA-Z0-9]/g, "");
}
function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
}
function relTime(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d)) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)} 分前`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小時前`;
  return d.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
}

// 個股 chip（含原因）；漲停以紅框 + 🔴 標記。
function chip(s, withReason) {
  const lu = s.limitUp3d
    ? `<span class="badge-lu" title="近 3 日漲停：${esc((s.limitUpDates || []).join("、"))}">🔴漲停</span>`
    : "";
  const reason = withReason && s.reason ? `<span class="reason">— ${esc(s.reason)}</span>` : "";
  return `<span class="chip ${s.limitUp3d ? "limitup" : ""}">` +
    `<span class="code">${esc(s.symbol)}</span><span class="name">${esc(s.name)}</span>${reason}${lu}</span>`;
}

function newsCard(n) {
  const stocks = (n.stocks || []).length
    ? `<div class="stocks">${n.stocks.map((s) => chip(s, true)).join("")}</div>`
    : `<div class="no-stocks">（本則未明確點到個股）</div>`;
  const sub = [n.source, relTime(n.pubDate)].filter(Boolean).join("・");
  return `<article class="news">
    <div class="news-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
    <div class="news-sub">${esc(sub)}</div>
    ${stocks}
  </article>`;
}

const NEWS_CAP = 15; // 每個族群展開後先顯示幾則，其餘收進「顯示更多」

function sectorSection(meta, items, openSet) {
  const id = slug(meta.sector);
  const open = openSet.has(meta.sector) ? "open" : "";
  const luBadge = meta.limitUpCount ? `<span class="b-lu">🔴 ${meta.limitUpCount} 漲停</span>` : "";
  // 收合時也能看到的「族群強勢股」預覽（漲停在前，最多 14 檔）
  const preview = (meta.stocks || []).slice(0, 14).map((s) => chip(s, false)).join("");
  const more = (meta.stocks || []).length > 14 ? `<span class="more">+${meta.stocks.length - 14}</span>` : "";
  const head = items.slice(0, NEWS_CAP).map(newsCard).join("");
  const rest = items.slice(NEWS_CAP);
  const restHtml = rest.length
    ? `<div class="more-news" hidden>${rest.map(newsCard).join("")}</div>` +
      `<button class="show-more">顯示其餘 ${rest.length} 則 ▾</button>`
    : "";
  return `<details class="sector" id="${id}" data-sector="${esc(meta.sector)}" ${open}>
    <summary>
      <span class="chev"></span>
      <span class="sector-name">${esc(meta.sector)}</span>
      <span class="sector-badges">${luBadge}<span class="b-news">${items.length} 則</span></span>
      <div class="preview">${preview}${more}</div>
    </summary>
    <div class="news-list">${head}${restHtml}</div>
  </details>`;
}

function loadOpen() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) || "[]")); } catch { return new Set(); }
}
function saveOpen(set) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch {}
}

let DATA = null;

function render(data) {
  DATA = data;
  const news = data.news || [];
  const days = (data.tradingDaysChecked || []).join("、");
  $status.innerHTML =
    `更新 ${esc(fmtTime(data.asOf))}　·　${news.length} 則新聞　·　${(data.sectors || []).length} 族群` +
    (days ? `　·　漲停比對 ${esc(days)}` : "") +
    (data.aiSource === "none" ? "　·　（未啟用 AI 判讀）" : "");

  if (!news.length) {
    $app.innerHTML = `<div class="empty">目前尚無新聞資料，請稍後再回來看看。</div>`;
    return;
  }

  // 依族群分組
  const groups = new Map();
  for (const n of news) {
    const k = n.sector || "其他";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  // 排序：照 data.sectors（族群焦點置頂、再依強勢度），補上未列到的
  const order = (data.sectors || []).map((s) => s.sector);
  const metaBy = new Map((data.sectors || []).map((s) => [s.sector, s]));
  const keys = [...new Set([...order, ...groups.keys()])].filter((k) => groups.has(k));

  // 預設展開：尚無記憶時，展開「族群焦點」+ 最強勢的第一個族群
  let openSet = loadOpen();
  if (!localStorage.getItem(LS_KEY)) {
    openSet = new Set();
    if (groups.has("📌 熱門族群焦點")) openSet.add("📌 熱門族群焦點");
    const firstStrong = keys.find((k) => k !== "📌 熱門族群焦點");
    if (firstStrong) openSet.add(firstStrong);
  }

  // 強勢族群排行 pills
  const pills = keys.map((k) => {
    const m = metaBy.get(k) || { sector: k, limitUpCount: 0 };
    const lu = m.limitUpCount ? `<span class="pill-lu">🔴${m.limitUpCount}</span>` : "";
    return `<button class="pill" data-target="${slug(k)}">${esc(k)}${lu}<span class="pill-n">${groups.get(k).length}</span></button>`;
  }).join("");

  const sections = keys.map((k) => sectorSection(metaBy.get(k) || { sector: k, limitUpCount: 0, stocks: [] }, groups.get(k), openSet)).join("");

  $app.innerHTML = `
    <div class="toolbar">
      <input id="filter" class="filter" type="search" placeholder="篩選：股號 / 股名 / 族群 / 標題…" />
      <button id="toggle-all" class="btn">全部展開</button>
    </div>
    <div class="rank"><span class="rank-label">強勢族群</span>${pills}</div>
    <div id="sections">${sections}</div>`;

  wire();
}

function wire() {
  // 記憶收合狀態
  document.querySelectorAll("details.sector").forEach((d) => {
    d.addEventListener("toggle", () => {
      const set = loadOpen();
      const name = d.getAttribute("data-sector");
      if (d.open) set.add(name); else set.delete(name);
      saveOpen(set);
      syncToggleAllLabel();
    });
  });

  // 排行 pill → 展開並捲動
  document.querySelectorAll(".pill").forEach((b) => {
    b.addEventListener("click", () => {
      const el = document.getElementById(b.dataset.target);
      if (!el) return;
      el.open = true;
      el.dispatchEvent(new Event("toggle"));
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // 顯示其餘 N 則
  document.querySelectorAll(".show-more").forEach((b) => {
    b.addEventListener("click", () => {
      const box = b.previousElementSibling;
      if (box && box.classList.contains("more-news")) box.hidden = false;
      b.remove();
    });
  });

  // 全部展開 / 收合
  const $toggleAll = document.getElementById("toggle-all");
  $toggleAll.addEventListener("click", () => {
    const all = [...document.querySelectorAll("details.sector")];
    const anyClosed = all.some((d) => !d.open);
    all.forEach((d) => { d.open = anyClosed; d.dispatchEvent(new Event("toggle")); });
  });
  syncToggleAllLabel();

  // 篩選
  const $filter = document.getElementById("filter");
  $filter.addEventListener("input", () => applyFilter($filter.value.trim()));
}

function syncToggleAllLabel() {
  const all = [...document.querySelectorAll("details.sector")];
  const anyClosed = all.some((d) => !d.open);
  const btn = document.getElementById("toggle-all");
  if (btn) btn.textContent = anyClosed ? "全部展開" : "全部收合";
}

function applyFilter(q) {
  const ql = q.toLowerCase();
  // 篩選時把「顯示其餘」的隱藏新聞也放出來，避免漏掉命中項。
  document.querySelectorAll(".more-news").forEach((b) => { if (q) b.hidden = false; });
  document.querySelectorAll("details.sector").forEach((d) => {
    const sector = d.getAttribute("data-sector") || "";
    let visibleNews = 0;
    d.querySelectorAll(".news").forEach((card) => {
      const hit = !q || card.textContent.toLowerCase().includes(ql) || sector.toLowerCase().includes(ql);
      card.style.display = hit ? "" : "none";
      if (hit) visibleNews++;
    });
    const sectorHit = !q || sector.toLowerCase().includes(ql);
    const show = !q || sectorHit || visibleNews > 0;
    d.style.display = show ? "" : "none";
    if (q && show) d.open = true; // 篩選時自動展開命中區塊
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
