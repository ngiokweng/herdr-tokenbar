# Herdr TokenBar

`herdr-tokenbar` 是 Herdr 的 token 與 context 常駐狀態列插件。

在 Herdr agent 側欄逐一顯示各 agent 的累計 token 用量與 context 進度條；分頁列右側也會顯示目前 agent 的詳細用量，每兩秒更新。

側欄每個 agent 保留四行資料：第一行合併機器／agent 與工作區名稱，其後是累計用量、context 數字與進度條；底部改用彩色橫線分隔，不再預設留空白行：

```text
● Local/codex herdr-tokenbar
  Tokens 117.3k
  Ctx 98.9k/828.4k
  █░░░░░ 12% · 剩余: 729.5k
  ────────────────────────────────────────────────────────────────
● Local/claude other-project
  Tokens 581.3k
  Ctx 148k/200k
  ████░░ 74% · 剩余: 52k
  ────────────────────────────────────────────────────────────────
```

標題透過 `$tokenbar_header` 顯示為 `Local/<agent> <工作區標籤>`，工作區依 `workspace_id` 匹配 Herdr 的 `label`，不使用目前目錄名稱猜測。每次輪詢都會更新，所以工作區改名和 pane 的 agent 切換不需重啟。即使用量尚未回報，標題仍會上報；工作區標籤無法取得時退回該工作區 ID，連 ID 都沒有則顯示 `--`，不借用其他工作區的名稱。`HERDR_TOKENBAR_MACHINE` 可覆寫預設的 `Local` 前綴。標題與用量共用短期 metadata：啟用後等下一次輪詢才會出現，輪詢停止超過 7 秒會過期；狹窄側欄可能裁切長標題。

所有 token 數字統一以 `k` 顯示（1k = 1,000 tokens），最多保留一位小數；超過百萬也維持 `k`，例如 `1,456.2k`。`Ctx` 是已用／上限，進度條與百分比表示已用比例，`剩余:` 是剩餘 tokens，例如 `剩余: 164.5k`。預設進度條使用 15 級漸變映射：0% 綠色、50% 黃色、100% 紅色，中間比例使用插值色；無資料時保持灰色 `--`，剩餘量顯示 `剩余: --`。

**漸變範圍：** 這是整條進度列隨占用比例改變顏色，不是同一條內逐格同時顯示多種顏色。Herdr 0.9.4 每個 token 只有單一前景色，多 token 之間又會自動加分隔符；真正的條內漸變需要宿主提供富文字／連續色塊渲染，不能靠插入 ANSI 控制碼解決。

分頁列維持精簡格式：

```text
Tokens 117.3k | Context 98.9k/828.4k 12%
```

- `Tokens`：Codex 使用與 `/status` 相同的計算：累計未命中快取的 input + output tokens，即 `input_tokens - cached_input_tokens + output_tokens`。Reasoning 已包含在 output，不會再次加總。Claude 則使用其 statusline 提供的累計 input + output。
- `Context`：最近一次模型請求回報的 context 用量／可用上限，以及使用百分比。它與 session 的累計用量分開計算。
- 資料尚未回報、pane 沒有 agent，或提供者尚未支援時，固定顯示 `Tokens -- | Context --/--`。

需要 **Herdr 0.9.4+**、**Node.js 20+**、npm。使用 Herdr 原生 `ui.tab_bar_right` command，不需要另外開啟 pane。

## 安裝與啟用

在這個目錄執行：

```powershell
npm ci --ignore-scripts
herdr plugin link .
herdr plugin action invoke herdr.tokenbar.enable
```

啟用動作會備份目前的 `config.toml`，加入狀態列項目、緊湊身分列、三行用量與一行分隔線，並重新載入 Herdr 設定。原生兩行身分配置 `[["state_icon", "machine", "workspace", "tab"], ["agent"]]` 會自動遷移為 `[["state_icon", "$tokenbar_header"]]`，包含 `rows_by_agent` 中相同的配置；舊版單行 `$tokenbar` 也會更新。自訂身分列／樣式不會被重排，現有的狀態項目、其他設定與無關註解會保留。未設定 agent 的 `row_gap` 時會加入 `row_gap = 0`，以底部橫線取代空白；舊版帶有 `# herdr-tokenbar spacing` 標記的 `row_gap = 1` 會升級為 0。使用者明確指定、沒有插件標記的間距保留原值。重複啟用不會增加重複項目。停用時會將插件的預設緊湊身分列還原為原生兩行，並移除用量列、分隔線與插件新增的間距；若你已改動間距值，會保留你的設定。若目前 client 尚未更新顯示，在 Herdr Settings 執行 **reload config**，或重新連接 client。

支援 `HERDR_CONFIG_PATH` 指定的設定檔。腳本複製到插件設定目錄內的固定 runtime 路徑，常駐顯示不依賴目前工作目錄，也不會因 Herdr 清理舊版插件安裝目錄而失效。更新插件後再執行一次 `enable` 即可更新 runtime；Herdr server 啟動時也會同步 runtime。

Herdr 會在分頁列太窄、空間不足時隱藏右側狀態區。拉寬終端即可恢復；行動版與摺疊顯示方式由 Herdr 控制。

## 會話分隔、配色與排序

- 每個 agent 底部新增一條橫線，最後一個 agent 也保留底線。橫線固定為 64 個字元；超過側欄可用寬度時，Herdr 會截短並加上省略號（`…`）。這不是自適應長度，插件無法取得各個 client 的即時側欄寬度。
- 預設 8 色輪換，用於**分隔線**，不改整個會話的背景或 agent 狀態圖示。依活躍 pane ID 排序分配色槽，最多 8 個會話使用不同顏色，更多時循環；API 回傳順序改變不影響配色，但新增／關閉會話可能重新分配色槽。
- 可在 **Herdr server 的啟動環境**設定 `HERDR_TOKENBAR_SEPARATOR_COLORS`，使用 1～8 個以逗號分隔的 `#RGB`／`#RRGGBB`，再執行插件 `enable`。例如 `#89b4fa,#cba6f7,#94e2d5,#f9e2af`；少於 8 色會循環補滿。設定會在啟用時寫入側欄樣式，單獨設定呼叫 CLI 的 shell 環境不保證能傳給已執行中的 server。
- **滑鼠拖拽排序不由本插件實作。** 本插件僅透過 command 輪詢與 pane metadata 提供顯示資料，沒有 Herdr 滑鼠事件／列表順序控制介面。Herdr 0.9.4 的 Agents 區域有 Spaces／Priority 排序切換，但不是任意拖拽排序；若要拖動單個會話，需修改 Herdr 的輸入處理、排序狀態與渲染／命中測試，不能用 pane 移動或重啟會話冒充側欄排序。

## 資料來源

**Codex：自動讀取。** 透過 Herdr 的 `agent_session` 取得確切 session ID，再讀取 `$CODEX_HOME/sessions`，預設為 `~/.codex/sessions`。使用最新有效的 `token_count` 事件及事件中的 `model_context_window`，不依模型名稱猜上限。更新發生在 Codex 寫入用量事件之後，並非逐 token 計數。優先使用 Herdr 的 Codex session 對應。新會話或安裝插件前已在執行的會話可能尚未有對應；共享 Codex daemon 也可能回報過期對應。此時插件會以終端的**完整會話標題**比對 `session_index.jsonl`，再讀取匹配會話的 `session_meta` 核對工作目錄，只有唯一匹配才恢復用量。相同目錄並不足以識別會話，不會採用「最新檔案」或繼承的 `CODEX_THREAD_ID`；標題與目錄同時重複、尚未命名或尚無資料時保持 `--`。Herdr 對應若與工作目錄不符，或與已索引的另一個具名會話衝突，會先嘗試安全恢復，不把其他會話的用量顯示過來。恢復只用於插件顯示，不會改動 Herdr 的 agent lifecycle 或 session 紀錄。

Codex 的原始 `total_tokens` 包含快取輸入，不能直接拿來與 `/status` 的 Token usage 比較。例如同一筆紀錄的原始總量是 `1,456,215`，其中快取輸入 `1,338,880`，`/status` 對應的總量便是 `117,335`（未快取輸入 `86,764` + 輸出 `30,571`）。插件的 `Tokens` 顯示後者；`--json` 另外保留 `totalIncludingCached`、`input`、`cachedInput` 和 `output` 供核對。Context 仍包含快取輸入，因為它也佔用上下文。這些數值是 token 計數，不是帳單金額。

**Claude Code：透過 statusline 接入。** 在 `enable` 動作輸出中找到 `Claude statusline command`，將該命令填入 Claude 的 `statusLine.command`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/runtime/status.mjs claude-statusline"
  }
}
```

請使用 `enable` 輸出的實際路徑，並按照 JSON 規則跳脫 Windows 路徑中的反斜線及引號。需要從 Herdr pane 啟動 Claude，讓 statusline 能取得 `HERDR_PANE_ID`。這個接收器也會在 Claude 自己的狀態列印出用量。插件不會自動覆寫現有的 Claude statusline；已有自訂命令時可在原命令中串接接收器。Claude 的資料上限直接取自 statusline payload，不自行假設 200k 或 1M。此接口已用合成 payload 測試，仍需在實際 Claude session 中設定。

側欄和分頁列目前支援 Codex 與 Claude Code；其他 agent 的用量會顯示 `--`。本機插件無法讀取其他機器的 session 檔；遠端機器需要安裝插件並配置對應路徑。

## 查看原始數字

在插件目錄執行：

```powershell
node src/status.mjs --json
node src/status.mjs --pane $env:HERDR_PANE_ID --json
```

第一個命令查看 Herdr 目前聚焦的 agent；第二個查看呼叫所在的 pane。`--json` 回傳精確數字、session ID、採樣時間及無資料的原因。一般輸出統一使用 `k`。設定 `HERDR_TOKENBAR_DEBUG=1` 可在 stderr 查看 API／檔案讀取錯誤。`HERDR_TOKENBAR_STATE_DIR` 可指定數字快取目錄。

插件只在本機讀取用量與寫入自己的數字快取，不會將對話傳送至網路，也不修改 agent 的 session 紀錄。Codex 紀錄從尾端向前讀取，跳過工具輸出和未寫完的事件，並快取檔案位置與採樣結果。

## 停用與移除

先移除常駐顯示，再解除註冊：

```powershell
herdr plugin action invoke herdr.tokenbar.disable
herdr plugin unlink herdr.tokenbar
```

`disable` 只移除本插件的狀態項目。備份、runtime 與數字快取會保留；單獨執行 `plugin disable` 或 `unlink` 不會移除已寫入的 `ui.tab_bar_right` command。

## 開發驗證

```powershell
npm run check
npm test
```

測試涵蓋 `/status` 與含快取總量的區分、截圖中 117K／1.5M 的回歸案例、舊版數字快取更新、累計／context 區分、reasoning 計數、session ID 隔離、大型與未完成 JSONL 紀錄、Claude payload、設定檔保留與可重複啟停，以及 Windows `cmd.exe` 下含空白路徑的實際執行。

## 疑難排解與 0.1.3 修正

- **新會話／安裝前已在執行的會話顯示 `--`：** 0.1.3 會在每次輪詢重新解析 session，並支援上述標題＋工作目錄恢復，不必重啟 agent。若尚未有第一筆 `token_count`、標題尚未寫入索引，或匹配有歧義，仍不會虛構數字。
- **Tokens 有值，但 Context 上限／百分比是 `--`：** 檢查 `--json` 的 `usage.contextWindow`。Codex 回報 `model_context_window: null` 時，插件無法知道實際上限；不按模型名稱猜測，也不沿用別的模型或會話的上限。
- **檢查真正原因：** 在本地 checkout 執行 `node src/status.mjs --pane <PANE_ID> --json`。`sessionSource` 的 `herdr`／`title-cwd` 表示識別來源；`reason` 會區分 `no-agent-session`、`session-file-not-found`、`session-cwd-mismatch`、`ambiguous-agent-session`、`no-usage-events`、`claude-statusline-unavailable` 與檔案讀取錯誤。加上 `--herdr-tokenbar --json` 時也會保留這些診斷欄位。
- **更新本地修復版：** 執行 `npm ci --ignore-scripts`、`herdr plugin link .`，再執行 `herdr plugin action invoke herdr.tokenbar.enable` 更新固定 runtime 並重載設定。只有 Reload config 不會把舊版 runtime 換成新程式。
- 修正無計數的 `token_count` 覆蓋有效資料、損壞／越界快取路徑、Windows 並行寫入快取的暫時 `EPERM`、混合自訂側欄列中的舊 token 殘留，以及 `--pane --json` 被誤認為 pane ID 等問題。

完整自動化測試：`npm test`；含覆蓋率：`npm run test:coverage`。測試範圍與仍存在的限制見 `TEST_REPORT.md`。
