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

export function questActOf(v) {
  return (v === 'call' || v === 'appt' || v === 'need') ? v : '';
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
  const full = clone(c);
  full.id = c.id;
  full.name = c.name || '';
  full.phone = c.phone || '';
  full.stage = c.progress || '';
  full.progress = c.progress || '';
  full.category = c.category || '';
  full.nextContactDate = c.nextContactDate || '';
  full.agentName = c.agentName || '';
  full.recordCount = all.length;
  full.records = records;
  return full;
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

// byEmail：只接受設定好的擁有者信箱（預設 shanewangmusic@gmail.com）；act：只接受 call / appt / need
export const DEFAULT_OWNER_EMAIL = 'shanewangmusic@gmail.com';

function stampOf(body, opts) {
  const out = {};
  const owners = (opts && Array.isArray(opts.ownerEmails) && opts.ownerEmails.length ? opts.ownerEmails : [DEFAULT_OWNER_EMAIL])
    .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  if (body.byEmail != null && body.byEmail !== '') {
    const email = String(body.byEmail).trim().toLowerCase();
    if (owners.indexOf(email) < 0) return { error: 'byEmail 只接受擁有者的信箱' };
    out.byEmail = email;
  }
  if (body.act != null && body.act !== '') {
    const act = questActOf(String(body.act).trim());
    if (!act) return { error: 'act 只接受 call（約訪）、appt（取得約會）、need（發掘需求）' };
    out.act = act;
  }
  return { values: out };
}

export function normalizeOp(body, opts) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '請提供 JSON 物件' };
  const op = body.op;
  const stamp = stampOf(body, opts);
  if (stamp.error) return stamp;
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
    return { op, request: Object.assign({ customerId, date, method, content, time }, stamp.values) };
  }
  if (op === 'setNextContact') {
    const customerId = cleanCustomerId(body.customerId);
    const date = body.date == null ? '' : String(body.date).trim();
    if (!customerId) return { error: '缺少 customerId' };
    if (date && !atParse(date)) return { error: '日期格式要是 YYYY-MM-DD' };
    return { op, request: { customerId, date }, scope: 'state' };
  }
  if (op === 'updateCustomer') {
    const customerId = cleanCustomerId(body.customerId);
    const patch = normalizePatch(body.patch);
    if (!customerId) return { error: '缺少 customerId' };
    if (patch.error) return patch;
    return { op, request: Object.assign({ customerId, patch: patch.values }, stamp.values), scope: 'state' };
  }
  if (op === 'createCustomer') {
    const raw = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) ? body.customer : body;
    const patch = normalizePatch(raw, { creating: true });
    if (patch.error) return patch;
    if (!String(patch.values.name || '').trim()) return { error: '請填寫客戶姓名' };
    return { op, request: { customer: patch.values }, scope: 'state' };
  }
  if (op === 'deleteCustomer') {
    const customerId = cleanCustomerId(body.customerId);
    if (!customerId) return { error: '缺少 customerId' };
    return { op, request: { customerId }, scope: 'state' };
  }
  if (op === 'editContact') {
    const customerId = cleanCustomerId(body.customerId);
    const contactId = cleanCustomerId(body.contactId);
    const patch = normalizeContactPatch(body.patch);
    if (!customerId) return { error: '缺少 customerId' };
    if (!contactId) return { error: '缺少 contactId' };
    if (patch.error) return patch;
    return { op, request: { customerId, contactId, patch: patch.values }, scope: 'state' };
  }
  if (op === 'deleteContact') {
    const customerId = cleanCustomerId(body.customerId);
    const contactId = cleanCustomerId(body.contactId);
    if (!customerId) return { error: '缺少 customerId' };
    if (!contactId) return { error: '缺少 contactId' };
    return { op, request: { customerId, contactId }, scope: 'state' };
  }
  if (op === 'createFintrack' || op === 'updateFintrack') {
    const planId = String(body.planId || '').trim();
    if (!isPlanId(planId)) return { error: 'planId 不正確' };
    const built = normalizeFintrack(body, op === 'createFintrack');
    if (built.error) return built;
    return { op, request: Object.assign({ planId }, built.values), scope: 'fintrack' };
  }
  if (op === 'undo') {
    const backupId = String(body.backupId || '').trim();
    if (!isBackupId(backupId)) return { error: 'backupId 不正確' };
    return { op, request: { backupId }, scope: 'undo' };
  }
  return { error: '不支援的操作' };
}

const PROGRESS_VALUES = ['', 'NURTURE', 'FIRST_VISIT', 'KEY_VISIT', 'HOLD', 'LOST', 'LEAD', 'R_CONTACT', 'R_INTERVIEW', 'R_ONBOARD'];
const CATEGORY_VALUES = ['NEW', 'WON', 'RECRUIT'];
const ACRE_VALUES = ['', 'FRUIT', 'GROW', 'SAPLING', 'SEED'];
const FIELD_LABELS = {
  name: '姓名', phone: '電話', company: '公司', notes: '備註', birthday: '生日', agentName: '負責業務',
  source: '來源', region: '地區', acreStage: '一畝田階段', category: '分類', progress: '階段', stage: '階段',
  lastStage: '封存前階段', nextContactDate: '下次聯絡日', createdAt: '建檔日', fintrackId: '財務規劃連結',
  leadId: '所屬名單', coreId: '第一張單', coreIds: '連結的單', tags: '標籤', leadCls: '名單分類', links: '連結',
  birthMonth: '生日月份', sendCalendar: '送月曆', policyName: '保單名稱', insuranceCompany: '保險公司',
  productType: '商品類型', premium: '保費', fyc: 'FYC', commissionRate: '佣金率', rankRate: '職級係數',
  commission: '佣金', deductionDate: '扣款日', deductionFrequency: '扣款頻率', dividendDate: '配息日',
  dividendFrequency: '配息頻率', dealDate: '成交日', submitDate: '送件日', csSupervisor: 'CS 主管',
  plannedPolicyName: '預計保單', plannedInsuranceCompany: '預計保險公司', plannedProductType: '預計商品類型',
  plannedPremium: '預計保費', plannedCommissionRate: '預計佣金率', plannedFyc: '預計 FYC',
  plannedRankRate: '預計職級係數', plannedCommission: '預計佣金', plannedOutline: '預計規劃'
};
const STRING_FIELDS = [
  'name', 'phone', 'company', 'notes', 'birthday', 'agentName', 'source', 'region', 'lastStage',
  'nextContactDate', 'createdAt', 'fintrackId', 'leadId', 'coreId', 'policyName', 'insuranceCompany',
  'productType', 'premium', 'fyc', 'commissionRate', 'rankRate', 'commission', 'deductionDate',
  'deductionFrequency', 'dividendDate', 'dividendFrequency', 'dealDate', 'submitDate', 'csSupervisor',
  'plannedPolicyName', 'plannedInsuranceCompany', 'plannedProductType', 'plannedPremium',
  'plannedCommissionRate', 'plannedFyc', 'plannedRankRate', 'plannedCommission', 'plannedOutline'
];
const DATE_FIELDS = ['birthday', 'nextContactDate', 'deductionDate', 'dividendDate', 'dealDate', 'submitDate'];
const BLOCKED_FIELDS = { id: 1, history: 1, contacts: 1 };

function showVal(v) {
  if (v == null || v === '') return '（空）';
  if (typeof v === 'string') return '「' + v + '」';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.length ? v.map(showVal).join('、') : '（空）';
  return JSON.stringify(v);
}

function diffText(diff, before, after) {
  diff.text = '修改前：' + before + '\n修改後：' + after;
  return diff;
}

function moneyString(v) {
  return String(v == null ? '' : v).replace(/,/g, '').trim();
}

function stringList(v, label) {
  if (!Array.isArray(v)) return { error: label + '要是文字陣列' };
  if (v.length > 40) return { error: label + '太多' };
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const s = String(v[i] == null ? '' : v[i]).trim();
    if (!s || s.length > 80) return { error: label + '裡有空白或過長的項目' };
    out.push(s);
  }
  return { values: out };
}

export function normalizePatch(patch, opts) {
  const creating = opts && opts.creating;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: '請提供要修改的欄位' };
  const values = {};
  const keys = Object.keys(patch).filter((k) => ['op', 'customer', 'customerId', 'byEmail', 'act'].indexOf(k) < 0);
  if (!keys.length) return { error: '沒有要修改的欄位' };
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const raw = patch[key];
    if (BLOCKED_FIELDS[key]) return { error: '不能直接改 ' + key + '。聯絡紀錄請用 editContact 或 deleteContact' };
    if (key === 'stage' || key === 'progress') {
      let progress = String(raw == null ? '' : raw).trim();
      if (progress === 'WON') {
        if (values.category != null && values.category !== 'WON') return { error: '階段成交和分類不一致' };
        values.category = 'WON';
        progress = '';
      }
      if (PROGRESS_VALUES.indexOf(progress) < 0) return { error: '階段不是 CRM 有的值' };
      if (values.progress != null && values.progress !== progress) return { error: 'stage 和 progress 不一致' };
      values.progress = progress;
      continue;
    }
    if (key === 'category') {
      const category = String(raw || '').trim();
      if (CATEGORY_VALUES.indexOf(category) < 0) return { error: '分類只接受 NEW、WON、RECRUIT' };
      if (values.category != null && values.category !== category) return { error: '階段成交和分類不一致' };
      values.category = category;
      continue;
    }
    if (key === 'acreStage') {
      const stage = String(raw == null ? '' : raw).trim();
      if (ACRE_VALUES.indexOf(stage) < 0) return { error: '一畝田階段只接受 FRUIT、GROW、SAPLING、SEED' };
      values.acreStage = stage;
      continue;
    }
    if (key === 'birthMonth') {
      if (raw == null || raw === '') { values.birthMonth = null; continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 12) return { error: '生日月份要是 1 到 12' };
      values.birthMonth = n;
      continue;
    }
    if (key === 'sendCalendar') {
      values.sendCalendar = !!raw;
      continue;
    }
    if (key === 'tags' || key === 'leadCls' || key === 'coreIds') {
      const list = stringList(raw, FIELD_LABELS[key] || key);
      if (list.error) return list;
      values[key] = list.values;
      continue;
    }
    if (key === 'links') {
      if (!Array.isArray(raw)) return { error: '連結要是陣列' };
      const links = [];
      for (let j = 0; j < raw.length; j++) {
        const item = raw[j] || {};
        let url = String(item.url || '').trim();
        const name = String(item.name || '').trim();
        if (!url) return { error: '連結缺少網址' };
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        links.push({ name: name || url, url });
      }
      values.links = links;
      continue;
    }
    if (STRING_FIELDS.indexOf(key) < 0) return { error: 'CRM 沒有這個欄位：' + key };
    if (raw != null && typeof raw === 'object') return { error: FIELD_LABELS[key] + '要是文字' };
    let text = String(raw == null ? '' : raw).trim();
    if (DATE_FIELDS.indexOf(key) >= 0 && text && !atParse(text)) return { error: FIELD_LABELS[key] + '格式要是 YYYY-MM-DD' };
    if (key === 'createdAt' && text && !atParse(text.substring(0, 10))) return { error: '建檔日格式不正確' };
    if (['premium', 'fyc', 'commission', 'plannedPremium', 'plannedFyc', 'plannedCommission'].indexOf(key) >= 0) text = moneyString(text);
    if (text.length > 4000) return { error: (FIELD_LABELS[key] || key) + '太長' };
    values[key] = text;
  }
  if (!creating && values.name != null && !String(values.name).trim()) return { error: '姓名不能改成空白' };
  return { values };
}

function normalizeContactPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: '請提供要修改的紀錄欄位' };
  const values = {};
  const keys = Object.keys(patch);
  if (!keys.length) return { error: '沒有要修改的紀錄欄位' };
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (['date', 'method', 'content', 'time', 'endDate'].indexOf(key) < 0) return { error: '聯絡紀錄不能改 ' + key };
    if (key === 'date' || key === 'endDate') {
      const date = String(patch[key] == null ? '' : patch[key]).trim();
      if (key === 'date' && !atParse(date)) return { error: '日期格式要是 YYYY-MM-DD' };
      if (key === 'endDate' && date && !atParse(date)) return { error: '結束日格式要是 YYYY-MM-DD' };
      values[key] = date;
    } else if (key === 'method') {
      const method = String(patch[key] || '').trim();
      if (CONTACT_METHODS.indexOf(method) < 0) return { error: '聯絡方式只接受 Line、電話、面談、其他' };
      values.method = method;
    } else if (key === 'time') {
      const time = patch[key] == null || patch[key] === '' ? '' : atValidTime(patch[key]);
      if (patch[key] && !time) return { error: '時間格式要是 HH:MM' };
      values.time = time;
    } else {
      const content = String(patch[key] == null ? '' : patch[key]).trim();
      if (!content) return { error: '聯絡內容不能改成空白' };
      if (content.length > 4000) return { error: '聯絡內容太長' };
      values.content = content;
    }
  }
  return { values };
}

function normalizeFintrack(body, creating) {
  const values = {};
  if (body.snap != null) {
    if (!body.snap || typeof body.snap !== 'object' || Array.isArray(body.snap)) return { error: 'snap 要是一個物件' };
    values.snap = clone(body.snap);
  } else if (creating) {
    values.snap = { client: { name: '', birth: '', job: '', note: '' } };
  }
  ['clientName', 'clientBirthday', 'agentName', 'lastReviewDate', 'nextReviewDate'].forEach((key) => {
    if (body[key] == null) return;
    const text = String(body[key]).trim();
    if ((key === 'clientBirthday' || key === 'lastReviewDate' || key === 'nextReviewDate') && text && !atParse(text)) {
      return;
    }
    values[key] = text;
  });
  if (body.clientBirthday != null && values.clientBirthday == null && String(body.clientBirthday).trim()) return { error: '生日格式要是 YYYY-MM-DD' };
  if (body.lastReviewDate != null && values.lastReviewDate == null && String(body.lastReviewDate).trim()) return { error: '上次檢視日格式要是 YYYY-MM-DD' };
  if (body.nextReviewDate != null && values.nextReviewDate == null && String(body.nextReviewDate).trim()) return { error: '下次檢視日格式要是 YYYY-MM-DD' };
  if (!creating && values.snap == null && !Object.keys(values).length) return { error: '沒有要修改的財務規劃欄位' };
  return { values };
}

function locateContact(customers, customerId, contactId) {
  const c = customers.find((x) => x && x.id === customerId);
  if (!c) return { error: '找不到這位客戶' };
  const found = [];
  const consider = (arr, store, owner) => {
    if (!Array.isArray(arr)) return;
    const index = arr.findIndex((row) => row && row.id === contactId);
    if (index >= 0) found.push({ arr, index, store, owner });
  };
  if (c.progress === 'LEAD' && leadDeals(customers, c).length) {
    leadDeals(customers, c).forEach((deal) => consider(deal.history, 'history', deal));
  } else if (c.progress === 'LEAD') {
    consider(c.contacts, 'contacts', c);
  } else {
    consider(c.history, 'history', c);
  }
  if (!found.length) return { error: '找不到這筆聯絡紀錄' };
  return { hit: found[0], customer: c };
}

// ---- 階段變更：照網頁 index.html 的規則（aqLogStageEdit、handleAddHistory、quickAdvance、handleQuickWon）----
const ACTIVE_STAGES = ['NURTURE', 'FIRST_VISIT', 'KEY_VISIT', 'R_CONTACT', 'R_INTERVIEW', 'R_ONBOARD'];
const PLANNED_FIELDS = ['csSupervisor', 'plannedPolicyName', 'plannedInsuranceCompany', 'plannedProductType', 'plannedPremium',
  'plannedCommissionRate', 'plannedFyc', 'plannedRankRate', 'plannedCommission', 'plannedOutline'];
const STAGE_LABELS = { HOLD: '待定', LOST: '流失', LEAD: '名單', NURTURE: '經營', FIRST_VISIT: '初訪', KEY_VISIT: '關鍵訪', R_CONTACT: '接觸/咖啡', R_INTERVIEW: '主管面談', R_ONBOARD: '考照/報聘' };

export function stageLabel(cat, prog) {
  if (cat === 'WON') return '成交';
  return STAGE_LABELS[prog] || prog || '未標';
}

export function effectiveStage(c) {
  return c && c.category === 'WON' ? 'WON' : ((c && c.progress) || '');
}

// 台灣日期（UTC+8，沒有日光節約）
export function twDate(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().substring(0, 10);
}

export function nextHistoryId(arr, start) {
  const ids = new Set((Array.isArray(arr) ? arr : []).map((h) => h && h.id));
  let n = Number(start);
  let hid;
  do { hid = 'h-' + (n++); } while (ids.has(hid));
  return hid;
}

function setTracked(c, key, value, changes) {
  const before = c[key] == null ? '' : clone(c[key]);
  if (stable(before) === stable(value)) return;
  c[key] = clone(value);
  changes.push({ kind: 'set', customerId: c.id, customerName: c.name || '', field: key, before, after: clone(value) });
}

// 在一般欄位改完之後呼叫；只在「實際階段」變了才動作
function stageSideEffects(customers, c, patch, prev, request, idSource, changes) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  // 沒給分類時，依新階段補上網頁會用的分類
  if (has('progress') && !has('category')) {
    const p = c.progress;
    if (p === 'HOLD' || p === 'LOST' || p === 'LEAD') setTracked(c, 'category', 'NEW', changes);
    else if (/^R_/.test(p)) setTracked(c, 'category', 'RECRUIT', changes);
    else if (p && prev.cat !== 'NEW') setTracked(c, 'category', 'NEW', changes);
  }
  const before = prev.cat === 'WON' ? 'WON' : (prev.prog || '');
  if (c.category === 'WON' && c.progress) setTracked(c, 'progress', '', changes);   // 成交：progress 一律清空
  const after = effectiveStage(c);
  if (before === after) return { changed: false };
  if (after === 'WON' && !has('nextContactDate')) {
    const beforeMap = new Map(customers.map((row) => [row.id, row.nextContactDate || '']));
    nxtSet(customers, c, '');
    customers.forEach((row) => {
      const p = beforeMap.get(row.id) || '';
      const n = row.nextContactDate || '';
      if (p !== n) changes.push({ kind: 'set', customerId: row.id, customerName: row.name || '', field: 'nextContactDate', before: p, after: n });
    });
  }
  if ((after === 'HOLD' || after === 'LOST') && ACTIVE_STAGES.indexOf(prev.prog) >= 0 && !has('lastStage')) {
    setTracked(c, 'lastStage', prev.prog, changes);
  }
  if (after !== 'KEY_VISIT') {
    PLANNED_FIELDS.forEach((k) => { if (!has(k) && c[k] != null && c[k] !== '') setTracked(c, k, '', changes); });
  }
  c.history = Array.isArray(c.history) ? c.history : [];
  const row = {
    id: nextHistoryId(c.history, idSource.now),
    date: twDate(idSource.now),
    content: '階段由「' + stageLabel(prev.cat, prev.prog) + '」改為「' + stageLabel(c.category, c.progress) + '」',
    progress: after === 'WON' ? 'WON' : (c.progress || '')
  };
  if (request.byEmail) row.byEmail = request.byEmail;
  if (request.act) row.act = request.act;
  c.history.push(row);
  changes.push({ kind: 'append', store: 'history', customerId: c.id, customerName: c.name || '', record: clone(row) });
  return { changed: true, row, before, after };
}

function applyUpdateCustomer(customers, request, idSource) {
  const c = customers.find((x) => x && x.id === request.customerId);
  if (!c) return { error: '找不到這位客戶' };
  const patch = request.patch;
  const changes = [];
  const prev = { cat: c.category || '', prog: c.progress || '' };
  if (Object.prototype.hasOwnProperty.call(patch, 'progress') && (prev.prog === 'LEAD') !== (patch.progress === 'LEAD')) {
    return { error: '一畝田名單和核心客戶之間的轉換要搬聯絡紀錄和連結，請在 CRM 網頁操作' };
  }
  const keys = Object.keys(patch);
  keys.forEach((key) => {
    if (key === 'nextContactDate') return;
    const before = c[key] == null ? '' : clone(c[key]);
    if (patch[key] === null) {
      if (c[key] != null) {
        delete c[key];
        changes.push({ kind: 'set', customerId: c.id, customerName: c.name || '', field: key, before, after: '' });
      }
      return;
    }
    if (stable(before) === stable(patch[key])) return;
    c[key] = clone(patch[key]);
    changes.push({ kind: 'set', customerId: c.id, customerName: c.name || '', field: key, before, after: clone(c[key]) });
  });
  const stage = stageSideEffects(customers, c, patch, prev, request, idSource, changes);
  if (Object.prototype.hasOwnProperty.call(patch, 'nextContactDate')) {
    const beforeMap = new Map(customers.map((row) => [row.id, row.nextContactDate || '']));
    nxtSet(customers, c, patch.nextContactDate);
    customers.forEach((row) => {
      const prev = beforeMap.get(row.id) || '';
      const next = row.nextContactDate || '';
      if (prev !== next) changes.push({ kind: 'set', customerId: row.id, customerName: row.name || '', field: 'nextContactDate', before: prev, after: next });
    });
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'name') && c.progress === 'LEAD') {
    leadDeals(customers, c).forEach((deal) => {
      if ((deal.name || '') !== c.name) {
        const before = deal.name || '';
        deal.name = c.name;
        changes.push({ kind: 'set', customerId: deal.id, customerName: c.name, field: 'name', before, after: c.name });
      }
    });
  }
  if (!changes.length) return { error: '沒有需要變更的內容' };
  const sets = changes.filter((row) => row.kind === 'set');
  const added = changes.filter((row) => row.kind === 'append').map((row) => '新增歷程「' + row.record.content + '」');
  const beforeText = sets.map((row) => (FIELD_LABELS[row.field] || row.field) + showVal(row.before)).join('、') || '（無）';
  const afterText = sets.map((row) => (FIELD_LABELS[row.field] || row.field) + showVal(row.after)).concat(added).join('、');
  return {
    questRows: stage.changed ? [{ customerId: c.id, rowId: stage.row.id, opt: { changed: true, stageFrom: stage.before, stageTo: stage.after, dealDate: c.dealDate || '' } }] : [],
    customers,
    diff: diffText({
      summary: '修改「' + (c.name || c.id) + '」的資料',
      changes
    }, beforeText, afterText)
  };
}

function applyCreateCustomer(customers, request, idSource) {
  const patch = request.customer;
  let id = 'cust-' + idSource.now;
  if (customers.some((row) => row && row.id === id)) id += '-' + idSource.suffix;
  const customer = {
    id,
    name: patch.name,
    phone: patch.phone || '',
    company: patch.company || '',
    notes: patch.notes || '',
    birthday: patch.birthday || '',
    agentName: patch.agentName || '',
    category: patch.category || (patch.progress === 'LEAD' ? 'NEW' : 'NEW'),
    progress: patch.progress != null ? patch.progress : 'NURTURE',
    tags: patch.tags ? patch.tags.slice() : [],
    createdAt: patch.createdAt || new Date(idSource.now).toISOString(),
    history: [],
    lastStage: patch.lastStage || 'NURTURE',
    nextContactDate: patch.nextContactDate || ''
  };
  if (customer.category === 'WON') customer.progress = patch.progress != null ? patch.progress : '';
  if (customer.progress === 'LEAD' || customer.progress === 'HOLD' || customer.progress === 'LOST') customer.category = 'NEW';
  Object.keys(patch).forEach((key) => {
    if (customer[key] == null || ['phone', 'company', 'notes', 'birthday', 'agentName', 'tags', 'nextContactDate', 'lastStage', 'category', 'progress', 'name', 'createdAt'].indexOf(key) < 0) {
      if (patch[key] !== null) customer[key] = clone(patch[key]);
    }
  });
  customers.push(customer);
  return {
    customers,
    diff: diffText({
      summary: '新增客戶「' + customer.name + '」',
      changes: [{ kind: 'create', customerId: customer.id, customerName: customer.name, after: { id: customer.id, name: customer.name, progress: customer.progress, category: customer.category } }]
    }, '沒有這位客戶。', '新增「' + customer.name + '」，階段 ' + (customer.progress || '（空）') + '。')
  };
}

function copyHistoryToLead(deal, lead, idSource) {
  const have = new Set((Array.isArray(lead.contacts) ? lead.contacts : []).map((row) => row && row.id));
  let n = 0;
  let seq = idSource.now;
  (Array.isArray(deal.history) ? deal.history : []).forEach((h) => {
    if (!h || typeof h !== 'object' || h.sys) return;
    const date = validDate(h.date);
    if (!date) return;
    let cid = h.srcContactId || ('lc-' + (String(h.id || '').replace(/\D/g, '') || String(seq++)));
    if (have.has(cid)) cid = 'lc-' + (seq++) + '-' + idSource.suffix;
    have.add(cid);
    const ct = { id: cid, date, content: String(h.content || '') };
    if (h.method) ct.method = String(h.method);
    const end = validDate(h.endDate);
    if (end && end > date) ct.endDate = end;
    if (atValidTime(h.time)) ct.time = atValidTime(h.time);
    // 和網頁 leadCarryContacts 一樣保留這些選填欄位
    if (atValidTime(h.time) && atValidTime(h.endTime)) ct.endTime = atValidTime(h.endTime);
    if (h.byEmail) ct.byEmail = String(h.byEmail);
    if (questActOf(h.act)) ct.act = questActOf(h.act);
    if (h.cat) ct.cat = String(h.cat);
    if (h.visitType) ct.visitType = String(h.visitType);
    if (h.by) ct.by = String(h.by);
    if (h.src) ct.src = String(h.src);
    if (!Array.isArray(lead.contacts)) lead.contacts = [];
    lead.contacts.push(ct);
    n++;
  });
  return n;
}

function applyDeleteCustomer(customers, request, idSource) {
  const victim = customers.find((x) => x && x.id === request.customerId);
  if (!victim) return { error: '找不到這位客戶' };
  const name = victim.name || victim.id;
  const notes = [];
  if (victim.progress === 'LEAD') {
    leadDeals(customers, victim).forEach((deal) => {
      delete deal.leadId;
      notes.push('核心單「' + (deal.name || deal.id) + '」會留下，只解除和這筆名單的連結。');
    });
  } else {
    const lead = coreLeadOf(customers, victim);
    if (lead) {
      const others = leadDeals(customers, lead).filter((deal) => deal !== victim);
      const ids = others.map((deal) => deal.id);
      if (ids.length) { lead.coreIds = ids; lead.coreId = ids[0]; }
      else { delete lead.coreIds; delete lead.coreId; }
      delete victim.leadId;
      if (!others.length) {
        const n = copyHistoryToLead(victim, lead, idSource);
        if (validDate(victim.nextContactDate)) lead.nextContactDate = victim.nextContactDate;
        notes.push('一畝田的「' + (lead.name || lead.id) + '」會留下' + (n ? '，並帶回 ' + n + ' 筆聯絡紀錄' : '') + '。');
      } else {
        notes.push('只刪這一單，一畝田和其他 ' + others.length + ' 單會留下。');
      }
    }
  }
  const next = customers.filter((row) => row !== victim);
  const warning = '即將刪除：客戶「' + name + '」。刪除後 CRM 畫面上不會再看到這一位。' + (notes.length ? notes.join('') : '');
  return {
    customers: next,
    diff: {
      warning,
      summary: '刪除客戶「' + name + '」',
      text: '修改前：客戶「' + name + '」還在名單裡。\n修改後：客戶「' + name + '」會被刪除。' + (notes.length ? '\n' + notes.join('') : ''),
      changes: [{ kind: 'delete', customerId: victim.id, customerName: name, before: { id: victim.id, name, progress: victim.progress || '', category: victim.category || '' }, after: null, notes }]
    }
  };
}

function contactLine(rec) {
  return [validDate(rec.date) || String(rec.date || ''), rec.method || '', rec.content || ''].filter(Boolean).join(' ');
}

function applyEditContact(customers, request) {
  const located = locateContact(customers, request.customerId, request.contactId);
  if (located.error) return located;
  const rec = located.hit.arr[located.hit.index];
  const lineOf = (row) => contactLine(row) + (atValidTime(row.time) ? ' ' + atValidTime(row.time) + (atValidTime(row.endTime) ? '-' + atValidTime(row.endTime) : '') : '') + (validDate(row.endDate) ? ' ~ ' + validDate(row.endDate) : '');
  const before = lineOf(rec);
  const patch = request.patch;
  if (patch.date) rec.date = patch.date;
  if (patch.method) rec.method = patch.method;
  if (patch.content) rec.content = patch.content;
  if (Object.prototype.hasOwnProperty.call(patch, 'time')) {
    if (patch.time) rec.time = patch.time;
    else { delete rec.time; delete rec.endTime; }   // 沒有開始時間，結束時間也沒有意義（網頁同樣只在有 time 時才讀 endTime）
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'endDate')) {
    if (patch.endDate && patch.endDate > (rec.date || '')) rec.endDate = patch.endDate;
    else delete rec.endDate;
  }
  const after = lineOf(rec);
  if (before === after) return { error: '這筆聯絡紀錄沒有變化' };
  const who = located.customer.name || located.customer.id;
  return {
    customers,
    diff: diffText({
      summary: '修改「' + who + '」的一筆聯絡紀錄',
      changes: [{ kind: 'edit', store: located.hit.store, customerId: located.hit.owner.id, contactId: rec.id, before, after }]
    }, before, after)
  };
}

function applyDeleteContact(customers, request) {
  const located = locateContact(customers, request.customerId, request.contactId);
  if (located.error) return located;
  const rec = located.hit.arr[located.hit.index];
  const line = contactLine(rec);
  located.hit.arr.splice(located.hit.index, 1);
  const who = located.customer.name || located.customer.id;
  const warning = '即將刪除：「' + who + '」的一筆聯絡紀錄（' + line + '）。客戶本身會留下。';
  return {
    customers,
    diff: {
      warning,
      summary: '刪除「' + who + '」的一筆聯絡紀錄',
      text: '修改前：' + line + '\n修改後：這筆聯絡紀錄會被刪除。',
      changes: [{ kind: 'delete', store: located.hit.store, customerId: located.hit.owner.id, contactId: request.contactId, before: line, after: null }]
    }
  };
}

function fintrackRev(doc) {
  const n = Number(doc && (doc.rev != null ? doc.rev : doc._rev) || 0);
  return Number.isFinite(n) ? n : 0;
}

function assertNoNestedArrays(value, inArray) {
  if (value == null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    if (inArray) return '財務規劃裡有雙層陣列，無法直接存進 Firestore';
    for (let i = 0; i < value.length; i++) {
      const err = assertNoNestedArrays(value[i], true);
      if (err) return err;
    }
    return null;
  }
  if (typeof value.__timestamp === 'string' && Object.keys(value).length === 1) return null;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const err = assertNoNestedArrays(value[keys[i]], false);
    if (err) return err;
  }
  return null;
}

export function packFintrack(doc) {
  const cloned = clone(doc);
  if (cloned.snap && typeof cloned.snap === 'object') {
    cloned.snapJson = JSON.stringify(cloned.snap);
    delete cloned.snap;
  }
  const err = assertNoNestedArrays(cloned, false);
  if (err) return { error: err };
  return { doc: cloned };
}

export function unpackFintrack(doc) {
  if (!doc) return null;
  const out = clone(doc);
  if (typeof out.snapJson === 'string' && out.snapJson) {
    try { out.snap = JSON.parse(out.snapJson); } catch (_) { out.snap = null; }
  }
  return out;
}

function applyFintrackPatch(existing, request, teamId, creating) {
  if (creating && existing) return { error: '這個財務規劃已經存在' };
  if (!creating && !existing) return { error: '找不到這份財務規劃' };
  const base = creating ? {
    clientId: request.planId,
    teamId: teamId,
    agentName: '',
    clientName: '',
    clientBirthday: '',
    lastReviewDate: '',
    nextReviewDate: '',
    sessionId: 'crm-bot',
    rev: 0
  } : clone(existing);
  const beforeSnap = typeof base.snapJson === 'string' ? base.snapJson : '';
  const changes = [];
  ['clientName', 'clientBirthday', 'agentName', 'lastReviewDate', 'nextReviewDate'].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(request, key)) return;
    const prev = base[key] || '';
    if (prev === request[key]) return;
    base[key] = request[key];
    changes.push({ kind: 'set', field: key, before: prev, after: request[key] });
  });
  if (request.snap) {
    const packed = JSON.stringify(request.snap);
    if (packed !== beforeSnap) {
      base.snapJson = packed;
      delete base.snap;
      changes.push({ kind: 'set', field: 'snap', before: beforeSnap ? '（已有計畫內容）' : '（空）', after: '（新的計畫內容）' });
    }
  }
  if (!creating && !changes.length) return { error: '財務規劃沒有變化' };
  const packed = packFintrack(base);
  if (packed.error) return packed;
  const who = packed.doc.clientName || request.planId;
  const beforeText = creating ? '還沒有這份財務規劃。' : (changes.map((row) => (row.field === 'snap' ? '計畫內容' : row.field) + showVal(row.before)).join('、') || '原內容');
  const afterText = creating ? '建立「' + who + '」的財務規劃。' : changes.map((row) => (row.field === 'snap' ? '計畫內容' : row.field) + showVal(row.after)).join('、');
  return {
    doc: packed.doc,
    baseRev: creating ? 0 : fintrackRev(existing),
    diff: diffText({
      summary: (creating ? '建立' : '修改') + '財務規劃「' + who + '」',
      changes: changes.length ? changes : [{ kind: 'create', planId: request.planId, after: who }]
    }, beforeText, afterText)
  };
}

export function planFintrack(existing, request, teamId, creating) {
  const applied = applyFintrackPatch(existing, request, teamId, creating);
  if (applied.error) return applied;
  applied.target = 'fintrack';
  applied.planId = request.planId;
  return applied;
}

// ---- 還原：只有「這次寫入之後沒人再改過」才整份放回；否則只反轉這一次的變更 ----
const ROW_STORES = ['history', 'contacts'];
const DOC_SKIP = { cust: 1, _rev: 1, _updatedAt: 1, _backup: 1 };

function hasKey(o, k) {
  return !!o && Object.prototype.hasOwnProperty.call(o, k);
}

function rowsById(arr) {
  if (!Array.isArray(arr)) return null;
  const m = new Map();
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i];
    if (!r || typeof r !== 'object' || !r.id || m.has(r.id)) return null;
    m.set(r.id, { row: r, index: i });
  }
  return m;
}

function fieldEntry(t, id, key, b, a) {
  const e = { t, key, hasBefore: hasKey(b, key), before: hasKey(b, key) ? clone(b[key]) : null, hasAfter: hasKey(a, key), after: hasKey(a, key) ? clone(a[key]) : null };
  if (id) e.id = id;
  return e;
}

// 比對寫入前後，列出每一個被改到的地方（客戶、欄位、單筆紀錄）
export function changeSetOf(beforeDoc, afterDoc) {
  const out = [];
  const bc = Array.isArray(beforeDoc && beforeDoc.cust) ? beforeDoc.cust : [];
  const ac = Array.isArray(afterDoc && afterDoc.cust) ? afterDoc.cust : [];
  const bm = new Map();
  bc.forEach((c, i) => { if (c && c.id) bm.set(c.id, { c, i }); });
  const am = new Map();
  ac.forEach((c, i) => { if (c && c.id) am.set(c.id, { c, i }); });
  bc.forEach((c, i) => {
    if (c && c.id && !am.has(c.id)) out.push({ t: 'cust-del', id: c.id, index: i, before: clone(c) });
  });
  ac.forEach((c) => {
    if (!c || !c.id) return;
    const prev = bm.get(c.id);
    if (!prev) { out.push({ t: 'cust-add', id: c.id, after: clone(c) }); return; }
    const b = prev.c;
    const keys = [];
    Object.keys(b).concat(Object.keys(c)).forEach((k) => { if (keys.indexOf(k) < 0) keys.push(k); });
    keys.forEach((k) => {
      const hb = hasKey(b, k);
      const ha = hasKey(c, k);
      if (hb && ha && stable(b[k]) === stable(c[k])) return;
      if (ROW_STORES.indexOf(k) >= 0) {
        const rb = rowsById(hb ? b[k] : []);
        const ra = rowsById(ha ? c[k] : []);
        if (rb && ra) {
          rb.forEach((v, rid) => {
            if (!ra.has(rid)) out.push({ t: 'row-del', id: c.id, store: k, rowId: rid, index: v.index, before: clone(v.row) });
          });
          ra.forEach((v, rid) => {
            const old = rb.get(rid);
            if (!old) out.push({ t: 'row-add', id: c.id, store: k, rowId: rid, after: clone(v.row) });
            else if (stable(old.row) !== stable(v.row)) out.push({ t: 'row-edit', id: c.id, store: k, rowId: rid, before: clone(old.row), after: clone(v.row) });
          });
          if (!hb && ha && !c[k].length) out.push(fieldEntry('field', c.id, k, b, c));
          return;
        }
      }
      out.push(fieldEntry('field', c.id, k, b, c));
    });
  });
  const dk = [];
  Object.keys(beforeDoc || {}).concat(Object.keys(afterDoc || {})).forEach((k) => { if (!DOC_SKIP[k] && dk.indexOf(k) < 0) dk.push(k); });
  dk.forEach((k) => {
    const hb = hasKey(beforeDoc, k);
    const ha = hasKey(afterDoc, k);
    if (hb && ha && stable(beforeDoc[k]) === stable(afterDoc[k])) return;
    out.push(fieldEntry('doc', '', k, beforeDoc, afterDoc));
  });
  return out;
}

function sameSlot(obj, has, value, key) {
  if (hasKey(obj, key) !== has) return false;
  return !has || stable(obj[key]) === stable(value);
}

function rowText(row) {
  if (!row) return '';
  return contactLine(row) + (atValidTime(row.time) ? ' ' + atValidTime(row.time) : '');
}

// 把一份變更清單反向套到「現在的資料」上；被別人改過的地方不碰，回報衝突
export function reverseChangeSet(currentDoc, set) {
  const customers = clone(Array.isArray(currentDoc && currentDoc.cust) ? currentDoc.cust : []);
  const docPatch = {};
  const conflicts = [];
  const lines = [];
  const changes = [];
  const find = (id) => customers.find((c) => c && c.id === id);
  const nameOf = (id, fallback) => {
    const c = find(id);
    return (c && c.name) || (fallback && fallback.name) || id;
  };
  const list = Array.isArray(set) ? set : [];
  const reinserts = [];
  list.forEach((e) => {
    if (!e || !e.t) return;
    if (e.t === 'cust-add') {
      const c = find(e.id);
      const who = (e.after && e.after.name) || e.id;
      if (!c) { lines.push('客戶「' + who + '」已經不在，不用再刪'); return; }
      if (stable(c) !== stable(e.after)) { conflicts.push('客戶「' + who + '」新增之後又被修改過'); return; }
      customers.splice(customers.indexOf(c), 1);
      lines.push('刪除這次新增的客戶「' + who + '」');
      changes.push({ kind: 'remove-customer', customerId: e.id });
      return;
    }
    if (e.t === 'cust-del') {
      reinserts.push(e);
      return;
    }
    if (e.t === 'doc') {
      if (sameSlot(currentDoc || {}, e.hasBefore, e.before, e.key)) return;
      if (!sameSlot(currentDoc || {}, e.hasAfter, e.after, e.key)) { conflicts.push('整本資料的「' + e.key + '」之後又被修改過'); return; }
      docPatch[e.key] = e.hasBefore ? { set: clone(e.before) } : { remove: true };
      lines.push('整本資料的「' + e.key + '」改回原值');
      changes.push({ kind: 'restore-doc-field', field: e.key });
      return;
    }
    const c = find(e.id);
    if (!c) { conflicts.push('客戶「' + e.id + '」已經不在'); return; }
    const who = c.name || c.id;
    if (e.t === 'field') {
      if (sameSlot(c, e.hasBefore, e.before, e.key)) return;
      if (!sameSlot(c, e.hasAfter, e.after, e.key)) { conflicts.push('「' + who + '」的' + (FIELD_LABELS[e.key] || e.key) + '之後又被修改過'); return; }
      const now = hasKey(c, e.key) ? clone(c[e.key]) : '';
      if (e.hasBefore) c[e.key] = clone(e.before); else delete c[e.key];
      lines.push('「' + who + '」的' + (FIELD_LABELS[e.key] || e.key) + '：' + showVal(now) + ' → ' + showVal(e.hasBefore ? e.before : ''));
      changes.push({ kind: 'restore-field', customerId: c.id, field: e.key, before: now, after: e.hasBefore ? clone(e.before) : '' });
      return;
    }
    const arr = Array.isArray(c[e.store]) ? c[e.store] : null;
    const idx = arr ? arr.findIndex((r) => r && r.id === e.rowId) : -1;
    if (e.t === 'row-add') {
      if (idx < 0) { lines.push('「' + who + '」那一筆紀錄已經不在，不用再刪'); return; }
      if (stable(arr[idx]) !== stable(e.after)) { conflicts.push('「' + who + '」這次新增的紀錄（' + rowText(e.after) + '）之後又被修改過'); return; }
      arr.splice(idx, 1);
      lines.push('刪除「' + who + '」這次新增的紀錄：' + rowText(e.after));
      changes.push({ kind: 'remove-row', customerId: c.id, store: e.store, contactId: e.rowId });
      return;
    }
    if (e.t === 'row-edit') {
      if (idx < 0) { conflicts.push('「' + who + '」這次修改的紀錄已經被刪除'); return; }
      if (stable(arr[idx]) === stable(e.before)) return;
      if (stable(arr[idx]) !== stable(e.after)) { conflicts.push('「' + who + '」這次修改的紀錄（' + rowText(e.after) + '）之後又被修改過'); return; }
      arr[idx] = clone(e.before);
      lines.push('「' + who + '」的紀錄改回：' + rowText(e.before) + '（原本是：' + rowText(e.after) + '）');
      changes.push({ kind: 'restore-row', customerId: c.id, store: e.store, contactId: e.rowId });
      return;
    }
    if (e.t === 'row-del') {
      if (idx >= 0) {
        if (stable(arr[idx]) !== stable(e.before)) conflicts.push('「' + who + '」這次刪除的紀錄已經用同一個編號重新出現');
        return;
      }
      if (!Array.isArray(c[e.store])) c[e.store] = [];
      const target = c[e.store];
      target.splice(Math.min(e.index, target.length), 0, clone(e.before));
      lines.push('放回「' + who + '」這次刪除的紀錄：' + rowText(e.before));
      changes.push({ kind: 'restore-row', customerId: c.id, store: e.store, contactId: e.rowId });
    }
  });
  reinserts.sort((a, b) => a.index - b.index).forEach((e) => {
    const who = (e.before && e.before.name) || e.id;
    const c = find(e.id);
    if (c) {
      if (stable(c) !== stable(e.before)) conflicts.push('客戶「' + who + '」已經用同一個編號重新出現');
      return;
    }
    customers.splice(Math.min(e.index, customers.length), 0, clone(e.before));
    lines.push('放回這次刪除的客戶「' + who + '」');
    changes.push({ kind: 'restore-customer', customerId: e.id });
  });
  return { customers, docPatch, conflicts, lines, changes };
}

const REPLAYABLE_OPS = ['appendContact', 'setNextContact', 'updateCustomer', 'createCustomer', 'deleteCustomer', 'editContact', 'deleteContact'];

// legacy：舊備份（還沒有 changeSetJson）就用當時的預覽重算一次「寫入後」的樣子
function changeSetForBackup(snapshot, meta, legacyPending) {
  if (meta && typeof meta.changeSetJson === 'string' && meta.changeSetJson) {
    try { return { set: JSON.parse(meta.changeSetJson) }; } catch (_) { return { error: '這份備份的變更紀錄壞掉了，不能只還原這一次' }; }
  }
  const p = legacyPending;
  if (!p || !p.op || REPLAYABLE_OPS.indexOf(p.op) < 0 || !p.request || !p.idSource) {
    return { error: '這份備份沒有留下這一次改了什麼，只能在「之後沒人再改過」時整份還原' };
  }
  const replay = applyOp(snapshot, p.op, p.request, p.idSource);
  if (!replay || replay.error || !replay.customers) return { error: '無法重算這一次改了什麼，不能只還原這一次' };
  return { set: changeSetOf(snapshot, Object.assign({}, snapshot, { cust: replay.customers })) };
}

export function planUndo(backup, current, kind, legacyPending) {
  if (!backup) return { error: '找不到這份備份' };
  const snapshot = clone(backup);
  const meta = snapshot._backup || {};
  delete snapshot._backup;
  const backupKind = meta.kind || (Array.isArray(snapshot.cust) ? 'global_state' : 'fintrack');
  if (kind && backupKind !== kind) return { error: '備份種類和目前資料不一致' };
  if (backupKind === 'fintrack' && snapshot.existed === false) return { error: '這份備份是建立之前的空檔，不能用來刪除財務規劃' };
  const questNote = Array.isArray(meta.questEventIds) && meta.questEventIds.length
    ? '這次寫入已計入行動闖關的 ' + meta.questEventIds.length + ' 筆自動事件不會被刪除（規則不允許刪除）。'
    : '';
  if (backupKind === 'fintrack') {
    const resultRev = Number.isFinite(meta.resultRev) ? meta.resultRev : fintrackRev(snapshot) + 1;
    if (fintrackRev(current) !== resultRev) {
      return { error: '這份財務規劃在那次寫入之後又被修改過（版本 ' + resultRev + ' → ' + fintrackRev(current) + '），不能整份還原。請改用 updateFintrack 手動改回。' };
    }
    const diff = {
      summary: '還原到備份 ' + (meta.previewId || '') + ' 之前的內容',
      text: '修改前：現在的版本 ' + fintrackRev(current) + '。\n修改後：回到這次寫入之前的內容。',
      changes: []
    };
    return { target: 'undo', kind: backupKind, mode: 'whole', planId: meta.planId || '', snapshot, baseRev: fintrackRev(current), diff };
  }
  const resultRev = Number.isFinite(meta.resultRev) ? meta.resultRev : cloudRev(snapshot) + 1;
  const currentRev = cloudRev(current);
  if (currentRev === resultRev) {
    // 那次寫入之後沒有任何人再改過 → 整份放回；預覽列出「現在 → 備份」之間的每一個差異
    const rev = reverseChangeSet(current, changeSetOf(snapshot, current));
    const nowIds = new Set((current && current.cust || []).map((row) => row && row.id));
    const oldIds = new Set((snapshot.cust || []).map((row) => row && row.id));
    const removed = [];
    nowIds.forEach((id) => { if (id && !oldIds.has(id)) removed.push(id); });
    const warns = [];
    if (removed.length) warns.push('還原後，這些現在有、備份裡沒有的客戶會消失：' + removed.join('、') + '。');
    if (questNote) warns.push(questNote);
    const diff = {
      summary: '整份還原到備份 ' + (meta.previewId || '') + ' 之前的內容（那次寫入之後沒有人再改過）',
      text: '修改前：現在的版本 ' + currentRev + '。\n修改後：回到這次寫入之前的內容。' + (rev.lines.length ? '\n會改回：\n- ' + rev.lines.join('\n- ') : ''),
      mode: 'whole',
      changes: rev.changes
    };
    if (warns.length) diff.warning = warns.join('');
    return { target: 'undo', kind: backupKind, mode: 'whole', planId: '', snapshot, baseRev: currentRev, diff };
  }
  const got = changeSetForBackup(snapshot, meta, legacyPending);
  if (got.error) return { error: got.error + '（那次寫入後版本 ' + resultRev + '，現在 ' + currentRev + '）' };
  const rev = reverseChangeSet(current, got.set);
  if (rev.conflicts.length) {
    return { error: '那次寫入之後資料又被改過，而且以下地方也被動到，所以不能只還原這一次：' + rev.conflicts.join('；') + '。請在 CRM 網頁手動處理。' };
  }
  if (!rev.changes.length) return { error: '這一次的變更已經不在了，沒有東西可以還原' };
  const diff = {
    summary: '只還原備份 ' + (meta.previewId || '') + ' 那一次的變更（之後別人做的修改都保留）',
    text: '修改前：現在的版本 ' + currentRev + '。\n修改後：只反轉那一次的變更：\n- ' + rev.lines.join('\n- '),
    mode: 'targeted',
    changes: rev.changes
  };
  if (questNote) diff.warning = questNote;
  return { target: 'undo', kind: backupKind, mode: 'targeted', planId: '', customers: rev.customers, docPatch: rev.docPatch, baseRev: currentRev, diff };
}

export function fintrackRevOf(doc) {
  return fintrackRev(doc);
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
    if (request.byEmail) record.byEmail = request.byEmail;
    if (request.act) record.act = request.act;
  } else {
    record = {
      id: 'lc-' + idSource.now + '-' + idSource.suffix,
      date: request.date,
      method: request.method,
      content: request.content
    };
    if (request.time) record.time = request.time;
    if (request.byEmail) record.byEmail = request.byEmail;
    if (request.act) record.act = request.act;
  }
  arr.push(record);
  const place = store === 'contacts'
    ? '名單聯絡紀錄'
    : (target.id === c.id ? '跟進歷程' : '核心看板的跟進歷程');
  const change = {
    kind: 'append',
    store,
    customerId: target.id,
    customerName: target.name || '',
    viaCustomerId: c.id,
    record
  };
  return {
    questRows: store === 'history' && record.byEmail ? [{ customerId: target.id, rowId: record.id, opt: { changed: false } }] : [],
    customers,
    diff: diffText({
      summary: '在「' + (c.name || c.id) + '」的' + place + '新增 ' + request.date + ' ' + request.method + '：' + request.content,
      changes: [change]
    }, '「' + (c.name || c.id) + '」沒有這筆聯絡紀錄。', request.date + ' ' + request.method + '：' + request.content)
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
  const summary = '把「' + (c.name || c.id) + '」的下次聯絡日改成 ' + when + (changes.length > 1 ? '，並同步 ' + (changes.length - 1) + ' 筆連結資料' : '');
  const beforeText = changes.map((row) => '「' + (row.customerName || row.customerId) + '」' + showVal(row.before)).join('、');
  const afterText = changes.map((row) => '「' + (row.customerName || row.customerId) + '」' + showVal(row.after)).join('、');
  return { customers, diff: diffText({ summary, changes }, beforeText, afterText) };
}

export function applyOp(doc, op, request, idSource) {
  if (!doc || !Array.isArray(doc.cust)) return { error: '團隊資料裡沒有客戶清單' };
  const customers = clone(doc.cust);
  let result;
  if (op === 'appendContact') result = applyAppend(customers, request, idSource);
  else if (op === 'setNextContact') result = applyNext(customers, request);
  else if (op === 'updateCustomer') result = applyUpdateCustomer(customers, request, idSource);
  else if (op === 'createCustomer') result = applyCreateCustomer(customers, request, idSource);
  else if (op === 'deleteCustomer') result = applyDeleteCustomer(customers, request, idSource);
  else if (op === 'editContact') result = applyEditContact(customers, request);
  else if (op === 'deleteContact') result = applyDeleteContact(customers, request);
  else return { error: '不支援的操作' };
  if (result && result.customers) result.target = 'state';
  return result;
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
    fintrack: (id) => root + '/global_state/' + teamId + '/fintrack/' + id,
    preview: (id) => root + '/bot_previews/' + id,
    backup: (id) => root + '/bot_backups/' + id,
    audit: (id) => root + '/bot_audit/' + id,
    auditCollection: root + '/bot_audit'
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

export function isBackupId(id) {
  return /^bk-[0-9]+-[a-z0-9]{4}$/.test(String(id || ''));
}

export function isPlanId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(id || ''));
}
