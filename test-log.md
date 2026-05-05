# AI 葡萄酒社交教練 — 測試紀錄

（每次批次測試後追加一節；嚴格模式下請附 `COACH_URL`、`ACCESS_CODE`、部署分支／commit。）

---

## 2026-05-02 — 程式理解與自主優化清單（首席工程師交接）

### 後端 `api/coach-chat.js`（理解摘要）

- **執行環境**：Vercel Serverless，`POST` only；JSON body 支援字串／Buffer／物件。
- **驗證**：可選 `APP_ACCESS_CODE`；可選 `APPROVED_EMAILS` 白名單與 `user_email`。
- **模型**：`generateGeminiContent`（`api/gemini-generate-content.js`），`systemInstruction` 載入 **`maenads_system_prompt.md`**（含路徑後援與記憶體快取）。
- **對話組裝**：`normalizeHistoryExcludingLatestUser` 避免 user 最後一則重複；`buildGeminiContents` 取最近 **`GEMINI_HISTORY_MAX_TURNS`（預設 12）**；`compactGeminiContents` 合併連續同角色。
- **本輪使用者文字**：`message` + 可選 **`local_context`**（前端 LOCAL_KB 命中後附加「本地知識補充」）。
- **生成參數**：`temperature` 0.8、`maxOutputTokens` 由 **`GEMINI_MAX_OUTPUT_TOKENS`**（預設 2048）束在 512–8192。
- **回應**：200 回傳 `reply`、`model`、`finishReason`；502／500 等錯誤有對應 JSON。

### 前端 `ai/index.html`（理解摘要）

- **UI**：側邊對話列表、`localStorage`（`wine-coach-chats-v1`）、主訊息區、底部輸入；通行碼／Email 存 `wine-coach-auth-v1`。
- **`LOCAL_KB`**：輕量關鍵字檢索，命中項當 `local_context` 一併 POST（輔助對題，非離線完整推理）。
- **`askCoach`**：`POST /api/coach-chat`，約 **45s** `AbortController`；**502／504／429／503** 自動 **重試一次**；細緻區分 403／413／404／524 系列／HTML 誤當 JSON 等使用者文案。
- **`buildCoachMessagesPayload`**：最近 **16** 則訊息映射為 role／content（後端仍會再截斷）。

### 關於「每次 20 題／修改 prompt／再測／紀錄本檔」

- 流程可行：擴充 `scripts/coach-prompt-eval.js` 或另建 **`scripts/coach-quality-batch.js`**（20 題固定題組 + 可選 LLM 簡評），每次跑完 **append** 本檔「輪次摘要 + 失敗題 ID + prompt diff 摘要」。
- **需環境**：已部署之 `COACH_URL`、`ACCESS_CODE`、`GEMINI_API_KEY`（後端）；本機無通行碼時 HTTP 403，無法驗證回答品質。

### 關於「不間斷測試 3 小時」

- 單次對話無法佔用運算 3 小時連續執行；可行做法是：**本機 tmux**／**GitHub Actions `workflow_dispatch`** 跑 `scripts/coach-autopilot.js`（間隔可調），或 **cron** 呼叫批次腳本，結果寫入 `reports/` 並摘要追加本檔。
- **待你下一則指令**：若要啟動「第一輪 20 題」，請提供可用 **`COACH_URL`** + **`ACCESS_CODE`**（或確認改打本機 `vercel dev`），我再跑批次並把結果寫入下一節。

### 我會在主動維護時思考的優化（不必等你逐題下指令）

| 面向 | 可做項目 |
|------|-----------|
| Prompt | 依失敗題型補 **禁則／必須結構**（對國、商務步驟、不提供診斷等）；控制篇幅以降低逾時。 |
| 後端 | 調 **`GEMINI_HISTORY_MAX_TURNS`**、`GEMINI_MAX_OUTPUT_TOKENS`**、必要時依題型略降 temperature（若要可加 heuristic）。 |
| 前端 | 調整重試策略、逾時文案、`slice(-16)` 與後端輪數一致；LOCAL_KB 擴充需謹慎避免與雲端打架。 |
| 測試 | 固定 20～50 題迴歸、`eval:coach:strict` 門檻、`reports/autopilot.ndjson` 檢視趨勢。 |
| 部署 | `vercel.json` **`maxDuration`** 與方案上限對齊；環境變數檢查清單。 |

---

### 2026-05-02 — 自動驗證循環（本機可跑）

- 新增 **`api/coach-history.js`**：`parseJsonBody`（予 coach-chat 用）、歷史正規化、`buildGeminiContents(maxTurns)`，與 **Vercel `coach-chat`／`chat`**、**Netlify `coach-chat-shared`** 對齊（先前 `chat.js` 仍 `-32`，Netlify 亦 `-32`，已修正）。
- 新增 **`scripts/coach-chat-unit-selftest.js`**：無網路斷言 5 組；**`scripts/coach-verify-loop.js`**：先單元，若有 `COACH_URL`+`ACCESS_CODE` 再跑 `coach-prompt-eval.js`。
- **`npm run test:coach:unit`**、**`npm run verify:coach`**。
- **`api/coach-chat.js`**：`result.detail` 缺漏時防呆 **`String(result.detail||'')`**。

---

## （以下由各輪批次測試追加）

<!-- 範例：
### 輪次 R1 — 2026-xx-xx — commit abc1234
- 題組：scripts/coach-quality-batch.js 預設 20 題
- 通過：17/20；失敗：id_3（離題）、id_11（過長截斷）
- Prompt 變更：`maenads_system_prompt.md` 增補「…」
- R2 複測：19/20
-->
