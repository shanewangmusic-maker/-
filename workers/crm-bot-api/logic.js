// 客戶寫入規則對齊 index.html：
// 一畝田（progress === 'LEAD'）已連結核心單 → 紀錄寫進那一單的 history；
// 未連結 → 寫進這筆名單的 contacts。
// 核心單本身 → 寫進自己的 history。
// 下次聯絡日用 nxtSet：寫到這個人，並同步連結的名單與每一單。

export const CONTACT_METHODS = ['Line', '電話', '面談', '其他'];
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

export function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    if (typeof v.__timestamp === 'string' && Object.keys(v).length === 1) {
      return { __timestamp: v.__timestamp };
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

export function atParse(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return (d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) ? d : null;
}

export function validDate(v) {
  const d = String(v || '').substring(0, 10);
  return atParse(d) ? d : '';
}

export function atValidTime(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v == null ? '' : v).trim());
  if (!m) return '';
  const h = +m[1];
  const mi = +m[2];
  if (h > 23 || mi > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

export function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

export function leadDealIds(L) {
  const s = [];
  if (L && Array.isArray(L.coreIds)) {
    L.coreIds.forEach((id) => { if (id && s.indexOf(id) < 0) s.push(id); });
  }
  if (L && L.coreId && s.indexOf(L.coreId) < 0) s.push(L.coreId);
  return s;
}

export function leadDeals(customers, L) {
  if (!L || L.progress !== 'LEAD') return [];
  const out = [];
  leadDealIds(L).forEach((id) => {
    const C = customers.find((x) => x && x.id === id);
    if (C && C.progress !== 'LEAD' && C.leadId === L.id && out.indexOf(C) < 0) out.push(C);
  });
  return out;
}

export function coreLeadOf(customers, C) {
  if (!C || C.progress === 'LEAD' || !C.leadId) return null;
  const L = customers.find((x) => x && x.id === C.leadId);
  return (L && L.progress === 'LEAD' && leadDealIds(L).indexOf(C.id) >= 0) ? L : null;
}

export function leadDefaultDeal(customers, L) {
  const deals = leadDeals(customers, L);
  if (!deals.length) return null;
  let best = null;
  let bk = '';
  deals.forEach((d, i) => {
    let last = '';
    (Array.isArray(d.history) ? d.history : []).forEach((h) => {
      if (h && !h.sys) {
        const x = validDate(h.date);
        if (x > last) last = x;
      }
    });
    const k = last + '|' + String(d.createdAt || '').substring(0, 19) + '|' + String(i).padStart(4, '0');
    if (!best || k > bk) { best = d; bk = k; }
  });
  return best;
}

export function nxtSet(customers, c, v) {
  c.nextContactDate = v;
  if (customers.indexOf(c) < 0) return;
  const L = c.progress === 'LEAD' ? c : coreLeadOf(customers, c);
  if (!L) return;
  if (L !== c) L.nextContactDate = v;
  leadDeals(customers, L).forEach((d) => { if (d !== c) d.nextContactDate = v; });
}

function presentRecord(rec, store, customerId) {
  const row = {
    id: rec.id || '',
    date: validDate(rec.date) || String(rec.date || '').substring(0, 10),
    method: rec.method ? String(rec.method) : '',
    content: rec.content ? String(rec.content) : '',
    time: atValidTime(rec.time),
    progress: rec.progress ? String(rec.progress) : '',
    store,
    customerId
  };
  const end = validDate(rec.endDate);
  if (end) row.endDate = end;
  if (rec.sys) row.sys = true;
  return row;
}

export function contactRecords(customers, c) {
  const rows = [];
  const pushArr = (arr, store, customerId) => {
    (Array.isArray(arr) ? arr : []).forEach((rec, index) => {
      if (rec && typeof rec === 'object') rows.push({ rec, index, store, customerId });
    });
  };
  if (c.progress === 'LEAD') {
    const deals = leadDeals(customers, c);
    if (deals.length) deals.forEach((d) => pushArr(d.history, 'history', d.id));
    else pushArr(c.contacts, 'contacts', c.id);
  } else {
    pushArr(c.history, 'history', c.id);
  }
  rows.sort((a, b) => {
    const da = validDate(a.rec.date);
    const db = validDate(b.rec.date);
    if (da !== db) return da < db ? 1 : -1;
    const ta = atValidTime(a.rec.time);
    const tb = atValidTime(b.rec.time);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return b.index - a.index;
  });
  return rows.map((row) => presentRecord(row.rec, row.store, row.customerId));
}

export function publicCustomer(customers, c, limit) {
  const all = contactRecords(customers, c);
  const records = limit == null ? all : all.slice(0, limit);
  const progress = c.progress || '';
  return {
    id: c.id,
    name: c.name || '',
    phone: c.phone || '',
    stage: progress,
    progress,
    category: c.category || '',
    nextContactDate: c.nextContactDate || '',
    agentName: c.agentName || '',
    recordCount: all.length,
    records
  };
}

export function matchCustomer(c, nameQ, phoneQ) {
  if (nameQ && !String(c.name || '').toLowerCase().includes(nameQ)) return false;
  if (phoneQ && !digits(c.phone).includes(phoneQ)) return false;
  return true;
}

function cleanCustomerId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 200) return '';
  if (/[\s/\\]/.test(s)) return '';
  return s;
}

export function normalizeOp(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '請提供 JSON 物件' };
  const op = body.op;
  if (op === 'appendContact') {
    const customerId = cleanCustomerId(body.customerId);
    const date = String(body.date || '').trim();
    const method = String(body.method || '').trim();
    const content = String(body.content == null ? '' : body.content).trim();
    const timeRaw = body.time == null || body.time === '' ? '' : String(body.time);
    if (!customerId) return { error: '缺少 customerId' };
    if (!atParse(date)) return { error: '日期格式要是 YYYY-MM-DD' };
    if (CONTACT_METHODS.indexOf(method) < 0) return { error: '聯絡方式只接受 Line、電話、面談、其他' };
    if (!content) return { error: '請填寫聯絡內容' };
    if (content.length > 4000) return { error: '聯絡內容太長' };
    let time = '';
    if (timeRaw) {
      time = atValidTime(timeRaw);
      if (!time) return { error: '時間格式要是 HH:MM' };
    }
    return { op, request: { customerId, date, method, content, time } };
  }
  if (op === 'setNextContact') {
    const customerId = cleanCustomerId(body.customerId);
    const date = body.date == null ? '' : String(body.date).trim();
    if (!customerId) return { error: '缺少 customerId' };
    if (date && !atParse(date)) return { error: '日期格式要是 YYYY-MM-DD' };
    return { op, request: { customerId, date } };
  }
  return { error: '不支援的操作。只接受 appendContact 或 setNextContact' };
}

function applyAppend(customers, request, idSource) {
  const c = customers.find((x) => x && x.id === request.customerId);
  if (!c) return { error: '找不到這位客戶' };
  let target = c;
  let store = 'history';
  if (c.progress === 'LEAD') {
    const deals = leadDeals(customers, c);
    if (deals.length === 1) target = deals[0];
    else if (deals.length > 1) target = leadDefaultDeal(customers, c);
    else store = 'contacts';
  }
  if (!Array.isArray(target[store])) target[store] = [];
  const arr = target[store];
  let record;
  if (store === 'history') {
    const ids = new Set(arr.map((h) => h && h.id));
    let n = idSource.now;
    let hid;
    do { hid = 'h-' + (n++); } while (ids.has(hid));
    record = {
      id: hid,
      date: request.date,
      content: request.content,
      progress: target.progress || '',
      method: request.method
    };
    if (request.time) record.time = request.time;
  } else {
    record = {
      id: 'lc-' + idSource.now + '-' + idSource.suffix,
      date: request.date,
      method: request.method,
      content: request.content
    };
    if (request.time) record.time = request.time;
  }
  arr.push(record);
  const place = store === 'contacts'
    ? '名單聯絡紀錄'
    : (target.id === c.id ? '跟進歷程' : '核心看板的跟進歷程');
  return {
    customers,
    diff: {
      summary: '在「' + (c.name || c.id) + '」的' + place + '新增 ' + request.date + ' ' + request.method + '：' + request.content,
      changes: [{
        kind: 'append',
        store,
        customerId: target.id,
        customerName: target.name || '',
        viaCustomerId: c.id,
        record
      }]
    }
  };
}

function applyNext(customers, request) {
  const c = customers.find((x) => x && x.id === request.customerId);
  if (!c) return { error: '找不到這位客戶' };
  const before = new Map(customers.map((x) => [x.id, x.nextContactDate || '']));
  nxtSet(customers, c, request.date);
  const changes = [];
  customers.forEach((x) => {
    const prev = before.get(x.id) || '';
    const next = x.nextContactDate || '';
    if (prev !== next) {
      changes.push({
        kind: 'set',
        customerId: x.id,
        customerName: x.name || '',
        field: 'nextContactDate',
        before: prev,
        after: next
      });
    }
  });
  if (!changes.length) return { error: '下次聯絡日沒有變化' };
  const when = request.date || '（清空）';
  return {
    customers,
    diff: {
      summary: '把「' + (c.name || c.id) + '」的下次聯絡日改成 ' + when + (changes.length > 1 ? '，並同步 ' + (changes.length - 1) + ' 筆連結資料' : ''),
      changes
    }
  };
}

export function applyOp(doc, op, request, idSource) {
  if (!doc || !Array.isArray(doc.cust)) return { error: '團隊資料裡沒有客戶清單' };
  const customers = clone(doc.cust);
  if (op === 'appendContact') return applyAppend(customers, request, idSource);
  if (op === 'setNextContact') return applyNext(customers, request);
  return { error: '不支援的操作' };
}

export function cloudRev(doc) {
  const n = Number(doc && doc._rev || 0);
  return Number.isFinite(n) ? n : 0;
}

export function withCustomers(doc, customers, nowMs) {
  const out = clone(doc);
  out.cust = customers;
  out._rev = cloudRev(doc) + 1;
  out._updatedAt = nowMs;
  return out;
}

export function backupCopy(doc, meta) {
  const copy = clone(doc);
  copy._backup = meta;
  return copy;
}

export function stable(v) {
  return JSON.stringify(sortValue(v));
}

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

export function expireMillis(preview) {
  const raw = preview && preview.expireAt;
  const iso = raw && typeof raw === 'object' ? raw.__timestamp : raw;
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

export function pathsFor(teamId) {
  const root = 'artifacts/youtrend-crm/public/data';
  return {
    state: root + '/global_state/' + teamId,
    preview: (id) => root + '/bot_previews/' + id,
    backup: (id) => root + '/bot_backups/' + id,
    audit: (id) => root + '/bot_audit/' + id
  };
}

export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a == null ? '' : a));
  const y = enc.encode(String(b == null ? '' : b));
  const n = Math.max(x.length, y.length);
  let out = x.length === y.length ? 0 : 1;
  for (let i = 0; i < n; i++) out |= (x[i] || 0) ^ (y[i] || 0);
  return out === 0;
}

export function envTrim(v) {
  return String(v == null ? '' : v).trim();
}

export function teamIdFrom(env) {
  return envTrim(env && env.TEAM_ID).toUpperCase();
}

export function randomSuffix() {
  const s = Math.random().toString(36).slice(2, 6);
  return (s + 'xxxx').slice(0, 4);
}

export function isPreviewId(id) {
  return /^pv-[0-9]+-[a-z0-9]{4}$/.test(String(id || ''));
}
