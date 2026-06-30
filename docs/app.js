// 純前端：讀 news.json，依族群分組渲染。無建置步驟。

const $app = document.getElementById("app");
const $status = document.getElementById("status");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
}

function relTime(pubDate) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (isNaN(d)) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)} 分鐘前`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小時前`;
  return d.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
}

function chip(s) {
  const lu = s.limitUp3d
    ? `<span class="badge-lu" title="近 3 日漲停：${esc((s.limitUpDates || []).join("、"))}">🔴 漲停</span>`
    : "";
  const reason = s.reason ? `<span class="reason">— ${esc(s.reason)}</span>` : "";
  return `<span class="chip ${s.limitUp3d ? "limitup" : ""}">
    <span class="code">${esc(s.symbol)}</span>
    <span class="name">${esc(s.name)}</span>
    ${reason}${lu}
  </span>`;
}

function newsCard(n) {
  const stocks = (n.stocks || []).length
    ? `<div class="stocks">${n.stocks.map(chip).join("")}</div>`
    : `<div class="no-stocks">（本則未明確點到個股）</div>`;
  const sub = [n.source, relTime(n.pubDate)].filter(Boolean).join("・");
  return `<article class="news">
    <div class="news-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
    <div class="news-sub">${esc(sub)}</div>
    ${stocks}
  </article>`;
}

function sectorBlock(sectorName, meta, items) {
  const lu = meta && meta.limitUpCount
    ? `<span class="lu">🔴 ${meta.limitUpCount} 檔漲停</span>・`
    : "";
  return `<section class="sector">
    <div class="sector-head">
      <span class="sector-name">${esc(sectorName)}</span>
      <span class="sector-meta">${lu}${items.length} 則新聞</span>
    </div>
    ${items.map(newsCard).join("")}
  </section>`;
}

function render(data) {
  const news = data.news || [];
  const days = (data.tradingDaysChecked || []).join("、");
  $status.innerHTML =
    `更新：${esc(fmtTime(data.asOf))}　|　${news.length} 則新聞` +
    (days ? `　|　漲停比對交易日：${esc(days)}` : "") +
    (data.aiSource === "none" ? "　|　（未啟用 AI 個股判讀）" : "");

  if (!news.length) {
    $app.innerHTML = `<div class="empty">目前尚無新聞資料，請稍後再回來看看。</div>`;
    return;
  }

  // 依 sectors 摘要的順序分組（強勢在前）；新聞依族群歸位。
  const order = (data.sectors || []).map((s) => s.sector);
  const metaBy = new Map((data.sectors || []).map((s) => [s.sector, s]));
  const groups = new Map();
  for (const n of news) {
    const k = n.sector || "其他";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  // 先照 sectors 排序，再補上沒列在 sectors 的族群。
  const keys = [...new Set([...order, ...groups.keys()])].filter((k) => groups.has(k));
  $app.innerHTML = keys.map((k) => sectorBlock(k, metaBy.get(k), groups.get(k))).join("");
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
