# 台股熱門族群新聞（TwHotSectorNews）

每天盤中（台北 **11:00–14:00 每小時**）自動上網彙整「**強勢／熱門族群**」的新聞，做成新聞列表（含真實文章連結），並逐則列出：

- 該新聞**提到的個股**（代碼＋名稱）
- 被提及的**原因／題材**（一句話）
- 若該個股**近 3 個交易日曾漲停**，加上 🔴 漲停 註記

目的：快速掌握「今天哪些族群很強、強在哪」，挑股更快。

純靜態網頁（GitHub Pages），資料由 GitHub Actions 排程腳本產生並 commit 回 repo。

---

## 架構

```
前端（docs/，純 HTML/JS，無建置）
  index.html / app.js / styles.css  ── fetch("news.json") 後依族群分組渲染

資料管線（scripts/，Node，無 npm 依賴）
  gen-news.mjs   每班執行：
    0. 族群焦點：抓標題含「熱門族群/盤面焦點/強勢族群」的彙整型專欄，置頂分組
    1. 用「固定族群清單」CANONICAL_SECTORS（程式內維護）逐族群搜 Google News
    2. 只留「標題含族群關鍵字」者，解析轉址 → 真實文章 URL，去重
    3. Gemini 逐則抽出提到的個股 + 原因
    4. TWSE/TPEx OpenAPI 取近 3 交易日全市場 → 標記「近 3 日漲停」(漲跌幅 ≥ 9.5%)
    5. 依固定清單歸位、依「漲停家數」排強勢度；merge 進當日 docs/news.json（跨日封存 history/）
  lib/core.mjs   getJson / getText / callGemini / 指定日全市場抓取（移植自 TwStockRank）
```

設計取捨：
- **族群分組用固定清單**（`CANONICAL_SECTORS`，在 `scripts/gen-news.mjs`）：分組永遠穩定一致、不會像 AI 動態命名那樣漂移；**強勢度用「近 3 日漲停家數」客觀排序**。要新增/調整族群只改這份清單的 `keywords`。
- **新聞與 URL 一律來自 Google News RSS**（真實標題＋連結），**Gemini 只做語意判讀**（抽個股與原因），避免 AI 幻覺網址。漲停判定走交易所 OpenAPI，零金鑰。

---

## 本機開發

```bash
# 1) 產生資料（需 Node 20+）。GEMINI_API_KEY 可選；不帶仍會抓新聞分族群，只是個股/原因留空。
GEMINI_API_KEY=xxxx node scripts/gen-news.mjs
#   或把金鑰放 .env.local：  GEMINI_API_KEY=xxxx

# 2) 本機開靜態站看畫面
python -m http.server 8080 --directory docs
#   開 http://localhost:8080
```

`GEMINI_API_KEY` 免費取得：<https://aistudio.google.com/app/apikey>（免費額度足夠每天 4 班）。

「近 3 日漲停」說明：盤中當日收盤資料尚未發布，故一律比對**已完成的 3 個交易日**。門檻用單日漲跌幅 ≥ **9.5%**（台股 ±10%，因 tick 取整實際常落在 9.3–10%）為啟發式判定，可能與真實漲停狀態略有出入。

---

## 部署（GitHub Pages）

1. 建 GitHub repo，把本資料夾推上去。
2. **Settings → Pages**：Source 選 **GitHub Actions**（workflow 已用 `upload-pages-artifact` 上傳 `docs/`）。
3. **Settings → Secrets and variables → Actions** 新增 secret `GEMINI_API_KEY`。
4. **Settings → Actions → General → Workflow permissions** 設為 **Read and write**（讓 Actions 能 commit `news.json`）。

> 想改用 Cloudflare Pages 也可：把專案連到 Cloudflare Pages、輸出目錄設 `docs`、不設建置指令即可（資料仍靠 GitHub Actions 產生並 commit）。

---

## 排程（cron-job.org，主要觸發）

GitHub 內建 cron（workflow 內 `schedule:`）為 best-effort 後備、偶爾漏跑。穩定的主要觸發用 **cron-job.org**：

**UI 設定**
- 建立一個 Job，URL：
  `https://api.github.com/repos/<OWNER>/<REPO>/actions/workflows/update.yml/dispatches`
- Method：**POST**，Request body：`{"ref":"main"}`
- Headers：
  - `Authorization: Bearer <GitHub PAT，repo 權限>`
  - `Accept: application/vnd.github+json`
  - `Content-Type: application/json`
- 排程：**週一～週五**，**11:00 / 12:00 / 13:00 / 14:00**（時區設台北）。

PAT 在 <https://github.com/settings/tokens>（classic：勾 `repo`；或 fine-grained：對此 repo 給 Actions: Read and write）。

> 觸發成功會回 HTTP 204（無內容）。若回 404，多半是 PAT 權限不足或 workflow 檔名/分支不符。

---

## 免責

新聞由第三方媒體提供；個股與原因為 AI 自動判讀，**僅供參考，非投資建議**。
