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
    1. 取「今日全市場漲停股」：盤中用 TWSE MIS 即時行情、盤後用 dated 收盤（getTodayLimitUps）
    2. Gemini 把每檔漲停股分到族群（被動元件/AI伺服器/散熱…）+ 一句話原因；不確定者退回官方產業別
    3. 依「今日漲停家數」排出強勢族群（客觀）
    4. 為「族群焦點」＋有漲停的族群抓 Google News（解析轉址→真實文章 URL）當佐證
    5. 輸出 docs/news.json：sectors[] = { 族群, 漲停股(代碼/漲幅/原因), 相關新聞 }；新聞跨班累積、跨日封存
  lib/core.mjs   getJson / getText / callGemini / getTodayLimitUps / MIS 即時 / dated 全市場（部分移植自 TwStockRank）
```

設計取捨：
- **核心是「今日漲停股，依族群分組、依漲停家數排強弱」**——用實際市場資料，不靠新聞運氣決定哪個族群強。盤中用證交所 MIS 即時行情，零金鑰。
- **族群分類**：Gemini 把漲停股分到 `CANONICAL_SECTORS`（程式內固定清單）的精細族群；分不出來的退回官方產業別，零碎產業別併進「其他」。
- **新聞為佐證**：來自 Google News RSS（真實標題＋連結，解析掉 google 轉址），Gemini 不碰網址，避免幻覺。

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
