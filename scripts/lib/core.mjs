// 共用工具（熱門族群新聞站）。部分函式移植自 TwStockRank 的 scripts/lib/core.mjs：
//  - getJson：對 429/5xx 與網路錯誤退避重試（含 Connection: close + AbortController 逾時）
//  - callGemini：Gemini generateContent REST 端點 + 429 退避
//  - TWSE/TPEx OpenAPI「指定日」全市場抓取 → 供「近 3 日漲停」判定
// 本站為獨立 repo，故為「複製」而非 import。

import { promises as fs } from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmtDate = (d) => d.toISOString().slice(0, 10);

// ───────────────────────── 解析輔助 ─────────────────────────

/** 數字字串："1,234,567" / "14.63" / "+1.79" / "--" → number 或 NaN。 */
export function toNum(s) {
  if (s == null) return NaN;
  const v = String(s).replace(/,/g, "").replace(/\s/g, "").trim();
  if (v === "" || v === "--" || v === "---" || v === "—") return NaN;
  return Number(v);
}

/** 只保留 4 位純數字代號（個股）；排除 ETF（00xxx）、權證（6 位）、特別股（含字母）。 */
export function isCommonStock(code) {
  return /^[1-9]\d{3}$/.test(String(code ?? "").trim());
}

/** 民國日期 "1150612" → "2026-06-12"。 */
export function rocToISO(roc) {
  const s = String(roc ?? "").trim();
  const m = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m) return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  const m2 = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (m2) {
    const y = Number(m2[1]) + 1911;
    return `${y}-${String(m2[2]).padStart(2, "0")}-${String(m2[3]).padStart(2, "0")}`;
  }
  return s;
}

/** 從（可能被截斷/含 markdown 的）文字抽出 JSON 物件陣列，容錯解析。 */
export function parseJsonObjects(text) {
  const clean = String(text ?? "").replace(/```json|```/g, "");
  const s = clean.indexOf("[");
  const e = clean.lastIndexOf("]");
  if (s >= 0 && e > s) {
    try {
      const arr = JSON.parse(clean.slice(s, e + 1));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  const out = [];
  for (const m of clean.match(/\{[^{}]*\}/g) ?? []) {
    try {
      out.push(JSON.parse(m));
    } catch {}
  }
  return out;
}

// ───────────────────────── HTTP ─────────────────────────

const UA = "tw-hot-sector-news/1.0 (+github actions)";

/** 取 JSON，對 429/5xx 與網路錯誤退避重試（body 解析在 try 內 await，重試才有效）。 */
export async function getJson(url, { timeoutMs = 25_000, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", Connection: "close" },
        signal: ac.signal,
      });
      if (res.ok) return await res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < retries - 1) {
        await sleep(3_000 * (attempt + 1));
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (attempt < retries - 1) {
        await sleep(3_000 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 取純文字（給 RSS / HTML 用），同樣對 5xx 與網路錯誤退避重試。 */
export async function getText(url, { timeoutMs = 20_000, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*", Connection: "close" },
        signal: ac.signal,
      });
      if (res.ok) return await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries - 1) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (attempt < retries - 1) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 從環境變數或 .env.local 讀取金鑰。 */
export async function readKey(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const raw = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
    const m = raw.match(new RegExp(`^${name}\\s*=\\s*(.+)\\s*$`, "m"));
    if (m) return m[1].trim();
  } catch {}
  return null;
}

// ───────────────────────── 行情抓取（指定日，OpenAPI / dated） ─────────────────────────

function keepRow(x) {
  return isCommonStock(x.symbol) && x.price > 0;
}

/** 指定日上市全市場（MI_INDEX dated）。回傳 { symbol, name, price, changeDelta }。 */
export async function fetchTwseByDate(ds) {
  const ymd = ds.replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`;
  let data;
  try {
    data = await getJson(url);
  } catch {
    return [];
  }
  if (!data || data.stat !== "OK" || !Array.isArray(data.tables)) return [];
  const table = data.tables.find(
    (t) => Array.isArray(t.fields) && t.fields.includes("成交金額") && t.fields.includes("證券代號"),
  );
  if (!table) return [];
  const f = table.fields;
  const idx = (name) => f.indexOf(name);
  const iCode = idx("證券代號"), iName = idx("證券名稱"), iClose = idx("收盤價"),
    iDir = idx("漲跌(+/-)"), iDiff = idx("漲跌價差");
  const rows = [];
  for (const row of table.data ?? []) {
    const code = String(row[iCode] ?? "").trim();
    if (!isCommonStock(code)) continue;
    const dir = String(row[iDir] ?? "").replace(/<[^>]*>/g, "").trim(); // + / - / X
    const diff = toNum(row[iDiff]);
    const changeDelta = Number.isFinite(diff) ? (dir.includes("-") ? -diff : diff) : NaN;
    const x = {
      market: "twse",
      symbol: code,
      name: String(row[iName] ?? "").trim(),
      price: toNum(row[iClose]),
      changeDelta,
    };
    if (keepRow(x)) rows.push(x);
  }
  return rows;
}

/** 指定日上櫃全市場（best-effort：TPEx 舊端點較不穩，失敗回 []）。 */
export async function fetchTpexByDate(ds) {
  const [y, m, d] = ds.split("-");
  const roc = `${Number(y) - 1911}/${m}/${d}`;
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${roc}&se=EW`;
  let data;
  try {
    data = await getJson(url);
  } catch {
    return [];
  }
  const arr = data?.aaData ?? data?.tables?.[0]?.data ?? [];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const rows = [];
  for (const row of arr) {
    // 舊版欄位：代號, 名稱, 收盤, 漲跌, 開盤, ...
    const code = String(row[0] ?? "").trim();
    if (!isCommonStock(code)) continue;
    const x = {
      market: "tpex",
      symbol: code,
      name: String(row[1] ?? "").trim(),
      price: toNum(row[2]),
      changeDelta: toNum(row[3]),
    };
    if (keepRow(x)) rows.push(x);
  }
  return rows;
}

/** 指定日上市＋上櫃。真正交易日一定有上市資料；上市為空（假日/來源失敗）→ 整日略過。 */
export async function fetchAllByDate(ds) {
  const twse = await fetchTwseByDate(ds);
  if (twse.length === 0) return [];
  const tpex = await fetchTpexByDate(ds);
  return [...twse, ...tpex];
}

/** 由 changeDelta 還原當日漲跌幅 %。 */
export function changePctOf(r) {
  const prevClose = r.price - (Number.isFinite(r.changeDelta) ? r.changeDelta : 0);
  if (Number.isFinite(r.changeDelta) && prevClose > 0) return (r.changeDelta / prevClose) * 100;
  return 0;
}

/**
 * 取「最近 N 個完成交易日」的全市場資料，建立漲停對照表。
 * 從 startFrom（預設昨天）往回找：跳過假日（fetchAllByDate 回 [] 即略過），
 * 收集到 N 個有資料的交易日為止（最多回看 maxLookback 個日曆日，涵蓋連假）。
 *
 * @returns { tradingDays: string[], limitUps: Map<symbol, { name, dates: string[], maxPct }> }
 */
export async function getRecentLimitUps({ days = 3, threshold = 9.5, startFrom = null, maxLookback = 12 } = {}) {
  const start = startFrom ? new Date(startFrom + "T00:00:00Z") : new Date(Date.now() - 86_400_000);
  const tradingDays = [];
  const limitUps = new Map();

  for (let i = 0; i < maxLookback && tradingDays.length < days; i++) {
    const d = new Date(start.getTime() - i * 86_400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 週末快速略過
    const ds = fmtDate(d);
    let rows;
    try {
      rows = await fetchAllByDate(ds);
    } catch (e) {
      console.warn(`  ${ds} 全市場抓取失敗：${e.message}`);
      continue;
    }
    if (rows.length === 0) continue; // 非交易日
    tradingDays.push(ds);
    for (const r of rows) {
      const pct = changePctOf(r);
      if (pct >= threshold) {
        const prev = limitUps.get(r.symbol);
        if (prev) {
          prev.dates.push(ds);
          prev.maxPct = Math.max(prev.maxPct, pct);
        } else {
          limitUps.set(r.symbol, { name: r.name, dates: [ds], maxPct: pct });
        }
      }
    }
  }
  return { tradingDays, limitUps };
}

// ───────────────────────── Gemini ─────────────────────────

export const GEMINI_MODEL = "gemini-2.5-flash";

/** 呼叫 Gemini generateContent，對 429/500/503 退避重試。 */
export async function callGemini(apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if ([429, 500, 503].includes(res.status) && attempt < 4) {
      const wait = 5_000 * (attempt + 1);
      console.warn(`  Gemini HTTP ${res.status}，${wait / 1000}s 後重試（第 ${attempt + 1} 次）…`);
      await sleep(wait);
      continue;
    }
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
}

/** 串接候選回應的所有 text part。 */
export function candidateText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || "").join("").trim();
}
