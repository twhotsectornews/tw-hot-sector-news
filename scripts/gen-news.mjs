// 熱門族群焦點 —— 每班（台北 11/12/13/14 點）執行一次。力求簡單，只做一件事：
//  1) 抓「標題含『熱門族群』」的彙整型新聞（富聯網《熱門族群》等專欄）。
//  2) 讀該篇內文，用 Gemini 逐則抽出「提到的個股 + 重點（為何被點名）」。
//  3) 用證交所 MIS 即時，替被提到的個股標記「今日漲停」。
//  4) 輸出 docs/news.json：news[] = { title, url, source, pubDate, stocks:[{symbol,name,point,limitUp,pct}] }。
// 跨班累積、跨日封存。任一步失敗盡量保留既有、不覆蓋成空。

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ROOT, sleep, readKey, getText, callGemini, candidateText, parseJsonObjects,
  isCommonStock, getTodayLimitUps, getStockUniverse, classifyMentioned,
} from "./lib/core.mjs";

const DOCS_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(DOCS_DIR, "news.json");
const HISTORY_DIR = path.join(DOCS_DIR, "history");

const KEYWORD = "熱門族群";   // 標題必須含這四個字（使用者明確要求）
const MAX_NEWS = 40;          // 一天內最多保留幾則
const BODY_CHARS = 1600;      // 餵給 Gemini 的內文擷取長度

// ───────────────────────── 台北時間 ─────────────────────────
const taipeiNow = () => new Date(Date.now() + 8 * 3600_000);
const taipeiISO = (d = taipeiNow()) => d.toISOString().replace("Z", "+08:00");
const taipeiDate = (d = taipeiNow()) => d.toISOString().slice(0, 10);

// ───────────────────────── Google News RSS ─────────────────────────

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
    const title = pick("title"), link = pick("link"), pubDate = pick("pubDate"), source = pick("source");
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

function googleArticleId(link) {
  try {
    if (/news\.google\.com/.test(link)) return new URL(link).pathname.split("/").pop();
  } catch {}
  return link;
}

const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const redirectCache = new Map();

/** 把 Google News 文章連結解回真實文章 URL（簽章 + batchexecute）；失敗退回原連結。 */
async function resolveUrl(link) {
  if (!/news\.google\.com/.test(link)) return link;
  if (redirectCache.has(link)) return redirectCache.get(link);
  let resolved = link;
  try {
    const id = new URL(link).pathname.split("/").pop();
    const page = await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { "User-Agent": UA_BROWSER }, signal: AbortSignal.timeout(15_000) });
    const html = await page.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/), ts = html.match(/data-n-a-ts="([^"]+)"/);
    if (sg && ts) {
      const req = ["Fbv4je", `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts[1]},"${sg[1]}"]`];
      const res2 = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": UA_BROWSER },
        body: "f.req=" + encodeURIComponent(JSON.stringify([[req]])), signal: AbortSignal.timeout(15_000),
      });
      const text = await res2.text();
      const decoded = JSON.parse(JSON.parse(text.split("\n\n")[1])[0][2]);
      if (decoded?.[1] && /^https?:\/\//.test(decoded[1])) resolved = decoded[1];
    }
  } catch (e) {
    console.warn(`  轉址解析失敗（退回原連結）：${e.message}`);
  }
  redirectCache.set(link, resolved);
  return resolved;
}

/** 抓文章內文純文字（給 Gemini 找個股用）；失敗回空字串。 */
async function fetchArticleText(url) {
  let html;
  try {
    html = await getText(url, { timeoutMs: 15_000, retries: 2 });
  } catch {
    return "";
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BODY_CHARS);
}

/** 去掉 Google News 標題尾巴「 - 來源」與符號，做為跨來源去重鍵。 */
function titleKey(title) {
  return String(title).replace(/\s*[-–—]\s*[^-–—]+$/, "").replace(/[《》「」【】\s]/g, "").trim();
}

// ───────────────────────── Gemini：抽個股 + 重點 ─────────────────────────

async function extractStocks(news, apiKey) {
  if (!apiKey || news.length === 0) return new Map();
  const blocks = news
    .map((n, i) => `【${i + 1}】標題：${n.title}\n內文：${n.body || "（無）"}`)
    .join("\n\n");
  const prompt = `以下是台股「熱門族群」彙整新聞，每則有標題與內文摘錄：

${blocks}

請逐則列出文中「明確點名」的台股個股（代碼 4 碼 + 名稱），以及該檔「被點名的重點」一句話（15 字內、繁體中文、務實具體，例如「亮燈漲停、被動元件漲價」）。同一則的個股請盡量列全（標題與內文都要看）。查無明確個股就給空陣列。
只輸出 JSON 陣列，每元素對應一則：[{"i":1,"stocks":[{"symbol":"2327","name":"國巨","point":"領被動元件漲停"}]}]，不要任何其他文字或 markdown。`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  };
  const byIndex = new Map();
  try {
    const data = await callGemini(apiKey, body);
    for (const it of parseJsonObjects(candidateText(data))) {
      const i = Number(it.i);
      if (!Number.isInteger(i)) continue;
      const stocks = (Array.isArray(it.stocks) ? it.stocks : [])
        .map((s) => ({ symbol: String(s.symbol ?? "").trim(), name: String(s.name ?? "").trim(), point: String(s.point ?? "").trim() }))
        .filter((s) => isCommonStock(s.symbol));
      byIndex.set(i, stocks);
    }
  } catch (e) {
    console.warn(`Gemini 個股抽取失敗：${e.message}`);
  }
  return byIndex;
}

// ───────────────────────── 主流程 ─────────────────────────

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const apiKey = await readKey("GEMINI_API_KEY");
  const today = taipeiDate();
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  // 1) 抓「標題含 熱門族群」的新聞
  const q = encodeURIComponent(`${KEYWORD} when:2d`);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  let raw = [];
  try {
    raw = parseRssItems(await getText(rssUrl)).filter((it) => it.title.includes(KEYWORD));
  } catch (e) {
    console.warn(`RSS 抓取失敗：${e.message}`);
  }
  console.log(`標題含「${KEYWORD}」的新聞：${raw.length} 則。`);

  // 解析真實 URL、抓內文、以「文章 id + 標題」去重
  const seenGid = new Set(), seenTitle = new Set();
  const fresh = [];
  for (const it of raw) {
    const gid = googleArticleId(it.link);
    const tkey = titleKey(it.title);
    if (seenGid.has(gid) || seenTitle.has(tkey)) continue;
    seenGid.add(gid); seenTitle.add(tkey);
    const url = await resolveUrl(it.link);
    const bodyText = await fetchArticleText(url);
    fresh.push({ gid, tkey, title: it.title, url, source: it.source, pubDate: it.pubDate, body: bodyText });
  }

  // 2) 合併既有（同日累積；跨日封存）
  const existing = await readExisting();
  let prior = [];
  if (existing && existing.asOf?.slice(0, 10) === today) {
    prior = Array.isArray(existing.news) ? existing.news : [];
  } else if (existing?.asOf) {
    const oldDate = existing.asOf.slice(0, 10);
    try {
      await fs.writeFile(path.join(HISTORY_DIR, `${oldDate}.json`), JSON.stringify(existing, null, 2), "utf8");
      console.log(`封存前一日 ${oldDate}。`);
    } catch {}
  }

  if (fresh.length === 0 && prior.length > 0) {
    console.log("本班無新增新聞，保留既有當日內容。");
    return;
  }

  // 以 gid / 標題去重合併（新資料在前）
  const byKey = new Map();
  for (const n of prior) byKey.set(n.gid || titleKey(n.title), n);
  for (const n of fresh) byKey.set(n.gid || n.tkey, n);
  let news = [...byKey.values()];
  // 二次以「標題」去重（跨來源同篇）
  const tseen = new Set();
  news = news.filter((n) => {
    const k = n.tkey || titleKey(n.title);
    if (tseen.has(k)) return false;
    tseen.add(k);
    return true;
  });

  // 3) 抽個股 + 重點（只對還沒抽過的新聞打 Gemini，省成本）
  const need = news.filter((n) => !Array.isArray(n.stocks));
  if (need.length) {
    const map = await extractStocks(need, apiKey);
    need.forEach((n, i) => { n.stocks = map.get(i + 1) ?? []; });
  }
  for (const n of news) if (!Array.isArray(n.stocks)) n.stocks = [];

  // 3.5) 月K創新高型態過濾：只留「創新高／逼近新高／高檔修正」的個股（硬過濾），整則空了就丟。
  //      只判定「還沒有 status」的個股（既有的沿用上一班結果，省 Yahoo 請求）。
  const toClassify = [...new Set(news.flatMap((n) => n.stocks.filter((s) => !s.status).map((s) => s.symbol)))];
  let filterOk = true;
  if (toClassify.length) {
    try {
      const universe = await getStockUniverse();
      const pat = await classifyMentioned(toClassify, universe);
      for (const n of news) for (const s of n.stocks) {
        if (!s.status && pat.has(s.symbol)) {
          const p = pat.get(s.symbol);
          s.status = p.status;
          s.dist = Math.round(p.dist * 1000) / 10; // 距高點 %（一位小數）
        }
      }
      console.log(`月K型態判定 ${toClassify.length} 檔，符合 ${pat.size} 檔。`);
      // 疑似資料源異常（要判定的不少卻全部落空）→ 本班不硬過濾，避免站台被清空。
      if (pat.size === 0 && toClassify.length >= 8) filterOk = false;
    } catch (e) {
      console.warn(`月K型態判定失敗：${e.message}`);
      filterOk = false;
    }
  }
  if (filterOk) {
    for (const n of news) n.stocks = n.stocks.filter((s) => s.status);
    news = news.filter((n) => n.stocks.length > 0);
  } else {
    console.warn("月K型態資料疑似異常，本班跳過硬過濾（保留內容、下一班重試）。");
  }

  // 4) 今日漲停標記（盤中 MIS 即時、盤後 dated；取全市場漲停集合再標在被提到的個股上）
  const mentioned = new Set(news.flatMap((n) => n.stocks.map((s) => s.symbol)));
  if (mentioned.size) {
    try {
      const { date, intraday, limitUps } = await getTodayLimitUps();
      const pctBy = new Map(limitUps.map((u) => [u.symbol, u.pct]));
      let hitCount = 0;
      for (const n of news) for (const s of n.stocks) {
        if (pctBy.has(s.symbol)) { s.limitUp = true; s.pct = Math.round(pctBy.get(s.symbol) * 10) / 10; hitCount++; }
      }
      console.log(`市場日 ${date}（${intraday ? "盤中即時" : "盤後"}）漲停 ${limitUps.length} 檔；被提到的個股命中漲停 ${hitCount} 檔。`);
    } catch (e) {
      console.warn(`漲停標記失敗：${e.message}`);
    }
  }

  // 5) 排序（新到舊）、上限、輸出（body 不寫進檔案，省空間）
  news.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  news = news.slice(0, MAX_NEWS).map(({ body, ...n }) => n);

  const out = {
    asOf: taipeiISO(),
    generatedAt: new Date().toISOString(),
    keyword: KEYWORD,
    filter: "月K創新高型態（含逼近新高、高檔修正）",
    aiSource: apiKey ? "gemini" : "none",
    news,
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`已寫入 ${path.relative(ROOT, OUT_FILE)}：${news.length} 則熱門族群新聞。`);
}

main().catch((e) => {
  console.error("gen-news 失敗：", e);
  process.exit(1);
});
