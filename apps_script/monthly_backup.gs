/**
 * 每月把 CRM 與財務規劃備份到 Google 雲端硬碟。
 * 這支程式只讀 Firestore，不會新增、修改或刪除雲端客戶資料。
 * 請勿把密碼寫進這份程式。密碼只放在「指令碼屬性」。
 *
 * 設定步驟（用帳號擁有者的 Google 帳號操作）：
 * 1. 打開 https://script.google.com ，新增專案。
 * 2. 把本檔全部貼上，取代預設的 Code.gs，然後儲存。
 * 3. 左側「專案設定」把時區改成台北（Asia/Taipei）。
 * 4. 同一頁「指令碼屬性」新增這四項（值不要寫進程式）：
 *    FIREBASE_API_KEY ＝ Firebase 專案 fish-teem 的網頁 API 金鑰（與 CRM 頁面相同）
 *    FIREBASE_EMAIL ＝ shanewangmusic@gmail.com
 *    FIREBASE_PASSWORD ＝ 這個 Firebase 登入密碼
 *    TEAM_ID ＝ CRM 的團隊代碼（會自動轉成大寫）
 * 5. 上方函式選 runNow，按執行。第一次會要求授權雲端硬碟，請允許。
 * 6. 到 Google 雲端硬碟確認有資料夾「CRM 備份」，裡面有一份當天的 JSON。
 *    檔案應含 global_state 與 fintrack。Firestore 上的資料不會被這支程式改動。
 * 7. 函式改選 setupTrigger，再執行一次。之後每月 1 日凌晨 3 點自動備份，只留最新 12 份。
 * 8. 不要把這份指令碼分享給其他人。頁面上的「匯出全部備份」可以隨時手動下載同一份內容。
 */

var FIREBASE_PROJECT_ID = 'fish-teem';
var BACKUP_FOLDER_NAME = 'CRM 備份';
var BACKUP_KEEP = 12;

function readConfig_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    apiKey: String(p.getProperty('FIREBASE_API_KEY') || '').trim(),
    email: String(p.getProperty('FIREBASE_EMAIL') || '').trim(),
    password: String(p.getProperty('FIREBASE_PASSWORD') || ''),
    teamId: String(p.getProperty('TEAM_ID') || '').trim().toUpperCase()
  };
  var missing = [];
  if (!cfg.apiKey) missing.push('FIREBASE_API_KEY');
  if (!cfg.email) missing.push('FIREBASE_EMAIL');
  if (!cfg.password) missing.push('FIREBASE_PASSWORD');
  if (!cfg.teamId) missing.push('TEAM_ID');
  if (missing.length) throw new Error('請先在指令碼屬性填寫：' + missing.join('、'));
  return cfg;
}

function allowedHost_(url) {
  var m = String(url || '').match(/^https:\/\/([^\/]+)/);
  return m ? m[1] : '';
}

function fetchJson_(url, options) {
  var host = allowedHost_(url);
  if (host !== 'identitytoolkit.googleapis.com' && host !== 'firestore.googleapis.com') {
    throw new Error('不允許的網址');
  }
  options = options || {};
  var method = String(options.method || 'get').toLowerCase();
  if (host === 'firestore.googleapis.com' && method !== 'get') {
    throw new Error('Firestore 只允許讀取');
  }
  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText() || '';
  var body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (code < 200 || code >= 300) {
    var msg = (body && body.error && (body.error.message || body.error.status)) || ('HTTP ' + code);
    throw new Error(String(msg));
  }
  return body;
}

function signIn_(cfg) {
  var url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(cfg.apiKey);
  var body = fetchJson_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ email: cfg.email, password: cfg.password, returnSecureToken: true }),
    muteHttpExceptions: true
  });
  if (!body.idToken) throw new Error('登入失敗，沒有取得憑證');
  return body.idToken;
}

function decodeFs_(v) {
  if (!v || typeof v !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(v, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(v, 'stringValue')) return v.stringValue;
  if (Object.prototype.hasOwnProperty.call(v, 'booleanValue')) return !!v.booleanValue;
  if (Object.prototype.hasOwnProperty.call(v, 'integerValue')) {
    var n = Number(v.integerValue);
    return isFinite(n) ? n : String(v.integerValue);
  }
  if (Object.prototype.hasOwnProperty.call(v, 'doubleValue')) return Number(v.doubleValue);
  if (Object.prototype.hasOwnProperty.call(v, 'timestampValue')) return v.timestampValue;
  if (Object.prototype.hasOwnProperty.call(v, 'mapValue')) {
    var fields = (v.mapValue && v.mapValue.fields) || {};
    var out = {};
    Object.keys(fields).forEach(function (k) { out[k] = decodeFs_(fields[k]); });
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(v, 'arrayValue')) {
    var values = (v.arrayValue && v.arrayValue.values) || [];
    return values.map(decodeFs_);
  }
  return null;
}

function docToPlain_(doc) {
  var fields = decodeFs_({ mapValue: { fields: (doc && doc.fields) || {} } }) || {};
  var name = String((doc && doc.name) || '');
  var id = name.split('/').pop();
  fields.id = id;
  return fields;
}

function firestoreBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents';
}

function authHeader_(token) {
  return { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
}

function readDocument_(token, path) {
  var body = fetchJson_(firestoreBase_() + path, authHeader_(token));
  if (!body || !body.fields) return null;
  return docToPlain_(body);
}

function listCollection_(token, path) {
  var out = [];
  var pageToken = '';
  do {
    var url = firestoreBase_() + path + '?pageSize=200';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    var body = fetchJson_(url, authHeader_(token));
    var docs = body.documents || [];
    docs.forEach(function (doc) { out.push(docToPlain_(doc)); });
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return out;
}

function stamp_() {
  var tz = 'Asia/Taipei';
  try { tz = Session.getScriptTimeZone() || tz; } catch (e) {}
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd_HHmm');
}

function backupFolder_() {
  var it = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(BACKUP_FOLDER_NAME);
}

function pruneBackups_(folder, keep) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (String(f.getName() || '').indexOf('CRM備份_') === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  var removed = [];
  for (var i = keep; i < files.length; i++) {
    removed.push(files[i].getName());
    files[i].setTrashed(true);
  }
  return removed;
}

function buildBackup_(teamId, globalState, fintrack) {
  return {
    kind: 'crm-fintrack-backup',
    exportedAt: new Date().toISOString(),
    projectId: FIREBASE_PROJECT_ID,
    teamId: teamId,
    global_state: globalState,
    fintrack: fintrack
  };
}

function runNow() {
  var cfg = readConfig_();
  var token = signIn_(cfg);
  var root = '/artifacts/youtrend-crm/public/data/global_state/' + encodeURIComponent(cfg.teamId);
  var globalState = readDocument_(token, root);
  var fintrack = listCollection_(token, root + '/fintrack');
  var payload = buildBackup_(cfg.teamId, globalState, fintrack);
  var folder = backupFolder_();
  var name = 'CRM備份_' + cfg.teamId + '_' + stamp_() + '.json';
  var file = folder.createFile(name, JSON.stringify(payload, null, 2), 'application/json');
  var removed = pruneBackups_(folder, BACKUP_KEEP);
  return { fileName: file.getName(), count: fintrack.length, removed: removed };
}

function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'runNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runNow').timeBased().onMonthDay(1).atHour(3).create();
}
