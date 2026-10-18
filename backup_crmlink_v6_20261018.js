/* 行動闖關 ↔ CRM 的共用純函式。
   只描述「怎麼改一筆客戶」與「自動事件怎麼去重」。
   真正寫入由各頁的 Firestore 交易執行：先重讀 global_state，再改那一位。 */
(function (root) {
  const OWNER_AGENT = '王盛嶢'; // 擁有者「寫明」的負責業務，不是空白欄位的代稱。
  const BLANK_AGENT = '個人';
  const ACT = { call: 'call', appt: 'appt', need: 'need' };
  const METHODS = ['電話', 'Line', '面談', '其他'];
  const AUTO_START = '2026-10-17';

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function digits(p) { return String(p || '').replace(/\D/g, ''); }
  function phoneTail(p) {
    const d = digits(p);
    if (d.length >= 4) return d.slice(-4);
    if (d.length >= 3) return d.slice(-3);
    return '';
  }
  function blankMemberName(team) {
    if (!team || !team.members) return '';
    const order = Array.isArray(team.emails) && team.emails.length ? team.emails : Object.keys(team.members);
    for (let i = 0; i < order.length; i++) {
      const raw = order[i];
      const key = String(raw || '').trim().toLowerCase();
      const m = team.members[key] || team.members[raw];
      if (!m || m.active === false) continue;
      if (String(m.agentName || '').trim()) continue;
      const label = String(m.displayName || '').trim();
      if (label) return label;
    }
    return '';
  }
  function agentLabel(name, team) {
    const n = String(name == null ? '' : name).trim();
    if (n) return n;
    const doc = team || (typeof window !== 'undefined' ? window.__aqTeamDoc : null);
    return blankMemberName(doc) || BLANK_AGENT;
  }
  function validDate(v) {
    const d = String(v || '').substring(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }
  function validTime(v) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v == null ? '' : v).trim());
    if (!m) return '';
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return '';
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }
  function twDate(d) {
    const dt = d instanceof Date ? d : new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dt);
    const g = function (t) { const p = parts.find(function (x) { return x.type === t; }); return p ? p.value : ''; };
    return g('year') + '-' + g('month') + '-' + g('day');
  }
  function actOf(v) { return ACT[v] || ''; }
  function listKey(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48); }
  function eventId(custId, action, date) {
    return ('ae_' + custId + '_' + action + '_' + date).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
  }
  function kindOf(entry) { return entry && entry.kind === 'warm' ? 'warm' : 'call'; }
  function resultLine(kind, res) {
    const map = {
      care: '暖關係：已關心',
      mute: '暖關係：沒回應',
      no: '約訪：沒接',
      ok: '約訪：約到了',
      later: '約訪：再聯絡',
      nope: '約訪：不需要'
    };
    return map[res] || '';
  }
  function historyContent(note, kind, res) {
    const line = resultLine(kind, res);
    const n = String(note || '').trim();
    if (line && n) return line + '。' + n;
    return line || n;
  }
  function actFor(kind, res) {
    if (kind === 'warm') return '';
    if (res === 'ok') return 'appt';
    if (res === 'no' || res === 'later') return 'call';
    return '';
  }
  function countActions(kind, res) {
    if (kind === 'warm' && res === 'care') return ['warm'];
    if (kind !== 'warm' && (res === 'no' || res === 'later')) return ['call'];
    if (kind !== 'warm' && res === 'ok') return ['call', 'appt'];
    return [];
  }
  function searchCustomers(list, q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [];
    return (Array.isArray(list) ? list : []).filter(function (c) {
      return c && String(c.name || '').toLowerCase().indexOf(s) >= 0;
    }).slice(0, 12);
  }
  function pickMeta(c) {
    return {
      id: c && c.id,
      name: String((c && c.name) || '').trim(),
      tail: phoneTail(c && c.phone),
      agent: agentLabel(c && c.agentName),
      agentBlank: !String((c && c.agentName) || '').trim()
    };
  }
  function dealIds(L) {
    const s = [];
    if (L && Array.isArray(L.coreIds)) L.coreIds.forEach(function (id) { if (id && s.indexOf(id) < 0) s.push(id); });
    if (L && L.coreId && s.indexOf(L.coreId) < 0) s.push(L.coreId);
    return s;
  }
  function syncNext(cust, c, v) {
    c.nextContactDate = v;
    let L = null;
    if (c.progress === 'LEAD') L = c;
    else if (c.leadId) {
      L = cust.find(function (x) {
        return x && x.id === c.leadId && x.progress === 'LEAD' && dealIds(x).indexOf(c.id) >= 0;
      }) || null;
    }
    if (!L) return;
    if (L !== c) L.nextContactDate = v;
    cust.forEach(function (d) {
      if (!d || d === c || d.progress === 'LEAD' || d.leadId !== L.id) return;
      if (dealIds(L).indexOf(d.id) < 0) return;
      d.nextContactDate = v;
    });
  }
  function stageProgress(c) { return c && c.progress ? String(c.progress) : ''; }
  function linkedDeals(cust, L) {
    if (!L || L.progress !== 'LEAD') return [];
    const ids = dealIds(L);
    const out = [];
    ids.forEach(function (id) {
      const C = (Array.isArray(cust) ? cust : []).find(function (x) { return x && x.id === id; });
      if (C && C.progress !== 'LEAD' && C.leadId === L.id && out.indexOf(C) < 0) out.push(C);
    });
    return out;
  }
  function defaultDeal(cust, L) {
    const deals = linkedDeals(cust, L);
    if (!deals.length) return null;
    let best = null, bk = '';
    deals.forEach(function (d, i) {
      let last = '';
      (Array.isArray(d.history) ? d.history : []).forEach(function (h) {
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
  function contactKey(id) {
    const s = String(id || '');
    if (/^lc-[A-Za-z0-9_-]+$/.test(s)) return s;
    const body = s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    return 'lc-' + (body || 'x');
  }
  function fillCopy(row) {
    const copy = { date: validDate(row.date), content: String(row.content || '') };
    if (row.byEmail) copy.byEmail = String(row.byEmail).toLowerCase();
    if (METHODS.indexOf(row.method) >= 0) copy.method = row.method;
    if (actOf(row.act)) copy.act = actOf(row.act);
    if (validTime(row.time)) copy.time = validTime(row.time);
    return copy;
  }
  function mergeRow(prev, copy) {
    prev.date = copy.date;
    prev.content = copy.content;
    if (copy.byEmail) prev.byEmail = copy.byEmail;
    if (copy.method) prev.method = copy.method;
    if (copy.act) prev.act = copy.act;
    if (copy.time) prev.time = copy.time;
  }
  function putRow(c, row) {
    if (!row || !row.id || !validDate(row.date)) return;
    const copy = fillCopy(row);
    copy.id = String(row.id);
    copy.progress = stageProgress(c);
    c.history = Array.isArray(c.history) ? c.history : [];
    const i = c.history.findIndex(function (h) { return h && h.id === copy.id; });
    if (i >= 0) {
      const prev = c.history[i];
      mergeRow(prev, copy);
      prev.progress = copy.progress;
      return;
    }
    c.history.push(copy);
  }
  function putContact(c, row) {
    if (!row || !row.id || !validDate(row.date)) return;
    const key = contactKey(row.id);
    const copy = fillCopy(row);
    copy.id = key;
    c.contacts = Array.isArray(c.contacts) ? c.contacts : [];
    const raw = String(row.id);
    const i = c.contacts.findIndex(function (h) { return h && (String(h.id) === key || String(h.id) === raw); });
    if (i >= 0) {
      const prev = c.contacts[i];
      if (!prev.id || String(prev.id).indexOf('lc-') !== 0) prev.id = key;
      mergeRow(prev, copy);
      return;
    }
    c.contacts.push(copy);
  }
  function placeRow(cust, c, row) {
    if (!c || !row) return;
    if (c.progress === 'LEAD') {
      const deal = defaultDeal(cust, c);
      if (deal) { putRow(deal, row); return; }
      putContact(c, row);
      return;
    }
    putRow(c, row);
  }
  function rowKeys(rowId) {
    const id = String(rowId || '');
    const keys = [id];
    const ck = contactKey(id);
    if (keys.indexOf(ck) < 0) keys.push(ck);
    return keys;
  }
  function matchRow(list, keys) {
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (h && keys.indexOf(String(h.id)) >= 0) return h;
    }
    return null;
  }
  function locateRow(cust, custId, rowId) {
    const list = Array.isArray(cust) ? cust : [];
    const c = list.find(function (x) { return x && x.id === custId; });
    if (!c || !rowId) return null;
    const keys = rowKeys(rowId);
    let row = matchRow(c.history, keys) || matchRow(c.contacts, keys);
    if (!row && c.progress === 'LEAD') {
      const deals = linkedDeals(list, c);
      for (let i = 0; i < deals.length && !row; i++) row = matchRow(deals[i].history, keys);
    }
    if (!row) return null;
    return { row: row, custId: c.id, name: String(c.name || ''), leadId: c.leadId || '' };
  }
  function patchState(state, custId, ops) {
    ops = ops || {};
    if (!state || typeof state !== 'object' || !Array.isArray(state.cust) || !custId) return { ok: false, reason: 'missing' };
    const idx = state.cust.findIndex(function (c) { return c && c.id === custId; });
    if (idx < 0) return { ok: false, reason: 'missing' };
    const next = clone(state);
    const c = next.cust[idx];
    if (!c || c.id !== custId) return { ok: false, reason: 'missing' };
    if (ops.history) placeRow(next.cust, c, ops.history);
    if (ops.appointment) placeRow(next.cust, c, ops.appointment);
    if (ops.nextContactDate != null && validDate(ops.nextContactDate)) syncNext(next.cust, c, validDate(ops.nextContactDate));
    next._rev = (Number(state._rev) || 0) + 1;
    next._updatedAt = Date.now();
    return { ok: true, data: next };
  }
  function buildWrite(entry, email) {
    const kind = kindOf(entry);
    const id = 'haq-' + listKey(entry && entry.id);
    const by = String(email || '').toLowerCase();
    const history = {
      id: id + '-res',
      date: twDate(),
      content: historyContent(entry && entry.note, kind, entry && entry.res),
      byEmail: by
    };
    const act = actFor(kind, entry && entry.res);
    if (act) history.act = act;
    if (entry && METHODS.indexOf(entry.method) >= 0) history.method = entry.method;
    const ops = { history: history };
    const next = entry && entry.res !== 'ok' ? validDate(entry.next) : '';
    if (next) ops.nextContactDate = next;
    const ad = entry && entry.res === 'ok' && entry.appt ? validDate(entry.appt.d) : '';
    if (ad) {
      const ap = {
        id: id + '-appt',
        date: ad,
        content: '約見' + (entry.appt.loc ? ' @' + String(entry.appt.loc).trim() : '') + (String(entry.note || '').trim() ? '。' + String(entry.note).trim() : ''),
        method: '面談',
        byEmail: by
      };
      const tm = validTime(entry.appt.t);
      if (tm) ap.time = tm;
      ops.appointment = ap;
    }
    return ops;
  }
  function seenPair(seen, custId, action, date) {
    return (seen || []).some(function (e) {
      return e && e.custId === custId && e.action === action && e.date === date;
    });
  }
  function planListEvents(entry, email, date, seen) {
    const kind = kindOf(entry);
    const actions = countActions(kind, entry && entry.res).filter(function (a) { return a === 'call' || a === 'appt'; });
    const day = validDate(date);
    const out = [];
    if (!entry || !entry.custId || !day || day < AUTO_START) return out;
    actions.forEach(function (action) {
      if (seenPair(seen, entry.custId, action, day) || seenPair(out, entry.custId, action, day)) return;
      out.push({
        id: eventId(entry.custId, action, day),
        custId: entry.custId,
        histId: 'haq-' + listKey(entry.id) + '-res',
        action: action,
        date: day,
        round: 1,
        side: entry.t === 'rf' ? 'rf' : 'ds',
        name: String(entry.name || '').trim(),
        email: String(email || '').toLowerCase()
      });
    });
    return out;
  }
  function planActEvent(customer, historyRow, seen) {
    if (!customer || !historyRow || !historyRow.byEmail || !historyRow.id || !customer.id) return [];
    const act = actOf(historyRow.act);
    const day = validDate(historyRow.date);
    if (!act || !day || day < AUTO_START) return [];
    if (seenPair(seen, customer.id, act, day)) return [];
    return [{
      id: eventId(customer.id, act, day),
      custId: customer.id,
      histId: historyRow.id,
      action: act,
      date: day,
      round: 1,
      side: 'ds',
      name: String(customer.name || '').trim(),
      email: String(historyRow.byEmail).toLowerCase(),
      leadId: customer.leadId || ''
    }];
  }
  function moneyNum(v) {
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  }
  function dayOf(v) {
    const s = String(v == null ? '' : v).trim().replace(/[/.]/g, '-');
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (!m) return '';
    const mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
    return m[1] + '-' + (mo < 10 ? '0' : '') + mo + '-' + (da < 10 ? '0' : '') + da;
  }
  function firstFilled(c, keys) {
    if (!c) return '';
    for (let i = 0; i < keys.length; i++) {
      const d = dayOf(c[keys[i]]);
      if (d) return d;
    }
    return '';
  }
  function wonHistDay(c) {
    const hist = c && Array.isArray(c.history) ? c.history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      if (h && h.progress === 'WON') {
        const d = dayOf(h.date);
        if (d) return d;
      }
    }
    return '';
  }
  function periodOf(c) {
    if (!c || typeof c !== 'object') return 'Unknown';
    if (c.category === 'WON') {
      const sub = firstFilled(c, ['submitDate', '送件日', '送件日期']);
      if (sub) return sub.slice(0, 7);
      const deal = firstFilled(c, ['dealDate', '成交日', '成交日期']);
      if (deal) return deal.slice(0, 7);
      const hist = wonHistDay(c);
      if (hist) return hist.slice(0, 7);
    }
    const created = String(c.createdAt || '');
    return /^\d{4}-\d{2}/.test(created) ? created.substring(0, 7) : 'Unknown';
  }
  function perfDay(c) {
    if (c && c.category === 'WON') {
      return firstFilled(c, ['submitDate', '送件日', '送件日期'])
        || firstFilled(c, ['dealDate', '成交日', '成交日期'])
        || wonHistDay(c)
        || dayOf(c.createdAt)
        || '9999-99-99';
    }
    return dayOf(c && c.createdAt) || '9999-99-99';
  }
  function salesWon(c) {
    if (!c || c.category !== 'WON') return false;
    if (c.progress === 'LEAD' || c.progress === 'HOLD' || c.progress === 'LOST' || c.category === 'RECRUIT') return false;
    return true;
  }
  function personKey(c, list) {
    const id = String((c && c.id) || '');
    const leadId = String((c && c.leadId) || '').trim();
    if (!leadId) return 'id:' + id;
    const lead = (list || []).find(function (x) { return x && x.id === leadId && x.progress === 'LEAD'; });
    if (!lead) return 'id:' + id;
    const ids = [];
    if (Array.isArray(lead.coreIds)) lead.coreIds.forEach(function (x) { if (x) ids.push(x); });
    if (lead.coreId && ids.indexOf(lead.coreId) < 0) ids.push(lead.coreId);
    if (ids.indexOf(id) < 0) return 'id:' + id;
    return 'lead:' + leadId;
  }
  function firstWonIds(list) {
    const best = {};
    (list || []).forEach(function (c) {
      if (!salesWon(c)) return;
      const k = personKey(c, list);
      const stamp = perfDay(c) + '|' + String(c.createdAt || '') + '|' + String(c.id || '');
      if (!best[k] || stamp < best[k].stamp) best[k] = { id: String(c.id || ''), stamp: stamp };
    });
    const ids = {};
    Object.keys(best).forEach(function (k) { if (best[k].id) ids[best[k].id] = 1; });
    return ids;
  }
  function sideOf(c) {
    const blob = String((c && c.source) || '');
    if (/陌生/.test(blob)) return 'ds';
    if (/緣故|轉介紹|家人|朋友|同學|同事/.test(blob)) return 'rf';
    return 'ds';
  }
  function emptyRoll() {
    return { deal: 0, client: 0, prem: 0, comm: 0, fyc: 0 };
  }
  function addRoll(bag, c, client) {
    bag.deal += 1;
    if (client) bag.client += 1;
    bag.prem += moneyNum(c.premium);
    bag.comm += moneyNum(c.commission);
    bag.fyc += moneyNum(c.fyc);
  }
  function inPeriod(p, period) {
    if (!period) return true;
    if (String(period).length === 4) return p.slice(0, 4) === period;
    return p === period;
  }
  function wonRollup(list, opts) {
    opts = opts || {};
    const period = String(opts.period || '');
    const useAgent = Object.prototype.hasOwnProperty.call(opts, 'agentName');
    const agent = String(opts.agentName || '').trim();
    const first = firstWonIds(list);
    const all = emptyRoll();
    const ds = emptyRoll();
    const rf = emptyRoll();
    (list || []).forEach(function (c) {
      if (!salesWon(c)) return;
      if (useAgent && String(c.agentName || '').trim() !== agent) return;
      if (!inPeriod(periodOf(c), period)) return;
      const client = !!first[String(c.id || '')];
      addRoll(all, c, client);
      addRoll(sideOf(c) === 'rf' ? rf : ds, c, client);
    });
    all.ds = ds;
    all.rf = rf;
    return all;
  }
  function wonMonths(list, agentName) {
    const months = {};
    const first = firstWonIds(list);
    const agent = String(agentName || '').trim();
    (list || []).forEach(function (c) {
      if (!salesWon(c)) return;
      if (String(c.agentName || '').trim() !== agent) return;
      const p = periodOf(c);
      if (!/^\d{4}-\d{2}$/.test(p)) return;
      if (!months[p]) months[p] = emptyRoll();
      addRoll(months[p], c, !!first[String(c.id || '')]);
    });
    return months;
  }
  function memberAgentName(team, email) {
    if (!team || !team.members) return null;
    const em = String(email || '').trim().toLowerCase();
    if (!em) return null;
    const m = team.members[em];
    if (!m || m.active === false) return null;
    return String(m.agentName || '').trim();
  }
  function freshCustId() {
    return 'cust-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  }
  function sourceForSide(side) {
    return side === 'rf' ? '緣故' : '陌生';
  }
  function scopeMatches(list, name, agent) {
    const nm = String(name || '').trim();
    const ag = String(agent == null ? '' : agent).trim();
    return (list || []).filter(function (c) {
      if (!c || c.category === 'RECRUIT') return false;
      if (String(c.name || '').trim() !== nm) return false;
      return String(c.agentName || '').trim() === ag;
    });
  }
  function makeLead(name, agent, side, stage) {
    return {
      id: freshCustId(),
      name: name,
      category: 'NEW',
      progress: 'LEAD',
      createdAt: new Date().toISOString(),
      tags: [],
      history: [],
      leadCls: [],
      source: sourceForSide(side),
      region: '',
      acreStage: stage,
      phone: '',
      company: '',
      notes: '',
      birthday: '',
      lastStage: 'NURTURE',
      agentName: String(agent || '')
    };
  }
  function makeDeal(L) {
    return {
      id: freshCustId(),
      name: String((L && L.name) || '').trim(),
      company: (L && L.company) || '',
      phone: (L && L.phone) || '',
      birthday: (L && L.birthday) || '',
      nextContactDate: '',
      agentName: String((L && L.agentName) || ''),
      category: 'NEW',
      progress: 'NURTURE',
      tags: L && Array.isArray(L.tags) ? L.tags.slice() : [],
      notes: (L && L.notes) || '',
      createdAt: new Date().toISOString(),
      history: [],
      lastStage: 'NURTURE'
    };
  }
  function carryContacts(L, C) {
    const list = Array.isArray(L.contacts) ? L.contacts : [];
    if (!list.length) return 0;
    C.history = Array.isArray(C.history) ? C.history : [];
    const have = {};
    const ids = {};
    C.history.forEach(function (h) {
      if (h && h.srcContactId) have[h.srcContactId] = 1;
      if (h && h.id) ids[h.id] = 1;
    });
    const keep = [];
    let n = 0;
    let seq = Date.now();
    list.forEach(function (ct) {
      if (!ct || typeof ct !== 'object') return;
      const d = validDate(ct.date);
      if (ct.id && have[ct.id]) return;
      if (!d) { keep.push(ct); return; }
      let hid = 'h-' + (seq++);
      while (ids[hid]) hid = 'h-' + (seq++);
      ids[hid] = 1;
      const h = { id: hid, date: d, content: String(ct.content || ''), progress: C.progress || '' };
      if (ct.method) h.method = String(ct.method);
      if (ct.byEmail) h.byEmail = String(ct.byEmail);
      if (actOf(ct.act)) h.act = actOf(ct.act);
      const end = validDate(ct.endDate);
      if (end && end > d) h.endDate = end;
      if (validTime(ct.time)) h.time = validTime(ct.time);
      if (validTime(ct.time) && validTime(ct.endTime)) h.endTime = validTime(ct.endTime);
      if (ct.id) { h.srcContactId = String(ct.id); have[ct.id] = 1; }
      C.history.push(h);
      n++;
    });
    if (keep.length) L.contacts = keep;
    else delete L.contacts;
    return n;
  }
  function attachDeal(list, L, C) {
    C.leadId = L.id;
    const live = linkedDeals(list, L).map(function (d) { return d.id; });
    if (live.indexOf(C.id) < 0) live.push(C.id);
    L.coreIds = live;
    L.coreId = live[0];
    carryContacts(L, C);
    if (Array.isArray(L.history) && L.history.length) {
      C.history = Array.isArray(C.history) ? C.history : [];
      const seen = {};
      C.history.forEach(function (h) { if (h && h.id) seen[h.id] = 1; });
      L.history.forEach(function (h) {
        if (h && !(h.id && seen[h.id])) C.history.push(clone(h));
      });
      L.history = [];
    }
    if (!validDate(C.nextContactDate) && validDate(L.nextContactDate)) C.nextContactDate = validDate(L.nextContactDate);
  }
  function bumpState(state) {
    state._rev = (Number(state._rev) || 0) + 1;
    state._updatedAt = Date.now();
    return state;
  }
  function syncListPerson(state, spec) {
    spec = spec || {};
    const name = String(spec.name || '').trim();
    const kind = spec.kind === 'warm' ? 'warm' : 'call';
    const side = spec.side === 'rf' ? 'rf' : 'ds';
    if (!state || typeof state !== 'object' || !Array.isArray(state.cust)) return { ok: false, reason: 'missing', changed: false, custId: '', matches: [] };
    if (!name) return { ok: false, reason: 'name', changed: false, custId: '', matches: [] };
    if (spec.agentName == null) return { ok: false, reason: 'agent', changed: false, custId: '', matches: [] };
    const agent = String(spec.agentName).trim();
    const custId = String(spec.custId || '').trim();
    const next = clone(state);
    const list = next.cust;
    function finish(reason, id, changed) {
      if (changed) bumpState(next);
      return { ok: true, reason: reason, changed: !!changed, custId: id || '', data: changed ? next : state, matches: [] };
    }
    function activate(L) {
      const deals = linkedDeals(list, L);
      if (deals.length) {
        const pick = defaultDeal(list, L) || deals[0];
        return finish('linked', pick.id, false);
      }
      const C = makeDeal(L);
      list.push(C);
      attachDeal(list, L, C);
      L.acreStage = 'SAPLING';
      C.history = Array.isArray(C.history) ? C.history : [];
      C.history.push({
        id: 'h-aq-' + Date.now(),
        date: twDate(),
        content: '從行動闖關轉約訪',
        progress: 'NURTURE',
        sys: true
      });
      return finish('activated', C.id, true);
    }
    if (custId) {
      const cur = list.find(function (c) { return c && c.id === custId; });
      if (!cur) return { ok: false, reason: 'missing', changed: false, custId: '', matches: [] };
      if (String(cur.agentName || '').trim() !== agent) return finish('linked', cur.id, false);
      if (cur.progress !== 'LEAD' || kind !== 'call') return finish('linked', cur.id, false);
      return activate(cur);
    }
    const hits = scopeMatches(list, name, agent);
    if (hits.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        changed: false,
        custId: '',
        data: state,
        matches: hits.map(function (c) {
          return { id: c.id, name: String(c.name || '').trim(), progress: c.progress || '', agentName: String(c.agentName || '') };
        })
      };
    }
    if (hits.length === 1) {
      const hit = hits[0];
      if (hit.progress === 'LEAD' && kind === 'call') return activate(hit);
      return finish('linked', hit.id, false);
    }
    if (kind === 'warm') {
      const L = makeLead(name, agent, side, 'SEED');
      list.push(L);
      return finish('created', L.id, true);
    }
    const L = makeLead(name, agent, side, 'SAPLING');
    const C = makeDeal(L);
    list.push(L);
    list.push(C);
    C.leadId = L.id;
    L.coreIds = [C.id];
    L.coreId = C.id;
    return finish('created', C.id, true);
  }
  function guardSave(expectedRev, fresh, memoryPayload, exists) {
    const cloudRev = fresh && fresh._rev != null ? (Number(fresh._rev) || 0) : 0;
    if (exists && cloudRev !== expectedRev) return { conflict: true, rev: cloudRev };
    const payload = clone(memoryPayload || {});
    payload._rev = cloudRev + 1;
    payload._updatedAt = Date.now();
    return { conflict: false, payload: payload };
  }

  root.CrmLink = {
    OWNER_AGENT: OWNER_AGENT,
    BLANK_AGENT: BLANK_AGENT,
    phoneTail: phoneTail,
    agentLabel: agentLabel,
    searchCustomers: searchCustomers,
    pickMeta: pickMeta,
    validDate: validDate,
    validTime: validTime,
    twDate: twDate,
    actFor: actFor,
    countActions: countActions,
    historyContent: historyContent,
    eventId: eventId,
    patchState: patchState,
    buildWrite: buildWrite,
    planListEvents: planListEvents,
    planActEvent: planActEvent,
    locateRow: locateRow,
    guardSave: guardSave,
    periodOf: periodOf,
    wonRollup: wonRollup,
    wonMonths: wonMonths,
    memberAgentName: memberAgentName,
    syncListPerson: syncListPerson
  };
})(typeof window !== 'undefined' ? window : globalThis);
