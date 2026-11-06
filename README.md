# Herdr TokenBar

`herdr-tokenbar` 是 Herdr 的 token 與 context 常駐狀態列插件。

在 Herdr agent 側欄逐一顯示各 agent 的累計 token 用量與 context 進度條；分頁列右側也會顯示目前 agent 的詳細用量，每兩秒更新。

側欄將 agent 身分、累計用量、context 數字與進度條分行顯示，agent 之間預設留一行空白：

```text
● Local · my-project · 1
  codex
  Tokens 117.3k
  Ctx 98.9k/828.4k
  █░░░░░ 12% · 729.5k left

● Local · other-project · 2
  claude
  Tokens 581.3k
  Ctx 148k/200k
  ████░░ 74% · 52k left
```

所有 token 數字統一以 `k` 顯示（1k = 1,000 tokens），最多保留一位小數；超過百萬也維持 `k`，例如 `1,456.2k`。`Ctx` 是已用／上限，進度條與百分比表示已用比例，`left` 是剩餘 tokens。已用低於 50% 為綠色、50%～80%（含邊界）為黃色、超過 80% 為紅色；無資料時顯示灰色 `--`。

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

啟用動作會備份目前的 `config.toml`，加入狀態列項目與 agent 側欄的三行用量，並重新載入 Herdr 設定。舊版單行 `$tokenbar` 會自動更新，包含 `rows_by_agent` 中的配置。現有的狀態項目、agent 身分列、其他設定與設定檔中無關的註解會保留。未設定 agent 的 `row_gap` 時會加入 `row_gap = 1`；已有明確設定時保留原值。重複啟用不會增加重複項目。停用時會移除插件新增的用量列與間距設定；若你已改動間距值，會保留你的設定。若目前 client 尚未更新顯示，在 Herdr Settings 執行 **reload config**，或重新連接 client。

支援 `HERDR_CONFIG_PATH` 指定的設定檔。腳本複製到插件設定目錄內的固定 runtime 路徑，常駐顯示不依賴目前工作目錄，也不會因 Herdr 清理舊版插件安裝目錄而失效。更新插件後再執行一次 `enable` 即可更新 runtime；Herdr server 啟動時也會同步 runtime。

Herdr 會在分頁列太窄、空間不足時隱藏右側狀態區。拉寬終端即可恢復；行動版與摺疊顯示方式由 Herdr 控制。

## 資料來源

**Codex：自動讀取。** 透過 Herdr 的 `agent_session` 取得確切 session ID，再讀取 `$CODEX_HOME/sessions`，預設為 `~/.codex/sessions`。使用最新有效的 `token_count` 事件及事件中的 `model_context_window`，不依模型名稱猜上限。更新發生在 Codex 寫入用量事件之後，並非逐 token 計數。啟用 Herdr 的 Codex integration 後，新開或恢復的 session 才會有 session 對應；沒有對應時顯示 `--`。插件不會用同目錄的另一個 session 代替。

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
