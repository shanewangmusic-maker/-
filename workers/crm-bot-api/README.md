# CRM 機器人介面（crm-bot-api）

這是給「沒有瀏覽器、只會呼叫網址」的 AI 助理用的一扇門。它能讀取 CRM 客戶、預覽一筆聯絡紀錄或下次聯絡日，並在**你親自確認之後**才寫進雲端。

這次只把程式放進版本庫。**還沒有部署，也不會自動上線。** 下面的步驟等你準備好再做。

請不要把這支程式貼進現有的手寫辨識 Worker（`crm-ai.shanewangmusic.workers.dev`）。那個密語已經存在瀏覽器裡，不能拿來改客戶資料。每月備份那支 Apps Script 維持只讀，不要改成會寫入。

## 它做得到、做不到

做得到：

- 讀客戶：姓名、電話、階段、分類、下次聯絡日、負責業務，以及最近的聯絡紀錄。
- 預覽兩種寫入：新增一筆聯絡紀錄，或設定下次聯絡日。預覽只會把「待確認單」存到另一個資料夾，**不會改客戶**。
- 你拿出確認碼之後，才真正寫入。寫入前會再對一次版本號；中間有人存過檔就取消。寫入前先把整本帳另存一份，並留下一筆操作紀錄。

做不到（故意沒有這些功能）：

- 沒有刪除。
- 不能把客戶改成已成交，也不能改保費、佣金。
- 不能改成員名單，也不能讀寫財務規劃。
- 機器人的金鑰**不能**代替你的確認碼。

聯絡紀錄寫在哪裡，跟 CRM 頁面相同：

- 一畝田名單如果已經連結核心看板：寫進「最近有紀錄的那一單」的跟進歷程。你預覽時會看到寫進哪一筆。
- 一畝田名單如果還沒連結：寫進這筆名單自己的聯絡紀錄。
- 你指定的是核心看板的某一單：只寫進那一單。
- 下次聯絡日會跟著這個人，同步到連結的名單和每一單。

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
3. 如果規則已經寫成「任何登入的人都能讀寫這棵資料」，就**不要再放寬**。機器人用新帳號登入後就能讀寫。程式本身不會去碰 `fintrack`（財務規劃）。
4. 如果規則只允許你的信箱：在**同樣的條件**旁邊加上機器人的信箱，只開放下面四個位置的讀取、新增、更新，不要開放刪除，也不要新開一條會蓋掉財務規劃的規則：
   - `artifacts/youtrend-crm/public/data/global_state/你的團隊代碼`
   - `artifacts/youtrend-crm/public/data/bot_previews/{文件}`
   - `artifacts/youtrend-crm/public/data/bot_backups/{文件}`
   - `artifacts/youtrend-crm/public/data/bot_audit/{文件}`
5. 按發布。不確定怎麼改時，先不要發布，把畫面上的規則原文存下來再問人。不要整份換成「全部允許」。

### 3. 讓過期的預覽單自動清掉

預覽單 30 分鐘後就不能再確認。請再設自動刪除，雲端才不會一直堆：

1. Firestore →「存留時間」（TTL）。
2. 建立原則。集合群組填 `bot_previews`，欄位填 `expireAt`。
3. 儲存。這個刪除是 Firebase 自己做的，不是機器人呼叫刪除。

### 4. 部署這個新的 Worker

在自己的電腦、這個資料夾裡做。不要部署到舊的 `crm-ai`。

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
