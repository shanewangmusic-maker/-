# 模擬操盤資料 `data/trades.json`

`office.html`（AI 操盤公司）啟動時會讀取同一專案裡的 `data/trades.json`，用來顯示 1F 行情牆（磚與跑馬燈）、餘額、討論紀錄，以及「問他」的回答。這個檔案是靜態資料，頁面只會讀取，不會寫回。

與 Firebase、CRM 無關。頁面不會因為這個檔案去連雲端、改客戶資料，或改動 `aio10_` 開頭的本機儲存。

檔案讀不到、格式不是物件，或請求失敗時，頁面安靜地沿用內建的假畫面，不跳出錯誤。之後每 5 分鐘會再讀一次（網址帶 `?nc=` 與當下時間，避免瀏覽器拿舊檔）。若重新讀取失敗，畫面上一次已經成功的內容會留著。

## 頂層欄位

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `sample` | 否 | `true` 代表整份都是假的示範資料。頁面會多一個小標「示範資料」。正式的紙上交易請設為 `false`，或不要寫這個欄位。 |
| `updatedAt` | 是 | 這份資料的更新時間。ISO 8601，必須帶台北時區 `+08:00`。例：`2026-10-26T18:05:00+08:00`。 |
| `month` | 是 | 帳務月份，`YYYY-MM`。 |
| `budgetUSD` | 是 | 本月虛擬預算，美元。損益基準先用這個數字。若 `capitalEvents` 的入金合計比它大，代表預算還是入金前的本金，基準改為預算加上那些入金。沒有這個欄位時，基準改為入金合計。兩個都沒有時，不假設 5000，損益那一格留空。 |
| `cashUSD` | 是 | 現金餘額，美元。 |
| `equityUSD` | 是 | 權益（現金加上持股市值），美元。畫面上的損益＝`equityUSD` 減去上面的損益基準。 |
| `positions` | 是 | 目前持股。沒有持股時給空陣列 `[]`。 |
| `trades` | 是 | 成交。較新的放前面。沒有成交時給 `[]`。 |
| `watchlist` | 是 | 行情牆的磚與底部跑馬燈。 |
| `discussions` | 是 | 討論紀錄。 |
| `meetings` | 否 | 會議。沒寫時，討論仍會顯示，只是全部歸進「當日其他討論」。 |
| `dailyReport` | 是 | 當日一句摘要。 |
| `rules` | 否 | 交易守則提醒。沒寫就沿用頁面上的預設句子。 |

## `positions[]` 持股

| 欄位 | 說明 |
| --- | --- |
| `market` | `TW` 台股，或 `US` 美股。 |
| `symbol` | 代號，例如 `2330`、`NVDA`。 |
| `name` | 名稱。 |
| `shares` | 股數。 |
| `avgCost` | 平均成本。單位看 `currency`。 |
| `currency` | `TWD` 或 `USD`。 |
| `lastPrice` | 參考現價，單位與成本相同。 |
| `pnlPct` | 未實現損益的百分比。正數為賺、負數為賠。 |

## `trades[]` 成交

| 欄位 | 說明 |
| --- | --- |
| `date` | 台北日期，`YYYY-MM-DD`。 |
| `time` | 24 小時制，`HH:MM`。 |
| `market` | `TW` 或 `US`。 |
| `symbol` | 代號。 |
| `name` | 名稱。 |
| `side` | `BUY` 買進，或 `SELL` 賣出。 |
| `shares` | 股數。 |
| `price` | 成交價。台股為新台幣，美股為美元。 |
| `feeUSD` | 手續費，美元。 |
| `reason` | 這筆單的理由。「問他」問「為什麼」時會引用。 |
| `decidedBy` | 誰拍板。只能是 `scout`、`research`、`devil`、`risk`、`decision`、`recorder`、`gm` 其中一個。 |

## `watchlist[]` 行情牆

| 欄位 | 說明 |
| --- | --- |
| `market` | `TW` 或 `US`。 |
| `symbol` | 代號。 |
| `name` | 磚上的標題，例如「加權指數」。 |
| `lastPrice` | 現價或指數點位。 |
| `changePct` | 漲跌百分比。正數上漲、負數下跌。 |

畫面上：純數字代號（台股）價格前加 `NT$`；美股代號且價格小於 1000 時加 `$`；指數點位只顯示數字。跑馬燈會把整份觀察清單接在一起滾動。牆上的四格磚顯示清單的前四筆，點開行情牆面板時會列出全部，並附上現金、權益、以及相對損益基準的損益。基準見 `budgetUSD`。

## `discussions[]` 討論

| 欄位 | 說明 |
| --- | --- |
| `date` | 台北日期，`YYYY-MM-DD`。 |
| `time` | `HH:MM`。 |
| `role` | 發言的人：`scout` 找標的、`research` 查資料、`devil` 唱反調、`risk` 風控、`decision` 整合決策、`recorder` 記錄、`gm` 操盤總管。 |
| `text` | 這則話的內容。 |
| `relatedSymbol` | 選填。這則在談的代號。 |
| `decision` | 選填。結論，例如 `買進`、`賣出`、`等待`、`通過`、`否決`。 |
| `meetingId` | 選填。對應 `meetings[].id`。沒寫、或對不到任何會議時，這則會進該日期的「當日其他討論」。 |

## `meetings[]` 會議（選填）

| 欄位 | 說明 |
| --- | --- |
| `id` | 會議代號，同一份檔案裡不要重複。`discussions[].meetingId` 用這個值。 |
| `date` | 台北日期，`YYYY-MM-DD`。 |
| `time` | 開始時間，`HH:MM`。 |
| `title` | 會議名稱，例如「盤中會議」。 |
| `topic` | 這場在談的主題，例如「NVDA 小部位」。 |
| `attendees` | 出席角色陣列。每個值與 `discussions[].role` 相同：`scout`、`research`、`devil`、`risk`、`decision`、`recorder`、`gm`。 |
| `summary` | 選填。展開後附在逐字稿下面的一段摘要。 |
| `decision` | 選填。卡片上的一行結論，例如「買進 NVDA 3 股」。 |

討論紀錄以會議卡片列出，較新的在上面。每張卡片顯示日期與時間、名稱與主題、出席者、以及一行結論。點卡片會展開該場逐字稿，依時間由早到晚排列，每一則帶角色名稱、時間與內容。角色名稱沿用畫面上的座位名；若使用者改過名，讀的是 `localStorage` 的 `simRoleNames`（不是 `aio10_` 那些鍵）。

卡片上方有「全部角色」篩選。選一位之後，只留下他出席或有發言的會議，展開時也只顯示他的話。

沒有 `meetingId` 的討論，依日期收成一張「當日其他討論」。舊檔沒有 `meetings` 時也一樣，每一天一張，不會因此空白。檔案讀不到時，討論紀錄改用內建的兩場示範會議（不會寫進 `data/trades.json`）。

1F 會議桌可以點，會打開這份討論紀錄。若有一場會議的 `date` 是台北的今天，出席者裡有座位的角色會坐到 1F 會議桌四周，沒出席的人留在自己的位子。`gm` 沒有交易桌，只出現在名單與逐字稿裡。

座位對應是：`scout`→找標的、`research`→查資料、`devil`→唱反調、`risk`→風控、`decision`→整合決策、`recorder`→記錄。`gm` 沒有桌子，只出現在討論紀錄裡。

台北「今天」有發言的角色，桌子上的螢幕會亮。沒有人在今天發言時，不額外輪流點亮。檔案沒讀到時，才恢復原本每 5 秒換一位的示範閃法。

「問他」若問題裡有「為什麼」（空白送出時的預設問題也算），就引用這位角色台北今天的 `text`，並附上他今天拍板的成交 `reason`。今天沒有他的討論時，回答「當天沒有這位的紀錄」。

## `dailyReport` 日報

| 欄位 | 說明 |
| --- | --- |
| `date` | `YYYY-MM-DD`。 |
| `summary` | 當日摘要，顯示在活動紀錄最上面。 |

## `rules` 守則提醒（選填）

| 欄位 | 說明 |
| --- | --- |
| `maxPositionPct` | 單筆最多占總資金的百分比。頁面上的提醒預設是 10。 |
| `dailyStopLossPct` | 當日虧損達到這個百分比就停手。預設是 3。 |
| `leverage` | `false` 表示不開槓桿。`true` 表示允許槓桿。 |

## `capitalEvents[]` 入金（選填）

沒寫、不是陣列、或沒有任何列得出日期與金額的項目時，不顯示「入金與成本紀錄」。多出來的欄位會略過，不會讓畫面壞掉。

| 欄位 | 說明 |
| --- | --- |
| `date` | 台北日期，`YYYY-MM-DD`。 |
| `time` | 選填。`HH:MM`。 |
| `type` | `DEPOSIT` 顯示「入金」，`WITHDRAWAL` 顯示「出金」，`COMPANY_COST` 顯示「成本扣除」。其他文字照原樣。 |
| `amountUSD` | 金額，美元。出金與成本在畫面上是負數。沒有這個欄位時，改看 `amount`。 |
| `note` | 選填。備註。 |

清單較新的放前面。入金會加進損益基準的判斷，見 `budgetUSD`。

## `companyCosts` 公司成本（選填）

可以是陣列，每一筆用跟 `capitalEvents` 一樣的 `date`、`time`、`type`、`amountUSD`、`note`。
也可以是一個物件，用來描述每月成本。物件時，畫面依 `incomeStatement.daily` 的當日攤提，按薪資與營運的比例拆成兩列。同一天有多筆時只取 `time` 最晚的那一筆，避免把同一天的重算各列一次。沒有每日攤提時，改列每月金額。沒有可列的內容時，這個區塊不出現。`capitalEvents` 裡已經有成本列時，不再用這個物件重列一次。

物件常用欄位：

| 欄位 | 說明 |
| --- | --- |
| `breakdown_twd.salaries` | 選填。`headcount` 人數、`per_person` 每人月薪、`total` 薪資合計，單位新台幣。 |
| `breakdown_twd.operations` | 選填。每月營運成本，新台幣。 |
| `fx_usd_twd` | 選填。美金兌台幣匯率，用來把台幣成本換成美元。 |
| `monthly_twd` / `monthly_usd` | 選填。每月成本合計。 |
| `settlement_day` | 選填。結算日。有寫就顯示「每月 N 號結算」。沒寫時畫面寫「每月 10 號結算」。 |
| `breakeven_monthly_return_pct` | 選填。打平所需的月報酬百分比。有寫就顯示「打平門檻 N%」。沒寫時畫面寫「打平門檻 56.58%」。 |
| `cycle` | 選填。結算週期的一句說明，放在紀錄下面。 |
| `accrual`、`first_period_estimate` | 選填。攤提與第一期的說明。畫面只在沒有每日攤提時，用 `first_period_estimate.period` 的起日當日期。 |

其他欄位略過。

## `incomeStatement` 收支表（選填）

沒寫、或 `daily`、`monthly` 裡都沒有損益數字時，不顯示「收支表」。多出來的欄位略過。

| 欄位 | 說明 |
| --- | --- |
| `daily[]` | 選填。以 `date` 與 `time` 最新的一筆當作本期。同一天有多筆時，收支表用最晚那一筆。不是陣列時略過，不影響其他畫面。 |
| `monthly[]` | 選填。沒有 `daily` 時改用這裡最新的一筆。 |
| `format` | 選填。給人看的欄位說明，畫面不依賴它。 |

每一筆裡會用到的數字：

| 欄位 | 畫面上的列 |
| --- | --- |
| `realized_pnl_usd` | 已實現損益。 |
| `unrealized_pnl_usd` | 未實現損益。 |
| `fees_usd` | 手續費。正數會畫成支出（負數、紅色）。 |
| `salaries_usd` 或 `salaries_cum_twd` | 薪資。只有台幣時，用同一筆的 `fx`，沒有再改用 `companyCosts.fx_usd_twd` 換算。 |
| `operations_usd` 或 `operations_cum_twd` | 營運成本。換算方式與薪資相同。 |
| `net_after_cost_usd` | 扣完成本後淨收支。沒有這個欄位時，用 `trading_net_usd` 減去 `cost_accrued_today_usd`。 |
| `net_after_cost_cum_usd` 或 `cumulative` | 本期累計。`cumulative` 可以是數字，或帶 `net_after_cost_usd` 的物件。 |

某一列沒有數字就整列不顯示。正數綠色、負數紅色。`period` 有寫時，放在標題下面。

## 附帶的顯示規則

- `sample` 為 `true` 時，模擬操盤畫面的紅標旁會出現「示範資料」。行情牆畫面也會標同一句。
- 餘額畫面的數字是：現金 `cashUSD`、權益 `equityUSD`、損益（權益減去損益基準）。基準見 `budgetUSD`，不再寫死 5000。詳細資料裡另有「收支表」與「入金與成本紀錄」；對應欄位沒寫時，那一塊不出現。「每月 10 號結算」與「打平門檻 56.58%」在檔案沒給數字時仍會顯示這兩句。
- 座位名稱、樓層配置，以及 `localStorage` 裡 `aio10_` 開頭的鍵，都不因這個檔案而改名或清除。角色顯示名稱仍沿用原本的 `simRoleNames`。
