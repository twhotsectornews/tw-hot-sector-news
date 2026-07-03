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

const STATUS_CLASS = { "創新高": "st-new", "逼近新高": "st-near", "高檔修正": "st-pull" };

function patternTag(s) {
  if (!s.status) return `<span class="tag"></span>`;
  const cls = STATUS_CLASS[s.status] || "st-near";
  const tip = typeof s.dist === "number" ? `距歷史高點 ${s.dist}%` : "";
  return `<span class="tag ${cls}" title="${esc(tip)}">${esc(s.status)}</span>`;
}

/** 漲停欄：今日漲停（紅）＞ 近一週漲停（淡紅）＞ 空。 */
function luCell(s) {
  const luTip = s.luw ? `近一週漲停：${(s.luwd || []).join("、")}` : "";
  if (s.limitUp) return `<span class="lu" title="${esc(luTip)}">漲停${typeof s.pct === "number" ? ` +${s.pct.toFixed(1)}%` : ""}</span>`;
  if (s.luw) return `<span class="lu lu-past" title="${esc(luTip)}">週${s.luw}停</span>`;
  return `<span class="lu-none"></span>`;
}

function stockRow(s) {
  const point = s.point ? `<span class="point">${esc(s.point)}</span>` : "";
  return `<li class="stk${s.limitUp ? " is-lu" : ""}">` +
    `<span class="tkr"><span class="code">${esc(s.symbol)}</span><span class="name">${esc(s.name)}</span></span>` +
    `${patternTag(s)}${luCell(s)}${point}</li>`;
}

/** 7日常客榜的一列：代碼名稱 │ ×N天 │ 型態 │ 漲停。 */
function hot7Row(s) {
  const tip = `出現日：${(s.dates || []).join("、")}（共 ${s.mentions ?? "?"} 則）`;
  return `<li class="stk${s.limitUp ? " is-lu" : ""}">` +
    `<span class="tkr"><span class="code">${esc(s.symbol)}</span><span class="name">${esc(s.name)}</span></span>` +
    `<span class="h7" title="${esc(tip)}">×${s.days}天</span>` +
    `${patternTag(s)}${luCell(s)}</li>`;
}

const THEME_TAG_CLASS = { "需求驅動": "tt-demand", "國際大廠": "tt-global", "政策關稅": "tt-policy", "循環位置": "tt-cycle" };

function themeBlock(n) {
  const bg = (n.background || "").trim();
  const tags = (n.themeTags || [])
    .map((t) => `<span class="ttag ${THEME_TAG_CLASS[t] || ""}">${esc(t)}</span>`)
    .join("");
  if (!bg && !tags) return "";
  return `<div class="theme">
    ${bg ? `<p class="theme-text">${esc(bg)} <span class="theme-ai">AI 整理</span></p>` : ""}
    ${tags ? `<div class="ttags">${tags}</div>` : ""}
  </div>`;
}

function newsCard(n) {
  const stocks = (n.stocks || []).length
    ? `<ul class="stocks">${n.stocks.map(stockRow).join("")}</ul>`
    : `<div class="no-stocks">（本則未明確點到個股）</div>`;
  const sub = [n.source, relTime(n.pubDate)].filter(Boolean).join("・");
  return `<article class="news">
    <div class="news-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
    <div class="news-sub">${esc(sub)}</div>
    ${themeBlock(n)}
    ${stocks}
  </article>`;
}

// 台北日輔助（與後端一致：pubDate → YYYY-MM-DD）
const tpDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
function newsDay(n) {
  const t = new Date(n.pubDate ?? 0).getTime();
  return Number.isFinite(t) && t > 0 ? tpDay(t) : tpDay(Date.now());
}
function dayLabel(day) {
  const today = tpDay(Date.now()), yesterday = tpDay(Date.now() - 86400e3);
  const wd = new Intl.DateTimeFormat("zh-TW", { weekday: "short", timeZone: "Asia/Taipei" })
    .format(new Date(day + "T12:00:00+08:00"));
  const md = `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;
  if (day === today) return `今天 ${md}（${wd}）`;
  if (day === yesterday) return `昨天 ${md}（${wd}）`;
  return `${md}（${wd}）`;
}

/** 資料過期提示：平日超過 26 小時沒更新就示警（跨週末放寬到 78 小時）。 */
function staleBanner(asOf) {
  const t = new Date(asOf).getTime();
  if (!Number.isFinite(t)) return "";
  const hrs = (Date.now() - t) / 3600e3;
  const dow = new Date(Date.now() + 8 * 3600e3).getUTCDay(); // 台北星期（0=日）
  const limit = (dow === 0 || dow === 6 || dow === 1) ? 78 : 26;
  if (hrs <= limit) return "";
  return `<div class="stale">⚠ 資料已約 ${Math.round(hrs)} 小時未更新，來源或排程可能暫時故障。</div>`;
}

function render(data) {
  const news = data.news || [];
  $status.innerHTML = `更新 ${esc(fmtTime(data.asOf))}　·　${news.length} 則　·　<b>族群題材</b>＋月K型態、漲停與近一週漲停` +
    (data.aiSource === "none" ? "　·　（未啟用 AI 判讀）" : "");

  if (!news.length) {
    $app.innerHTML = staleBanner(data.asOf) +
      `<div class="empty">目前尚無「熱門族群」新聞，請稍後再回來看看。</div>`;
    return;
  }

  // 按台北日分組（資料端已排序、只留今天＋前一發布日）
  const groups = new Map();
  for (const n of news) {
    const d = newsDay(n);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(n);
  }
  const sections = [...groups.entries()].map(([d, items]) => `
    <section class="day-sec">
      <h2 class="day-head">${esc(dayLabel(d))}<span class="day-count">${items.length} 則</span></h2>
      ${items.map(newsCard).join("")}
    </section>`).join("");

  // 7日常客榜（近 7 天出現 ≥ 2 天的個股）
  const hot7 = data.hot7 || [];
  const hot7Html = hot7.length ? `
    <section class="hot7">
      <h2 class="day-head">🔥 7日常客<span class="day-count">近 7 天出現 ≥ 2 天・依天數排序</span></h2>
      <ul class="stocks">${hot7.map(hot7Row).join("")}</ul>
    </section>` : "";

  $app.innerHTML = staleBanner(data.asOf) + hot7Html + `
    <div class="toolbar">
      <input id="filter" class="filter" type="search" placeholder="篩選：股號 / 股名 / 標題…" />
    </div>
    <div id="list">${sections}</div>`;

  const $filter = document.getElementById("filter");
  $filter.addEventListener("input", () => {
    const q = $filter.value.trim().toLowerCase();
    document.querySelectorAll("#list .news").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
    // 整組都被濾掉時連日期標頭一起藏
    document.querySelectorAll("#list .day-sec").forEach((sec) => {
      const any = [...sec.querySelectorAll(".news")].some((el) => el.style.display !== "none");
      sec.style.display = any ? "" : "none";
    });
    // 常客榜同步篩選；全空就藏整個區塊
    document.querySelectorAll(".hot7 .stk").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
    const hotSec = document.querySelector(".hot7");
    if (hotSec) {
      const any = [...hotSec.querySelectorAll(".stk")].some((el) => el.style.display !== "none");
      hotSec.style.display = any ? "" : "none";
    }
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
