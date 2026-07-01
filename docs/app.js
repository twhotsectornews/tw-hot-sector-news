// 純前端：讀 news.json，列出「熱門族群」新聞，每則附提到的個股 + 重點。無建置步驟。

const $app = document.getElementById("app");
const $status = document.getElementById("status");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function fmtTime(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" }); }
function relTime(p) {
  const d = new Date(p); if (isNaN(d)) return "";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 60) return `${Math.max(m, 0)} 分前`;
  if (m < 1440) return `${Math.round(m / 60)} 小時前`;
  return d.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
}

function stockRow(s) {
  const lu = s.limitUp
    ? `<span class="lu">漲停${typeof s.pct === "number" ? ` +${s.pct.toFixed(1)}%` : ""}</span>`
    : `<span class="lu-none"></span>`;
  const point = s.point ? `<span class="point">${esc(s.point)}</span>` : "";
  return `<li class="stk${s.limitUp ? " is-lu" : ""}">` +
    `<span class="tkr"><span class="code">${esc(s.symbol)}</span><span class="name">${esc(s.name)}</span></span>` +
    `${lu}${point}</li>`;
}

function newsCard(n) {
  const stocks = (n.stocks || []).length
    ? `<ul class="stocks">${n.stocks.map(stockRow).join("")}</ul>`
    : `<div class="no-stocks">（本則未明確點到個股）</div>`;
  const sub = [n.source, relTime(n.pubDate)].filter(Boolean).join("・");
  return `<article class="news">
    <div class="news-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
    <div class="news-sub">${esc(sub)}</div>
    ${stocks}
  </article>`;
}

function render(data) {
  const news = data.news || [];
  $status.innerHTML = `更新 ${esc(fmtTime(data.asOf))}　·　${news.length} 則熱門族群新聞` +
    (data.aiSource === "none" ? "　·　（未啟用 AI 個股判讀）" : "");

  if (!news.length) {
    $app.innerHTML = `<div class="empty">目前尚無「熱門族群」新聞，請稍後再回來看看。</div>`;
    return;
  }

  $app.innerHTML = `
    <div class="toolbar">
      <input id="filter" class="filter" type="search" placeholder="篩選：股號 / 股名 / 標題…" />
    </div>
    <div id="list">${news.map(newsCard).join("")}</div>`;

  const $filter = document.getElementById("filter");
  $filter.addEventListener("input", () => {
    const q = $filter.value.trim().toLowerCase();
    document.querySelectorAll("#list .news").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
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
