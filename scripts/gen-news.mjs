// 熱門族群焦點 —— 每班（台北 11/12/13/14 點）執行一次。力求簡單，只做一件事：
//  1) 抓「標題含『熱門族群』」的彙整型新聞（富聯網《熱門族群》等專欄）。
//  2) 讀該篇內文，用 Gemini 逐則抽出「提到的個股 + 重點」＋族群題材背景。
//  3) 標記「今日漲停」（只動今日新聞）與「近 5 個交易日漲停」（所有個股）。
//  4) 輸出 docs/news.json：只保留「今天＋前一個發布日」兩組，其餘按 pubDate 分日封存到 docs/history/。
// 跨班累積、已完成的新聞不重抽也不重打轉址。任一步失敗盡量保留既有、不退化。

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ROOT, sleep, readKey, getText, callGemini, candidateText, parseJsonObjects,
  isCommonStock, getTodayLimitUps, getRecentLimitUps, getStockUniverse, classifyMentioned,
  GEMINI_MODEL, GEMINI_FALLBACK_MODEL,
} from "./lib/core.mjs";

const DOCS_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(DOCS_DIR, "news.json");
const HISTORY_DIR = path.join(DOCS_DIR, "history");

const KEYWORD = "熱門族群";   // 標題必須含這四個字（使用者明確要求）
const MAX_NEWS = 40;          // 頁面（兩日組）最多保留幾則
const BODY_CHARS = 3000;      // 餵給 Gemini 的內文擷取長度（彙整型專欄常列 10+ 檔，太短會漏抽後半的個股）
const KEEP_DAY_GROUPS = 2;    // 頁面保留幾個「日組」（今天＋前一個發布日）
const KEEP_MAX_AGE_DAYS = 4;  // 日組最舊只回看幾天（涵蓋週一顯示上週五）

// ───────────────────────── 台北時間 ─────────────────────────
const taipeiNow = () => new Date(Date.now() + 8 * 3600_000);
const taipeiISO = (d = taipeiNow()) => d.toISOString().replace("Z", "+08:00");
const taipeiDate = (d = taipeiNow()) => d.toISOString().slice(0, 10);
/** 任意毫秒時戳 → 台北日 YYYY-MM-DD。 */
const taipeiDayOf = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

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

// ───────────────────────── Gemini：抽個股 + 重點 + 題材背景 ─────────────────────────

// 題材標籤固定字彙（前端好上色；Gemini 只能從這裡挑）
const THEME_TAGS = ["需求驅動", "國際大廠", "政策關稅", "循環位置"];
// 免費版 gemini-2.5-flash 每日只有 20 次請求（GenerateRequestsPerDayPerProjectPerModel），所以要「省請求次數」而非分很多小批。
// 一批塞多一點（≈一次一班的量），配大 maxOutputTokens 避免截斷；4 班/日 × ≤2 批 = ≤8 次/日，留餘裕。
const GEMINI_CHUNK = 20;

/** 對一小批新聞打一次 Gemini，回傳陣列，第 k 元素對應 chunk[k]（照輸入順序、最多 chunk.length 個）。 */
async function extractChunk(chunk, apiKey) {
  const blocks = chunk
    .map((n, i) => `【${i + 1}】標題：${n.title}\n內文：${n.body || "（無）"}`)
    .join("\n\n");
  const prompt = `以下是台股「熱門族群」彙整新聞，每則有標題與內文摘錄：

${blocks}

請逐則輸出三項：
1. stocks：文中「明確點名」的台股個股（代碼 4 碼 + 名稱），以及該檔「被點名的重點」一句話（15 字內、繁體中文、務實具體，例如「亮燈漲停、被動元件漲價」）。同一則盡量列全（標題與內文都要看），查無明確個股就給空陣列。
2. background：這個族群「背後的故事」1～2 句（繁體中文，共 60 字內、務實）。可用產業常識補充文章沒寫、但業界公認的重點：帶動需求的國際題材（如 AI 伺服器、HPC、車用復甦）、該族群的國際指標大廠（如 MLCC 的村田、記憶體的三星／SK 海力士／美光）、相關政府政策或關稅地緣、以及產業目前的循環位置（谷底翻揚／景氣復甦／供給吃緊）。務實客觀，不要杜撰具體數字或財測，講不確定的就別寫。
3. themeTags：從固定清單挑 0～3 個最貼切的：${JSON.stringify(THEME_TAGS)}（只能用清單內的字，其他不要）。

只輸出 JSON 陣列，每元素對應一則，例如：
[{"i":1,"stocks":[{"symbol":"2327","name":"國巨","point":"領被動元件漲停"}],"background":"被動元件受 AI 伺服器與車用需求帶動漲價，國際 MLCC 龍頭村田缺貨外溢，國巨為台系指標，產業自谷底回升。","themeTags":["需求驅動","國際大廠","循環位置"]}]
不要任何其他文字或 markdown。`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 0 } },
  };
  // 主模型（flash）配額用盡就換備援（flash-lite，配額獨立）；兩個都失敗才丟出（本批下一班重試）。
  let data;
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL];
  for (let m = 0; m < models.length; m++) {
    try {
      data = await callGemini(apiKey, body, models[m]);
      if (m > 0) console.log(`  （改用備援模型 ${models[m]} 成功）`);
      break;
    } catch (e) {
      if (m === models.length - 1) throw e;
      console.warn(`  主模型 ${models[m]} 失敗（${e.message.slice(0, 70)}）→ 改試備援 ${models[m + 1]}`);
    }
  }
  // 回應不完整（被 maxOutputTokens 截斷等）→ 視為本批失敗：截斷的巢狀 JSON 會被容錯解析
  // 抽成內層碎片、看似成功實為空白，寧可拋錯讓下一班重試。
  const finish = data?.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") throw new Error(`回應不完整（finishReason=${finish}）`);
  const parsed = parseJsonObjects(candidateText(data));
  // 嚴格依「陣列順序」對位（responseMimeType:json 照輸入順序回；Gemini 常漏 i 欄位、偶爾多吐幾筆），
  // 只取前 chunk.length 筆、按位置對應，避免多吐的物件把索引擠歪或溢位到別批。
  return parsed.slice(0, chunk.length).map((it) => {
    if (!it || typeof it !== "object") return null;
    const seen = new Set();
    const stocks = (Array.isArray(it.stocks) ? it.stocks : [])
      .map((s) => ({ symbol: String(s.symbol ?? "").trim(), name: String(s.name ?? "").trim(), point: String(s.point ?? "").trim() }))
      .filter((s) => isCommonStock(s.symbol) && !seen.has(s.symbol) && seen.add(s.symbol));
    const background = String(it.background ?? "").trim();
    const themeTags = (Array.isArray(it.themeTags) ? it.themeTags : [])
      .map((t) => String(t ?? "").trim())
      .filter((t) => THEME_TAGS.includes(t));
    return { stocks, background, themeTags: [...new Set(themeTags)] };
  });
}

/** 分批抽取，回傳 Map<news 1-based index, {stocks,background,themeTags}>。分批是為了避免單次回應被截斷。 */
async function extractStocks(news, apiKey) {
  const byIndex = new Map();
  if (!apiKey || news.length === 0) return byIndex;
  for (let base = 0; base < news.length; base += GEMINI_CHUNK) {
    const chunk = news.slice(base, base + GEMINI_CHUNK);
    try {
      const results = await extractChunk(chunk, apiKey);
      results.forEach((v, k) => { if (v) byIndex.set(base + k + 1, v); });
      if (results.every((v) => !v)) console.warn(`  Gemini 這批（${base + 1}~${base + chunk.length}）解析不到內容，將於下一班重試。`);
    } catch (e) {
      console.warn(`  Gemini 抽取失敗（第 ${base + 1}~${base + chunk.length} 則，本批略過）：${e.message}`);
    }
    await sleep(300);
  }
  console.log(`Gemini 題材/個股抽取：${news.length} 則 → 成功 ${byIndex.size} 則。`);
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

/** 新聞屬於哪個台北日（依 pubDate；無法解析就當今天，維持可見）。 */
function newsDay(n, today) {
  const t = new Date(n.pubDate ?? 0).getTime();
  return Number.isFinite(t) && t > 0 ? taipeiDayOf(t) : today;
}

/** 新聞是否已完成抽取（有個股陣列＋有背景）。 */
const isComplete = (n) => Array.isArray(n?.stocks) && !!n?.background;

/** 把某日的新聞 upsert 進 docs/history/<day>.json（以 gid 合併，不重複、不遺失）。 */
async function upsertHistory(day, items) {
  const file = path.join(HISTORY_DIR, `${day}.json`);
  let old = null;
  try { old = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
  const byGid = new Map((old?.news ?? []).map((n) => [n.gid || titleKey(n.title), n]));
  for (const n of items) byGid.set(n.gid || titleKey(n.title), n);
  const merged = [...byGid.values()]
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .map(({ body, ...n }) => n);
  await fs.writeFile(file, JSON.stringify({ date: day, updatedAt: new Date().toISOString(), news: merged }, null, 2), "utf8");
}

async function main() {
  const apiKey = await readKey("GEMINI_API_KEY");
  const today = taipeiDate();
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  // 0) 先讀既有檔（跨日也沿用；封存改在寫檔時按 pubDate 分日處理，不再依賴 asOf 跨日時序）
  const existing = await readExisting();
  const prior = Array.isArray(existing?.news) ? existing.news : [];
  const priorByKey = new Map(prior.map((n) => [n.gid || titleKey(n.title), n]));

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

  // 1.5) 逐則處理（以「文章 id + 標題」去重）：
  //      已完成的沿用既有、不重打轉址與內文（省每班 ~3 次 HTTP/則）；只補救仍是 google 轉址的網址。
  const seenGid = new Set(), seenTitle = new Set();
  const fresh = [];   // 本班需要（重）抽取的項目
  for (const it of raw) {
    const gid = googleArticleId(it.link);
    const tkey = titleKey(it.title);
    if (seenGid.has(gid) || seenTitle.has(tkey)) continue;
    seenGid.add(gid); seenTitle.add(tkey);
    const p = priorByKey.get(gid);
    if (p && isComplete(p)) {
      if (/news\.google\.com/.test(p.url || "")) {
        const u = await resolveUrl(it.link);
        if (!/news\.google\.com/.test(u)) p.url = u;
      }
      continue;
    }
    const url = await resolveUrl(it.link);
    const bodyText = await fetchArticleText(url);
    fresh.push({ gid, tkey, title: it.title, url, source: it.source, pubDate: it.pubDate, body: bodyText });
  }

  // 2) 合併：既有全保留（含昨日組），fresh 蓋掉同 gid 的未完成版本
  const byKey = new Map();
  for (const n of prior) byKey.set(n.gid || titleKey(n.title), n);
  for (const n of fresh) byKey.set(n.gid || n.tkey, n);
  let news = [...byKey.values()];
  // 二次以「標題」去重（跨來源同篇；既有在前，故保留已完成版本）
  const tseen = new Set();
  news = news.filter((n) => {
    const k = n.tkey || titleKey(n.title);
    if (tseen.has(k)) return false;
    tseen.add(k);
    return true;
  });

  // 3) 抽個股 + 重點 + 題材背景（只對未完成的打 Gemini；本班失敗「保留原值」下一班重試，絕不清空既有）
  const need = news.filter((n) => !isComplete(n));
  if (need.length) {
    const map = await extractStocks(need, apiKey);
    need.forEach((n, i) => {
      const r = map.get(i + 1);
      if (!r) return; // 本批失敗 → 不動原值
      n.stocks = r.stocks;
      n.background = r.background;
      n.themeTags = r.themeTags;
    });
  }
  for (const n of news) {
    if (!Array.isArray(n.stocks)) n.stocks = [];
    if (typeof n.background !== "string") n.background = "";
    if (!Array.isArray(n.themeTags)) n.themeTags = [];
  }

  // 3.5) 月K型態標記（軟標記）：只判定「還沒有 status」的個股（既有沿用，省 Yahoo 請求）。
  const toClassify = [...new Set(news.flatMap((n) => n.stocks.filter((s) => !s.status).map((s) => s.symbol)))];
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
      console.log(`月K型態標記 ${toClassify.length} 檔，符合型態 ${pat.size} 檔。`);
    } catch (e) {
      console.warn(`月K型態標記失敗（本班個股無型態標，不影響顯示）：${e.message}`);
    }
  }

  // 4a) 今日漲停：只動「今日新聞」的個股，先清再標（漲停打開會撤銷）；
  //     拿到的資料若不是今天的（收盤後 MIS 失效時的回退），一律不動既有標記，避免昨日資料誤標今天。
  const todayNews = news.filter((n) => newsDay(n, today) === today);
  if (todayNews.some((n) => n.stocks.length)) {
    try {
      const { date, intraday, limitUps } = await getTodayLimitUps();
      if (date === today) {
        for (const n of todayNews) for (const s of n.stocks) { s.limitUp = false; delete s.pct; }
        const pctBy = new Map(limitUps.map((u) => [u.symbol, u.pct]));
        let hitCount = 0;
        for (const n of todayNews) for (const s of n.stocks) {
          if (pctBy.has(s.symbol)) { s.limitUp = true; s.pct = Math.round(pctBy.get(s.symbol) * 10) / 10; hitCount++; }
        }
        console.log(`市場日 ${date}（${intraday ? "盤中即時" : "盤後"}）漲停 ${limitUps.length} 檔；今日新聞個股命中 ${hitCount} 檔。`);
      } else {
        console.warn(`今日漲停資料不可得（最近資料日 ${date}），保留既有標記。`);
      }
    } catch (e) {
      console.warn(`今日漲停標記失敗：${e.message}`);
    }
  }

  // 4b) 近 5 個交易日漲停註記（不含今日；今日由 4a 標）。這是個股的滾動屬性，所有新聞的個股都標。
  if (news.some((n) => n.stocks.length)) {
    try {
      const yesterday = taipeiDayOf(Date.now() - 86_400_000);
      const { tradingDays, limitUps: lu } = await getRecentLimitUps({ days: 5, startFrom: yesterday, maxLookback: 14 });
      for (const n of news) for (const s of n.stocks) {
        delete s.lu5; delete s.lu5d;
        const rec = lu.get(s.symbol);
        if (rec) {
          s.lu5 = rec.dates.length;
          s.lu5d = rec.dates.map((d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`); // 新到舊，如 ["7/1","6/27"]
        }
      }
      console.log(`近5交易日（${tradingDays.at(-1)}～${tradingDays[0]}）漲停 ${lu.size} 檔已對照。`);
    } catch (e) {
      console.warn(`近5日漲停註記失敗（保留原標記）：${e.message}`);
    }
  }

  // 5) 分日組：頁面留「最新 KEEP_DAY_GROUPS 組」（最舊回看 KEEP_MAX_AGE_DAYS 天），非今日的組同步封存到 history/。
  news.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  const groups = new Map(); // day → items（已排序，day 由新到舊出現）
  for (const n of news) {
    const d = newsDay(n, today);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(n);
  }
  const cutoff = taipeiDayOf(Date.now() - KEEP_MAX_AGE_DAYS * 86_400_000);
  const keepDays = [...groups.keys()].filter((d) => d >= cutoff).slice(0, KEEP_DAY_GROUPS);
  for (const [d, items] of groups) {
    if (d === today) continue; // 今日組還在累積中，明天以後再進封存
    try {
      await upsertHistory(d, items);
    } catch (e) {
      console.warn(`封存 ${d} 失敗：${e.message}`);
    }
  }
  news = keepDays.flatMap((d) => groups.get(d)).slice(0, MAX_NEWS).map(({ body, ...n }) => n);

  // 6) 防退化守門：既有檔裡「已完成」且仍該保留的新聞，本班不能弄丟或變不完整（被封存出場屬正常）。
  const outByGid = new Map(news.map((n) => [n.gid, n]));
  let regressed = 0;
  for (const p of prior) {
    if (!isComplete(p)) continue;
    if (!keepDays.includes(newsDay(p, today))) continue;
    const o = outByGid.get(p.gid);
    if (!o || !isComplete(o)) regressed++;
  }
  if (regressed > 0) {
    console.warn(`偵測到 ${regressed} 則已完成新聞將退化/遺失，本班不覆蓋（保留既有檔，下一班重試）。`);
    return;
  }

  const bgCount = news.filter((n) => n.background).length;
  const out = {
    asOf: taipeiISO(),
    generatedAt: new Date().toISOString(),
    keyword: KEYWORD,
    filter: "熱門族群新聞（今天＋前一發布日）＋ 題材背景；個股標月K型態、今日漲停與近5日漲停",
    note: "族群背景由 AI（Gemini）整理，含產業常識補充，僅供參考、非投資建議。",
    aiSource: apiKey ? "gemini" : "none",
    news,
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`已寫入 ${path.relative(ROOT, OUT_FILE)}：${news.length} 則（${keepDays.join("、")}；有背景 ${bgCount} 則）。`);
}

main().catch((e) => {
  console.error("gen-news 失敗：", e);
  process.exit(1);
});
