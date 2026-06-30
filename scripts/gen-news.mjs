// 今日漲停看板 + 熱門族群新聞 —— 每班（台北 11/12/13/14 點）執行一次。
//
// 核心＝「今日漲停股，依族群分組」：
//  1) 取今日全市場漲停股（盤中用 TWSE MIS 即時、盤後用 dated）。
//  2) 用 Gemini 把每檔漲停股分到族群（被動元件/AI伺服器/散熱…）+ 一句話原因；不確定者用官方產業別。
//  3) 依「漲停家數」排出強勢族群。
//  4) 為有漲停的族群＋「熱門族群焦點」抓 Google News（真實文章 URL）當佐證新聞。
//  5) 輸出 docs/news.json：sectors[] = { 族群, 漲停股清單, 相關新聞 }；新聞跨班累積、跨日封存。
//
// 韌性：任一步失敗時盡量保留既有 news.json，不覆蓋成空、不讓整個 job fail。

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ROOT, sleep, readKey, getText, callGemini, candidateText, parseJsonObjects,
  getTodayLimitUps, getStockUniverse,
} from "./lib/core.mjs";

const DOCS_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(DOCS_DIR, "news.json");
const HISTORY_DIR = path.join(DOCS_DIR, "history");

const MAX_NEWS_PER_KEYWORD = 6;    // 每關鍵字最多取幾則
const MAX_PER_SECTOR = 6;          // 每個族群一班最多收幾則（確保各族群都有覆蓋）
const MAX_NEWS_TOTAL = 90;         // 一班最多處理幾則（控管 Gemini 抽取量與 URL 解析時間）
const MAX_DAY_NEWS = 200;          // 一天內累積（跨班 merge）的新聞上限，避免資料檔膨脹

// 「族群焦點」：直接搜尋標題含這些字的「彙整型」新聞（媒體的熱門族群/盤面焦點專欄），
// 這是使用者字面想要的「標題含熱門族群」結果，永遠置頂為一個獨立分組。
const ROUNDUP_SECTOR = "📌 熱門族群焦點";
const ROUNDUP_KEYWORDS = ["熱門族群", "盤面焦點", "強勢族群"];

// 台北時間（cron 在 UTC 跑，這裡統一換算）。
function taipeiNow() {
  return new Date(Date.now() + 8 * 3600_000);
}
function taipeiISO(d = taipeiNow()) {
  return d.toISOString().replace("Z", "+08:00");
}
function taipeiDate(d = taipeiNow()) {
  return d.toISOString().slice(0, 10);
}

// ───────────────────────── 1) 固定族群分類（canonical taxonomy） ─────────────────────────

// 穩定的台股熱門族群清單：分組永遠一致、不漂移（取代每班 AI 重新命名的舊做法）。
// 強勢度改由「近 3 日漲停家數」客觀排序（見 summariseSectors）。要新增族群只改這份清單。
// keywords：用於 (a) Google News 標題搜尋、(b) 把新聞歸到此族群。
// 比對採「由上到下第一個命中」，故請把「具體」族群放前面、「廣義」族群（半導體）放最後，避免廣義詞先吃掉。
const CANONICAL_SECTORS = [
  { sector: "散熱", keywords: ["散熱", "均熱片", "水冷"] },
  { sector: "AI 伺服器", keywords: ["AI伺服器", "AI 伺服器"] },
  { sector: "矽晶圓", keywords: ["矽晶圓"] },
  { sector: "PCB / 載板", keywords: ["ABF載板", "載板", "銅箔基板", "PCB"] },
  { sector: "光通訊 / CPO", keywords: ["CPO", "矽光子", "光通訊", "光收發"] },
  { sector: "玻璃基板", keywords: ["玻璃基板"] },
  { sector: "記憶體", keywords: ["記憶體", "DRAM", "NAND", "HBM"] },
  { sector: "被動元件", keywords: ["被動元件", "MLCC"] },
  { sector: "IP / 矽智財", keywords: ["矽智財", "IC設計"] },
  { sector: "先進封裝 / 封測", keywords: ["先進封裝", "CoWoS", "封測"] },
  { sector: "軍工 / 無人機", keywords: ["無人機", "軍工", "國防"] },
  { sector: "機器人", keywords: ["人形機器人", "機器人"] },
  { sector: "重電 / 電力", keywords: ["重電", "電網", "電力設備"] },
  { sector: "綠能 / 儲能", keywords: ["儲能", "太陽能", "風電", "綠能"] },
  { sector: "航運", keywords: ["航運", "貨櫃", "散裝"] },
  { sector: "生技醫療", keywords: ["生技", "新藥", "醫材"] },
  { sector: "面板 / OLED", keywords: ["面板", "OLED"] },
  { sector: "半導體 / 晶圓代工", keywords: ["晶圓代工", "半導體"] },
];

// 官方產業別 → canonical 族群名（讓「Gemini 分到 canonical」與「退回官方產業」不會分成兩組）。
const INDUSTRY_TO_CANON = {
  "半導體": "半導體 / 晶圓代工",
};
function normalizeSectorName(name) {
  return INDUSTRY_TO_CANON[name] || name;
}

// ───────────────────────── 2~3) Google News RSS ─────────────────────────

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/g) ?? []) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? decodeEntities(m[1]) : "";
    };
    const title = pick("title");
    const link = pick("link");
    const pubDate = pick("pubDate");
    const source = pick("source");
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

/** 取 Google News 文章的穩定 id（轉址成不成功都不變），作為跨班去重鍵。 */
function googleArticleId(link) {
  try {
    if (/news\.google\.com/.test(link)) return new URL(link).pathname.split("/").pop();
  } catch {}
  return link;
}

const redirectCache = new Map();

const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * 把 Google News 文章連結解析成真實文章 URL。
 * 新版 Google News 的 /articles/<id> 是編碼過的：需先抓文章頁取得簽章(data-n-a-sg)與時間戳
 * (data-n-a-ts)，再 POST 到 batchexecute 端點換回真實 URL。失敗則退回原連結。
 */
async function resolveUrl(link) {
  if (!/news\.google\.com/.test(link)) return link;
  if (redirectCache.has(link)) return redirectCache.get(link);
  let resolved = link;
  try {
    const id = new URL(link).pathname.split("/").pop();
    const pageRes = await fetch(`https://news.google.com/rss/articles/${id}`, {
      headers: { "User-Agent": UA_BROWSER },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await pageRes.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/);
    const ts = html.match(/data-n-a-ts="([^"]+)"/);
    if (sg && ts) {
      const req = [
        "Fbv4je",
        `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts[1]},"${sg[1]}"]`,
      ];
      const body = "f.req=" + encodeURIComponent(JSON.stringify([[req]]));
      const res2 = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": UA_BROWSER,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res2.text();
      const arr = JSON.parse(text.split("\n\n")[1]);
      const decoded = JSON.parse(arr[0][2]);
      if (decoded?.[1] && /^https?:\/\//.test(decoded[1])) resolved = decoded[1];
    }
  } catch (e) {
    console.warn(`  轉址解析失敗（退回原連結）：${e.message}`);
  }
  redirectCache.set(link, resolved);
  return resolved;
}

async function fetchNewsForKeyword(keyword) {
  const q = encodeURIComponent(`${keyword} when:1d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  let xml;
  try {
    xml = await getText(url);
  } catch (e) {
    console.warn(`  RSS 抓取失敗（${keyword}）：${e.message}`);
    return [];
  }
  const items = parseRssItems(xml)
    // 落實需求：只留「標題含該族群關鍵字」的新聞。
    .filter((it) => it.title.includes(keyword))
    .slice(0, MAX_NEWS_PER_KEYWORD);
  return items;
}

// ───────────────────────── 漲停股 → 族群分類 + 原因（Gemini） ─────────────────────────

/**
 * 把今日漲停股逐檔分到「族群」並給一句話原因。
 * 族群優先從 CANONICAL_SECTORS 名稱挑（精細、與新聞分組一致）；Gemini 不確定者退回官方產業別。
 * 回傳 [{ symbol, name, pct, sector, reason }]。
 */
async function classifyLimitUps(ups, universe, apiKey) {
  const fallback = (sym) => normalizeSectorName(universe.get(sym)?.industry || "其他");
  if (!apiKey || ups.length === 0) {
    return ups.map((u) => ({ ...u, sector: fallback(u.symbol), reason: "" }));
  }
  const names = CANONICAL_SECTORS.map((s) => s.sector).join("、");
  const lines = ups.map((u) => `${u.symbol} ${u.name}`).join("\n");
  const prompt = `以下是今天台股「漲停」的個股（代碼 名稱）：
${lines}

逐檔做兩件事，繁體中文：
1. sector：從這份族群清單挑「一個」最貼切的：${names}。若都不貼切就回空字串 ""。同族群務必用清單上「完全一致」的字串。
2. reason：一句話（20 字內）說明今天為何強勢/漲停的可能題材或催化劑（用你的知識，務實具體）。
只輸出 JSON 陣列：[{"symbol":"2327","sector":"被動元件","reason":"MLCC 漲價、記憶體外溢題材"}]，不要其他文字或 markdown。`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  };
  const map = new Map();
  try {
    const data = await callGemini(apiKey, body);
    for (const it of parseJsonObjects(candidateText(data))) {
      if (it.symbol) map.set(String(it.symbol).trim(), { sector: String(it.sector ?? "").trim(), reason: String(it.reason ?? "").trim() });
    }
  } catch (e) {
    console.warn(`漲停分類失敗：${e.message}（改用官方產業別分組）`);
  }
  const canonSet = new Set(CANONICAL_SECTORS.map((s) => s.sector));
  return ups.map((u) => {
    const c = map.get(u.symbol);
    const sector = c && canonSet.has(c.sector) ? c.sector : fallback(u.symbol);
    return { ...u, sector, reason: c?.reason || "" };
  });
}

// ───────────────────────── merge 與輸出 ─────────────────────────

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 組出每個族群的卡片：{ sector, limitUpStocks(漲停股，依漲幅排序), news(相關新聞), 計數 }。
 * 排序：📌 族群焦點置頂 → 漲停家數多者優先 → 新聞多者優先。
 */
function buildSectors(classified, news) {
  const map = new Map();
  const get = (s) => {
    if (!map.has(s)) map.set(s, { sector: s, limitUpStocks: [], news: [] });
    return map.get(s);
  };
  for (const c of classified) {
    get(c.sector).limitUpStocks.push({ symbol: c.symbol, name: c.name, pct: Math.round(c.pct * 10) / 10, reason: c.reason });
  }
  for (const n of news) get(n.sector).news.push(n);

  let arr = [...map.values()].map((s) => {
    s.limitUpStocks.sort((a, b) => b.pct - a.pct);
    s.limitUpCount = s.limitUpStocks.length;
    s.newsCount = s.news.length;
    return s;
  });

  // 把「沒新聞、且漲停 ≤ 2 檔」的零碎產業別併進「其他」，避免一堆 1 檔的長尾分組。
  const OTHER = "其他";
  const keep = [];
  let other = map.get(OTHER) || { sector: OTHER, limitUpStocks: [], news: [] };
  let folded = false;
  for (const s of arr) {
    if (s.sector === OTHER) { folded = true; continue; }
    if (s.sector !== ROUNDUP_SECTOR && s.newsCount === 0 && s.limitUpCount <= 2) {
      other.limitUpStocks.push(...s.limitUpStocks);
      folded = true;
    } else {
      keep.push(s);
    }
  }
  if (folded && other.limitUpStocks.length) {
    other.limitUpStocks.sort((a, b) => b.pct - a.pct);
    other.limitUpCount = other.limitUpStocks.length;
    other.newsCount = 0;
    keep.push(other);
  }

  keep.sort((a, b) => {
    const ar = a.sector === ROUNDUP_SECTOR ? 1 : 0;
    const br = b.sector === ROUNDUP_SECTOR ? 1 : 0;
    if (ar !== br) return br - ar;
    const ao = a.sector === OTHER ? 1 : 0;
    const bo = b.sector === OTHER ? 1 : 0;
    if (ao !== bo) return ao - bo; // 其他永遠墊底
    return b.limitUpCount - a.limitUpCount || b.newsCount - a.newsCount;
  });
  return keep;
}

async function main() {
  const apiKey = await readKey("GEMINI_API_KEY");
  const today = taipeiDate();
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  // 1) 今日漲停看板（盤中 MIS 即時 / 盤後 dated）
  const universe = await getStockUniverse();
  const { date: marketDate, intraday, limitUps } = await getTodayLimitUps();
  console.log(`市場日 ${marketDate}（${intraday ? "盤中即時" : "盤後"}）：今日漲停 ${limitUps.length} 檔。`);

  // 2) 把漲停股分到族群 + 一句話原因
  const classified = await classifyLimitUps(limitUps, universe, apiKey);
  const hotSectors = new Set(classified.map((c) => c.sector));
  console.log(`分到 ${hotSectors.size} 個族群：${[...hotSectors].slice(0, 12).join("、")}`);

  // 3) 為「族群焦點」＋「今天有漲停的 canonical 族群」抓佐證新聞（真實文章 URL）
  const seen = new Set();
  const collected = [];
  const collect = async (items, sector, { isRoundup = false, max = MAX_PER_SECTOR } = {}) => {
    let added = 0;
    for (const it of items) {
      if (collected.length >= MAX_NEWS_TOTAL || added >= max) break;
      const gid = googleArticleId(it.link);
      if (seen.has(gid)) continue;
      seen.add(gid);
      const url = await resolveUrl(it.link);
      collected.push({ gid, title: it.title, url, source: it.source, pubDate: it.pubDate, sector, ...(isRoundup ? { isRoundup: true } : {}) });
      added++;
    }
    return added;
  };

  for (const kw of ROUNDUP_KEYWORDS) {
    await collect(await fetchNewsForKeyword(kw), ROUNDUP_SECTOR, { isRoundup: true, max: 8 });
    await sleep(250);
  }
  for (const def of CANONICAL_SECTORS) {
    if (collected.length >= MAX_NEWS_TOTAL) break;
    if (!hotSectors.has(def.sector)) continue; // 只抓今天有漲停的族群，聚焦今日強勢
    let perSec = 0;
    for (const kw of def.keywords) {
      if (perSec >= MAX_PER_SECTOR || collected.length >= MAX_NEWS_TOTAL) break;
      perSec += await collect(await fetchNewsForKeyword(kw), def.sector, { max: MAX_PER_SECTOR - perSec });
      await sleep(250);
    }
  }
  console.log(`本班抓到 ${collected.length} 則佐證新聞。`);

  // 4) 新聞跨班累積（同日 merge、跨日封存）；只保留屬於今日強勢族群或焦點者
  const existing = await readExisting();
  let priorNews = [];
  if (existing && typeof existing.asOf === "string" && existing.asOf.slice(0, 10) === today) {
    priorNews = Array.isArray(existing.news) ? existing.news : [];
  } else if (existing?.asOf) {
    const oldDate = existing.asOf.slice(0, 10);
    try {
      await fs.writeFile(path.join(HISTORY_DIR, `${oldDate}.json`), JSON.stringify(existing, null, 2), "utf8");
      console.log(`封存前一日 ${oldDate} 至 history/。`);
    } catch {}
  }

  // 完全沒漲停資料且沒新聞、又已有當日資料 → 保留既有，不覆蓋成空。
  if (limitUps.length === 0 && collected.length === 0 && (existing?.sectors?.length ?? 0) > 0) {
    console.log("本班無漲停與新聞資料，保留既有當日內容。");
    return;
  }

  const allowed = new Set([...hotSectors, ROUNDUP_SECTOR]);
  const byKey = new Map();
  for (const n of priorNews) byKey.set(n.gid || n.url, n);
  for (const n of collected) byKey.set(n.gid || n.url, n);
  const mergedNews = [...byKey.values()]
    .filter((n) => allowed.has(n.sector))
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, MAX_DAY_NEWS);

  const out = {
    asOf: taipeiISO(),
    generatedAt: new Date().toISOString(),
    marketDate,
    intraday,
    limitUpTotal: classified.length,
    aiSource: apiKey ? "gemini" : "none",
    sectors: buildSectors(classified, mergedNews),
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`已寫入 ${path.relative(ROOT, OUT_FILE)}：漲停 ${classified.length} 檔 / ${out.sectors.length} 族群 / 新聞 ${mergedNews.length} 則。`);
}

main().catch((e) => {
  console.error("gen-news 失敗：", e);
  process.exit(1);
});
