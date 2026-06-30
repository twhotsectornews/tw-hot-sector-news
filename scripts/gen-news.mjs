// 熱門族群新聞彙整 —— 每班（台北 11/12/13/14 點）執行一次。
//
// 流程：
//  1) 用 Gemini（grounded）判定「今日台股強勢/熱門族群」+ 搜尋關鍵字（失敗則用內建後備清單）。
//  2) 對每個關鍵字打 Google News RSS，取真實新聞（標題/連結/來源/時間）；只留「標題含關鍵字」者。
//  3) 解析 Google News 轉址 → 真實文章 URL；跨族群以最終 URL 去重。
//  4) 用 Gemini（無 grounding）逐則抽出提到的個股（代碼+名稱）與被提及原因。
//  5) 打 TWSE/TPEx OpenAPI 取近 3 個交易日全市場資料 → 標記個股「近 3 日漲停」。
//  6) merge 進當日 docs/news.json（以 URL 去重、累積整天輪班）；跨日則封存舊檔。
//
// 韌性：Gemini / RSS 任一步失敗時，盡量保留既有 news.json，不覆蓋成空、不讓整個 job fail。

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ROOT, sleep, readKey, getText, callGemini, candidateText, parseJsonObjects,
  isCommonStock, getRecentLimitUps,
} from "./lib/core.mjs";

const DOCS_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(DOCS_DIR, "news.json");
const HISTORY_DIR = path.join(DOCS_DIR, "history");

const MAX_KEYWORDS = 12;           // 一班最多搜尋幾個關鍵字（控管 RSS 請求數）
const MAX_NEWS_PER_KEYWORD = 6;    // 每關鍵字最多取幾則
const MAX_NEWS_TOTAL = 60;         // 一班最多處理幾則（控管 Gemini 抽取量）

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

// ───────────────────────── 1) 熱門族群 ─────────────────────────

// Gemini 不可用 / 失敗時的後備族群清單（涵蓋台股常見強勢題材）。
const FALLBACK_SECTORS = [
  { sector: "AI 伺服器", keywords: ["AI伺服器", "AI 伺服器"] },
  { sector: "散熱", keywords: ["散熱"] },
  { sector: "PCB / 載板", keywords: ["PCB", "ABF載板"] },
  { sector: "光通訊 / CPO", keywords: ["光通訊", "CPO"] },
  { sector: "半導體 / 矽智財", keywords: ["矽智財", "先進封裝"] },
  { sector: "記憶體", keywords: ["記憶體", "DRAM"] },
  { sector: "重電 / 電力", keywords: ["重電"] },
  { sector: "軍工國防", keywords: ["軍工", "國防"] },
  { sector: "機器人", keywords: ["機器人", "人形機器人"] },
  { sector: "航運", keywords: ["航運", "貨櫃"] },
  { sector: "生技新藥", keywords: ["生技", "新藥"] },
  { sector: "被動元件", keywords: ["被動元件"] },
];

async function detectHotSectors(apiKey) {
  if (!apiKey) {
    console.log("（無 GEMINI_API_KEY）使用後備族群清單。");
    return FALLBACK_SECTORS;
  }
  const prompt = `今天是台股交易日。請用 Google 搜尋，找出「今天盤中最強勢/最熱門的族群題材」（資金集中、漲幅領先、新聞熱度高者），由強到弱排序，最多 8 個。
每個族群給：sector（族群名，繁體中文）、keywords（1~2 個「可在新聞標題搜尋到」的精簡關鍵字，繁體中文，例如「AI伺服器」「散熱」「矽光子」）。
只輸出 JSON 陣列：[{"sector":"...","keywords":["...","..."]}]，不要任何其他文字或 markdown。`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
  };
  try {
    const data = await callGemini(apiKey, body);
    const arr = parseJsonObjects(candidateText(data));
    const sectors = [];
    for (const it of arr) {
      const sector = typeof it.sector === "string" ? it.sector.trim() : "";
      const kws = Array.isArray(it.keywords)
        ? it.keywords.map((k) => String(k).trim()).filter(Boolean)
        : [];
      if (sector && kws.length) sectors.push({ sector, keywords: kws.slice(0, 2) });
    }
    if (sectors.length) {
      console.log(`Gemini 判定熱門族群 ${sectors.length} 個：${sectors.map((s) => s.sector).join("、")}`);
      return sectors.slice(0, 8);
    }
    console.warn("Gemini 族群回應無可解析內容，改用後備清單。");
  } catch (e) {
    console.warn(`Gemini 族群判定失敗：${e.message}；改用後備清單。`);
  }
  return FALLBACK_SECTORS;
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

// ───────────────────────── 4) Gemini 抽出個股 + 原因 ─────────────────────────

async function extractStocks(news, apiKey) {
  if (!apiKey || news.length === 0) return new Map();
  const lines = news
    .map((n, i) => `${i + 1}. [${n.sector}] ${n.title}（來源：${n.source || "—"}）`)
    .join("\n");
  const prompt = `以下是台股新聞標題（編號. [所屬族群] 標題）：
${lines}

請逐則判斷：這則新聞提到、且「直接相關」的台股上市櫃個股有哪些？逐檔給代碼（4 位數字）、名稱、以及「為何被提及／利多或利空題材」一句話（25 字內、繁體中文、務實具體）。
若某則新聞沒有明確點到個股，stocks 給空陣列。代碼務必正確（台股 4 位數字）。
只輸出 JSON 陣列，每元素對應一則新聞：[{"i":1,"stocks":[{"symbol":"3017","name":"奇鋐","reason":"AI散熱訂單擴張"}]}]，不要任何其他文字或 markdown。`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const byIndex = new Map();
  try {
    const data = await callGemini(apiKey, body);
    for (const it of parseJsonObjects(candidateText(data))) {
      const i = Number(it.i);
      if (!Number.isInteger(i)) continue;
      const stocks = (Array.isArray(it.stocks) ? it.stocks : [])
        .map((s) => ({
          symbol: String(s.symbol ?? "").trim(),
          name: String(s.name ?? "").trim(),
          reason: String(s.reason ?? "").trim(),
        }))
        .filter((s) => isCommonStock(s.symbol));
      byIndex.set(i, stocks);
    }
  } catch (e) {
    console.warn(`Gemini 個股抽取失敗：${e.message}（新聞仍會列出，個股留空）`);
  }
  return byIndex;
}

// ───────────────────────── merge 與輸出 ─────────────────────────

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function summariseSectors(news) {
  const map = new Map();
  for (const n of news) {
    const s = map.get(n.sector) ?? { sector: n.sector, newsCount: 0, limitUpCount: 0 };
    s.newsCount += 1;
    s.limitUpCount += (n.stocks ?? []).filter((x) => x.limitUp3d).length;
    map.set(n.sector, s);
  }
  return [...map.values()].sort((a, b) => b.limitUpCount - a.limitUpCount || b.newsCount - a.newsCount);
}

async function main() {
  const apiKey = await readKey("GEMINI_API_KEY");
  const today = taipeiDate();
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  // 1) 熱門族群
  const sectors = await detectHotSectors(apiKey);

  // 2~3) 抓新聞（每族群每關鍵字），標題過濾、解析真實 URL、去重（以 Google 文章 id 為穩定鍵）
  const seen = new Set();
  const collected = [];
  let kwBudget = MAX_KEYWORDS;
  outer: for (const { sector, keywords } of sectors) {
    for (const kw of keywords) {
      if (kwBudget-- <= 0) break outer;
      const items = await fetchNewsForKeyword(kw);
      for (const it of items) {
        if (collected.length >= MAX_NEWS_TOTAL) break outer;
        const gid = googleArticleId(it.link);
        if (seen.has(gid)) continue;
        seen.add(gid);
        const url = await resolveUrl(it.link);
        collected.push({
          gid,
          title: it.title,
          url,
          source: it.source,
          pubDate: it.pubDate,
          sector,
          keyword: kw,
        });
      }
      await sleep(300); // 對 Google 客氣一點
    }
  }
  console.log(`本班抓到 ${collected.length} 則新聞（去重後）。`);

  // 4) Gemini 抽出個股 + 原因
  const stocksByIndex = await extractStocks(collected, apiKey);
  collected.forEach((n, i) => {
    n.stocks = stocksByIndex.get(i + 1) ?? [];
  });

  // 5) 近 3 日漲停標記
  let tradingDays = [];
  try {
    const { tradingDays: td, limitUps } = await getRecentLimitUps({ days: 3 });
    tradingDays = td;
    console.log(`近 3 交易日 ${td.join("、") || "（無）"}，共 ${limitUps.size} 檔曾漲停。`);
    for (const n of collected) {
      for (const s of n.stocks) {
        const hit = limitUps.get(s.symbol);
        if (hit) {
          s.limitUp3d = true;
          s.limitUpDates = hit.dates;
        }
      }
    }
  } catch (e) {
    console.warn(`近 3 日漲停資料抓取失敗：${e.message}（略過漲停標記）`);
  }

  // 6) merge 進當日 news.json（跨日封存舊檔）
  const existing = await readExisting();
  let priorNews = [];
  if (existing && typeof existing.asOf === "string" && existing.asOf.slice(0, 10) === today) {
    priorNews = Array.isArray(existing.news) ? existing.news : [];
  } else if (existing?.asOf) {
    // 跨日：把舊的整天結果封存。
    const oldDate = existing.asOf.slice(0, 10);
    try {
      await fs.writeFile(path.join(HISTORY_DIR, `${oldDate}.json`), JSON.stringify(existing, null, 2), "utf8");
      console.log(`封存前一日 ${oldDate} 至 history/。`);
    } catch {}
  }

  const keyOf = (n) => n.gid || n.url;
  const byKey = new Map();
  for (const n of priorNews) byKey.set(keyOf(n), n);
  for (const n of collected) byKey.set(keyOf(n), n); // 新資料覆蓋（含最新漲停標記）
  const mergedNews = [...byKey.values()];

  // 若本班完全沒抓到、且已有當日資料 → 保留既有，不覆蓋成空。
  if (collected.length === 0 && priorNews.length > 0) {
    console.log("本班無新增新聞，保留既有當日資料。");
    return;
  }

  const out = {
    asOf: taipeiISO(),
    generatedAt: new Date().toISOString(),
    tradingDaysChecked: tradingDays,
    aiSource: apiKey ? "gemini" : "none",
    sectors: summariseSectors(mergedNews),
    news: mergedNews.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0)),
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`已寫入 ${path.relative(ROOT, OUT_FILE)}：${out.news.length} 則新聞、${out.sectors.length} 個族群。`);
}

main().catch((e) => {
  console.error("gen-news 失敗：", e);
  process.exit(1);
});
