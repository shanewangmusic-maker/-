# CRM 機器人介面（crm-bot-api）

助理讀寫 CRM 用。

這是給「沒有瀏覽器、只會呼叫網址」的 AI 助理用的一扇門。讀取、修改、新增、刪除都先給你看中文的「修改前／修改後」，你拿出確認碼之後才寫進雲端。

線上的 Worker 名稱是 **crm-assistant-gateway**。密語不用重設。這份程式更新**不會自動部署**；要新功能生效時，在這個資料夾再執行一次 `npx wrangler deploy`，不要換密語，也不要貼進手寫辨識那個 Worker（`crm-ai`）。每月備份那支 Apps Script 維持只讀。

## 它做得到、做不到

做得到：

- 讀完整客戶欄位（仍要機器人金鑰）：`GET /customers`、`GET /customers/客戶id`。
- 讀財務規劃：`GET /fintrack/計畫id`。
- 看最近的寫入和對應備份：`GET /history`。
- 預覽這些操作（都先不改資料）：新增聯絡、改下次聯絡日、改客戶欄位、新增客戶、刪除客戶、改一筆聯絡、刪一筆聯絡、建立或修改財務規劃、用備份還原、手動加計或取消行動闖關事件。
- 你拿出確認碼之後才寫入。寫入前再對一次版本號；中間有人存過檔就取消。寫入前先把整本帳或那份財務規劃另存一份，並留下操作紀錄。

做不到：

- 不能改成員名單，也不能刪 `bot_backups` 裡的備份。
- 網址上的 DELETE 不能繞過確認。刪除一定要走預覽，預覽會寫明「即將刪除」。
- 機器人的金鑰**不能**代替你的確認碼。

聯絡紀錄寫在哪裡，跟 CRM 頁面相同：

- 一畝田名單如果已經連結核心看板：寫進「最近有紀錄的那一單」的跟進歷程。你預覽時會看到寫進哪一筆。
- 一畝田名單如果還沒連結：寫進這筆名單自己的聯絡紀錄。
- 你指定的是核心看板的某一單：只寫進那一單。
- 下次聯絡日會跟著這個人，同步到連結的名單和每一單。
- 改一畝田的姓名時，已連結的核心單會一起改名。刪除客戶時，連結會像 CRM 頁面一樣解開；若刪的是最後一張核心單，聯絡紀錄會帶回一畝田。其他沒點到的客戶不會動。

## 預覽操作

每一次預覽的 `diff.text` 都是中文的「修改前」和「修改後」。刪除時另外有 `diff.warning`，開頭是「即將刪除」。

| op | 你要送的內容 |
|---|---|
| `appendContact` | `customerId`、`date`、`method`（Line、電話、面談、其他）、`content`、可省略的 `time` |
| `setNextContact` | `customerId`、`date`（空白代表清空） |
| `updateCustomer` | `customerId`、`patch`。`patch` 只能用 CRM 頁面有的欄位，例如姓名、電話、`stage` 或 `progress`、`category`、`agentName`、`notes`、`tags`、保單欄位。不能直接整包換掉聯絡紀錄 |
| `createCustomer` | `customer`，至少要有 `name` |
| `deleteCustomer` | `customerId` |
| `editContact` | `customerId`、`contactId`、`patch`（date、method、content、time、endDate） |
| `deleteContact` | `customerId`、`contactId` |
| `createFintrack` | `planId`，可加 `clientName`、`snap`（計畫內容物件） |
| `updateFintrack` | `planId`，加上要改的 `clientName` 或 `snap` |
| `undo` | `backupId`（`GET /history` 裡那一筆的備份編號） |
| `addQuestCounts` | `date`（2026-10-17 以後）、`counts`（例如 `{"warm":2,"call":3}`；項目只接受 warm、call、appt、meet、need、prop、deal、client、lead，每項 0–30，一次最多 60）、可加 `side`（`ds` 陌生／`rf` 緣故，預設 ds）、`note`。只寫行動闖關，不動客戶帳；要先開啟闖關寫入 |
| `undoQuest` | 二選一：`eventIds`（要取消的事件編號陣列，`ae_` 或 `am_` 開頭，一次最多 60 筆），或 `previewId`（取消那一次寫入計入的全部闖關事件）。只寫行動闖關，不動客戶帳；要先開啟闖關寫入 |

`appendContact` 和 `updateCustomer` 另外可以帶（放在最外層，不是 patch 裡）：
- `byEmail`：只接受擁有者信箱（`QUEST_OWNER_EMAIL`，預設 shanewangmusic@gmail.com）。新增的歷程列、階段變更列會蓋上這個信箱，和網頁新增的一樣。
- `act`：只接受 `call`（約訪）、`appt`（取得約會）、`need`（發掘需求）。
沒帶就不蓋，和以前一樣。

`updateCustomer` 改階段時照網頁的規則：加一筆「階段由「X」改為「Y」」歷程（台灣日期）、轉待定／流失時記下 `lastStage`、不是關鍵訪就清空預計規劃欄位、成交（`stage: "WON"` 或 `category: "WON"`）時 `progress` 清空並清掉下次聯絡日。名單（LEAD）和核心客戶之間的轉換請在網頁做。

### 行動闖關自動計入

網頁只在瀏覽器存檔時計入闖關，所以機器人寫的紀錄要自己寫事件。事件編號和去重和網頁 `aqPlanEvents`／`crm-link.js` 完全一樣（`ae_<客戶>_<項目>_<日期>`），寫到 `actionquest/{TEAM_ID}/users/{擁有者 UID}/auto/{編號}`，多一個 `src: "crmbot"`。只有蓋了擁有者 `byEmail` 的列才會計入。

目前的資料庫規則只允許本人（`request.auth.uid == userId`）寫自己的 auto，機器人帳號寫不進去，所以這功能**預設關閉**：預覽會列出「會計入」的事件，寫入時回傳 `quest.disabled`。開啟步驟：
1. 在規則加上下面這段（OWNER_UID 換成擁有者的 UID）。
2. Worker 設定 `QUEST_OWNER_UID`（擁有者 UID）和 `QUEST_AUTO_WRITE=1`。

闖關事件是在客戶帳寫好之後才寫；就算闖關寫入失敗，客戶帳也已經寫好，回應裡的 `quest.error` 會說明。

```
    // 助理專用：行動闖關自動計數（只能替「擁有者」新增、讀取；不能改、不能刪）
    // OWNER_UID 換成 shanewangmusic@gmail.com 在 Firebase Authentication 的 UID
    // ae_／am_ 是一般事件（+1）；ar_ 是取消（沖銷）紀錄：編號 = 'ar_' + 原事件編號、原事件要存在、delta 一定是 -1
    match /artifacts/youtrend-crm/public/data/actionquest/{teamId}/users/{userId}/auto/{eventId} {
      allow read: if request.auth != null
        && request.auth.token.email == 'crmbot@fish-teem.com'
        && userId == 'OWNER_UID';
      allow create: if request.auth != null
        && request.auth.token.email == 'crmbot@fish-teem.com'
        && userId == 'OWNER_UID'
        && eventId.matches('^a[emr]_[A-Za-z0-9_-]{1,190}$')
        && (
          (eventId.matches('^ar_.*')
            && request.resource.data.undoOf is string
            && request.resource.data.undoOf.matches('^a[em]_.*')
            && eventId == 'ar_' + request.resource.data.undoOf
            && exists(/databases/$(database)/documents/artifacts/youtrend-crm/public/data/actionquest/$(teamId)/users/$(userId)/auto/$(request.resource.data.undoOf))
            && request.resource.data.delta == -1)
          ||
          (eventId.matches('^a[em]_.*')
            && (!('delta' in request.resource.data) || request.resource.data.delta == 1))
        )
        && request.resource.data.uid == userId
        && request.resource.data.teamId == teamId
        && request.resource.data.email == 'shanewangmusic@gmail.com'
        && request.resource.data.src == 'crmbot'
        && request.resource.data.action in ['warm', 'call', 'appt', 'meet', 'need', 'prop', 'deal', 'client', 'lead']
        && request.resource.data.side in ['ds', 'rf']
        && request.resource.data.date is string
        && request.resource.data.date.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        && request.resource.data.date >= '2026-10-17';
    }
```

### 取消算錯的闖關事件（「剛剛那個不要」）

規則不允許刪除闖關事件，所以「取消」是**另外新增一筆抵銷紀錄**，原本那筆留著不動：

- 抵銷紀錄的編號是 `ar_` 加上原事件編號（例如 `ar_ae_solo_call_2026-10-17`），欄位照抄原事件（uid、teamId、email、custId、histId、action、date、round、side、name、leadId），再加上 `delta: -1`、`undoOf: 原事件編號`、`src: "crmbot"`、`createdAt`、`previewId`（取消那一次的預覽編號）。
- 一筆原事件只會有一筆抵銷紀錄（只新增、不覆蓋）；已經取消過的、找不到的、不是擁有者名下的，預覽會列在 `diff.questUndoSkipped` 並略過。全部都不能取消時，預覽直接回錯誤「沒有可以取消的行動闖關事件」，並說明原因。
- 預覽 `diff.text` 逐筆列出「取消：約訪 2026-10-17（王小明）」這樣的中文；`diff.questUndo` 是要寫的抵銷紀錄清單。
- 用 `previewId` 取消時，會找出 `previewId` 欄位是那一次的所有闖關事件（`addQuestCounts` 或客戶帳寫入計入的都可以）。抵銷紀錄本身不會再被取消。
- 被取消的原事件仍然算「已經計過」：之後同一位客戶同一天同一個項目，不會再用同一個編號重新計入。
- 行動闖關頁面加總時要把 `delta` 算進去（沒有 `delta` 的算 +1，`delta: -1` 的算 -1）。
- 編號長度：`ae_`／`am_` 編號最長 180 字，所以 `ar_` 編號最長 183 字，在規則的上限（`a?_` 後面最多 190 字）以內。

還原會把該次寫入之前的客戶帳或那一份財務規劃放回去，並再留一份新備份，所以還原本身也可以再還原。

還原的規則（客戶帳）：
- 那次寫入之後**沒有任何人再改過**（現在的 `_rev` 剛好等於那次寫入後的 `_rev`）→ 整份放回，預覽會逐條列出會改回的地方。
- 之後**有人改過** → 只反轉那一次的變更（刪掉那次新增的紀錄、把改過的紀錄或欄位改回、放回那次刪除的紀錄或客戶），其他人的修改全部保留。每次寫入的備份都會在 `_backup.changeSetJson` 記下那次改了什麼；舊備份沒有這一欄時，用當時的預覽重算。
- 那次改到的地方之後**又被別人改過** → 拒絕，並說明是哪裡，請到 CRM 網頁手動處理。
- 財務規劃只能在之後沒人改過時整份還原。
- 那次寫入如果有計入行動闖關事件，還原時會一併替那些事件寫抵銷紀錄（只處理還在、而且還沒取消過的），預覽的 `diff.questUndo`、`diff.text` 會列出「取消：…」。闖關寫入還沒開啟時不會取消，預覽的 `diff.warning` 和寫入回應的 `quest.disabled` 會說明。
- 還原「還原」時，已經取消的闖關事件不會恢復（抵銷紀錄不能刪），需要的話請在行動闖關頁面手記或用 `addQuestCounts` 補。

## 資料庫規則要加的部分

若現在的規則已經讓任何登入帳號讀寫整棵 `artifacts/youtrend-crm/public/data`，不必再改。

若規則只允許你的信箱，把機器人信箱加進去，並允許讀寫財務規劃。**不要**允許刪除 `bot_backups`。下面這一段是完整規則；如果畫面上還有其他成員的權限，不要整份覆蓋，只把 `fintrack` 和三個 `bot_` 集合補進現有規則。把 `機器人的信箱` 換成第 1 步建立的信箱。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedInEmail() {
      return request.auth != null && request.auth.token.email != null
        ? request.auth.token.email
        : '';
    }
    function canUseBotApi() {
      return signedInEmail() == 'shanewangmusic@gmail.com'
          || signedInEmail() == '機器人的信箱';
    }

    match /artifacts/youtrend-crm/public/data/global_state/{teamId} {
      allow read, create, update: if canUseBotApi();
      allow delete: if false;

      match /fintrack/{planId} {
        allow read, create, update: if canUseBotApi();
        allow delete: if false;
      }
    }

    match /artifacts/youtrend-crm/public/data/bot_previews/{id} {
      allow read, create, update: if canUseBotApi();
      allow delete: if false;
    }

    match /artifacts/youtrend-crm/public/data/bot_backups/{id} {
      allow read, create, update: if canUseBotApi();
      allow delete: if false;
    }

    match /artifacts/youtrend-crm/public/data/bot_audit/{id} {
      allow read, create, update: if canUseBotApi();
      allow delete: if false;
    }
  }
}
```

## 你要先準備

1. 一個 Cloudflare 帳號（你已經有 Worker 了）。
2. Firebase 專案 `fish-teem` 的主控台權限。
3. 你的 CRM 團隊代碼（登入 CRM 時輸入的那一組，英文大小寫不拘，程式會轉成大寫）。
4. 密碼管理器。金鑰只放那裡和 Cloudflare 的密語區，**不要貼到聊天、不要寫進這個資料夾、不要寫進 CRM 頁面**。

## 一步一步設定

### 1. 幫機器人另開一個 Firebase 登入帳號

1. 打開 [Firebase 主控台](https://console.firebase.google.com/)，選專案 **fish-teem**。
2. 左側「Authentication」→「Sign-in method」，確認「電子郵件/密碼」是啟用的。
3. 「Users」→「Add user」。
4. 填一個專用信箱，例如 `crm-bot@你的網域`。這個信箱不必真的收信。
5. 設一組長密碼。抄進密碼管理器。
6. **不要用你自己的 CRM 密碼。**

### 2. 看資料庫規則要不要加這個帳號

1. 同一專案左側「Firestore Database」→「規則」。
2. 搜尋 `global_state`。
3. 如果規則已經寫成「任何登入的人都能讀寫這棵資料」，就**不要再放寬**。財務規劃也在這棵資料底下，機器人登入後就能讀寫。
4. 如果規則只允許你的信箱：用上面「資料庫規則要加的部分」那一整段。它允許讀寫客戶帳、財務規劃，以及預覽、備份、操作紀錄。備份只能新增和更新，不能刪。
5. 按發布。不確定怎麼改時，先不要發布，把畫面上的規則原文存下來再問人。不要整份換成「全部允許」。

### 3. 讓過期的預覽單自動清掉

預覽單 30 分鐘後就不能再確認。請再設自動刪除，雲端才不會一直堆：

1. Firestore →「存留時間」（TTL）。
2. 建立原則。集合群組填 `bot_previews`，欄位填 `expireAt`。
3. 儲存。這個刪除是 Firebase 自己做的，不是機器人呼叫刪除。

### 4. 部署到已經在用的 Worker

在自己的電腦、這個資料夾裡做。目標是已經上線的 **crm-assistant-gateway**。不要部署到 `crm-ai`。密語已經設好就不要再 `secret put`。

```bash
cd workers/crm-bot-api
npx wrangler login
npx wrangler secret put BOT_KEYS
npx wrangler secret put APPROVAL_SECRET
npx wrangler secret put FIREBASE_API_KEY
npx wrangler secret put BOT_EMAIL
npx wrangler secret put BOT_PASSWORD
npx wrangler secret put TEAM_ID
npx wrangler deploy
```

每一項貼上值之後按 Enter。值的內容：

| 密語 | 填什麼 |
|---|---|
| `BOT_KEYS` | 一行 JSON。每個機器人一個名字、一把金鑰。例：`{"助理甲":"這裡換成一長串亂碼"}` |
| `APPROVAL_SECRET` | 另一串更長的亂碼。這是你的確認碼。不要放進 `BOT_KEYS`，不要告訴機器人 |
| `FIREBASE_API_KEY` | Firebase → 專案設定 → 一般 → 你的網頁應用程式 → API 金鑰（和 CRM 頁面同一把） |
| `BOT_EMAIL` | 第 1 步建立的機器人信箱 |
| `BOT_PASSWORD` | 第 1 步的密碼 |
| `TEAM_ID` | 你的 CRM 團隊代碼 |

金鑰請用密碼管理器產生，至少 24 個英數。前後不要留空白。

部署完成後，畫面上會有一個新網址，形如 `https://crm-bot-api.<你的帳號>.workers.dev`。用瀏覽器打開網址後面的 `/health`，看到 `{"ok":true,"service":"crm-bot-api"}` 就代表門有開。這一步還不會顯示客戶。

### 5. 把讀取權限交給機器人

只把 **Worker 網址** 和 **那一把機器人金鑰** 放進該機器人的密語區。不要把 `APPROVAL_SECRET`、Firebase 密碼放進去。

請機器人先做讀取。下面把網址和金鑰換成你的（這只是格式）：

```bash
curl "https://你的網址/customers?name=王" \
  -H "Authorization: Bearer 這個機器人的金鑰"
```

看得到姓名和電話、看不到保費，才進行下一步。

## 每次寫入你要做的確認

機器人只能先呼叫預覽。預覽回傳 `previewId`、`baseRev` 和 `diff`（會改哪一位、改了什麼）。**這時候 CRM 還沒變。**

你看完差異，同意了，才自己把確認碼交出去，呼叫確認：

```bash
curl -X POST "https://你的網址/commit" \
  -H "Authorization: Bearer 這個機器人的金鑰" \
  -H "Content-Type: application/json" \
  -d "{\"previewId\":\"預覽回傳的那組\",\"approvalCode\":\"你的確認碼\"}"
```

請把確認碼只放在這一次的確認裡。不要寫進機器人的長期指令。機器人若把確認碼記下來，它之後就能自己確認；若發生這種事，立刻換一把 `APPROVAL_SECRET`。

兩種預覽的內容：

- 新增聯絡：`{"op":"appendContact","customerId":"客戶 id","date":"2026-10-16","method":"電話","content":"講了什麼","time":"09:30"}`  
  `method` 只接受 `Line`、`電話`、`面談`、`其他`。`time` 可省略。
- 下次聯絡日：`{"op":"setNextContact","customerId":"客戶 id","date":"2026-10-20"}`  
  `date` 用空白字串代表清空。

預覽 30 分鐘內要確認。超過、或這段時間 CRM 有人按了儲存，確認會失敗，必須重新預覽。成功時回傳新的版本號、備份編號和紀錄編號。

讀取單一人：`GET /customers/客戶id`。搜尋用 `?name=` 和 `?phone=`，兩個都填時必須同時符合。電話的橫線會被忽略。同一個人在一畝田和核心看板會是不同列，請看預覽寫進哪一個 id。

## 出事時怎麼找回

每一次成功的寫入都會先把**當時整本帳**存到 `bot_backups`，並在 `bot_audit` 記下一筆是哪個機器人、哪次預覽、改了什麼。Firebase 主控台 → Firestore → `artifacts` → `youtrend-crm` → `public` → `data` → `bot_backups`，打開該次的 `backupId`，裡面的 `cust` 就是寫入前的客戶清單。這支程式沒有自動還原按鈕；要還原時，用那份備份對照，不要直接刪資料。
