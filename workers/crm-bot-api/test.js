import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clone, pathsFor } from './logic.js';
import { createRestFirestore, decodeFields, encodeFields, resetAuthCache } from './firestore.js';
import { handle } from './worker.js';

const TEAM = 'AB12';
const PATHS = pathsFor(TEAM);
const BOT_KEY = 'bot-secret-aaa';
const APPROVAL = 'owner-secret-bbb';

function env() {
  return {
    BOT_KEYS: JSON.stringify({ '助理甲': BOT_KEY }),
    APPROVAL_SECRET: APPROVAL,
    FIREBASE_API_KEY: 'test-api-key',
    BOT_EMAIL: 'bot@example.com',
    BOT_PASSWORD: 'bot-password',
    TEAM_ID: 'ab12',
    FIREBASE_PROJECT_ID: 'fish-teem'
  };
}

function book() {
  const history = [];
  for (let i = 1; i <= 6; i++) {
    history.push({ id: 'hm-' + i, date: '2026-01-0' + i, content: '第' + i + '筆', method: 'Line', progress: 'NURTURE' });
  }
  return {
    cust: [
      {
        id: 'lead-1', name: '王小明', phone: '0912-000-111', category: 'NEW', progress: 'LEAD',
        agentName: '林專員', nextContactDate: '2026-10-01',
        coreIds: ['deal-1', 'deal-2'], coreId: 'deal-1',
        contacts: [{ id: 'lc-old', date: '2026-09-01', method: 'Line', content: '舊的名單紀錄' }],
        history: [{ id: 'h-oldlead', date: '2026-08-01', content: '舊歷程', progress: 'LEAD' }]
      },
      {
        id: 'deal-1', name: '王小明', phone: '0912-000-111', category: 'NEW', progress: 'NURTURE',
        agentName: '林專員', nextContactDate: '2026-10-01', leadId: 'lead-1',
        createdAt: '2026-01-01T00:00:00.000Z', premium: '88888',
        history: [
          { id: 'h1', date: '2026-09-01', content: '經營', progress: 'NURTURE', method: '電話' },
          { id: 'h1b', date: '2026-09-02', content: '系統註記', progress: 'NURTURE', sys: true }
        ]
      },
      {
        id: 'deal-2', name: '王小明', phone: '0912-000-111', category: 'NEW', progress: 'FIRST_VISIT',
        nextContactDate: '2026-10-01', leadId: 'lead-1', createdAt: '2026-06-01T00:00:00.000Z',
        history: [{ id: 'h2', date: '2026-08-15', content: '初訪舊紀錄', progress: 'FIRST_VISIT', method: '面談' }]
      },
      {
        id: 'solo', name: '陳阿姨', phone: '0988-111-222', category: 'NEW', progress: 'KEY_VISIT',
        agentName: '', nextContactDate: '', history: []
      },
      {
        id: 'lead-plain', name: '李名單', phone: '0911-333-444', category: 'NEW', progress: 'LEAD',
        nextContactDate: '', contacts: [{ id: 'lc-1', date: '2026-07-01', method: '面談', content: '喝咖啡' }], history: []
      },
      {
        id: 'many', name: '多紀錄', phone: '0900-111-000', category: 'NEW', progress: 'NURTURE',
        nextContactDate: '', history
      },
      {
        id: 'won-1', name: '已成交', phone: '0900-000-009', category: 'WON', progress: '',
        premium: '50000', policyName: '終身', nextContactDate: '', history: []
      }
    ],
    per: [{ id: 'p1', name: '十月' }],
    goals: { year: 2026, target: 10 },
    tags: ['VIP'],
    pnl: { mode: 'monthly', rate: 800 },
    sched: { weeks: [1] },
    act: { current: '', activities: [{ id: 'a1' }] },
    members: [{ name: '林專員', email: 'lin@example.com', admin: false }],
    extraNote: '不要弄丟',
    _rev: 7,
    _updatedAt: 1000
  };
}

class MemoryFirestore {
  constructor() {
    this.docs = new Map();
    this.writes = [];
  }
  async getDoc(path) {
    return this.docs.has(path) ? clone(this.docs.get(path)) : null;
  }
  async setDoc(path, data) {
    this.writes.push({ op: 'set', path });
    this.docs.set(path, clone(data));
  }
  async runTransaction(fn) {
    const snap = new Map();
    for (const [k, v] of this.docs) snap.set(k, clone(v));
    const staged = [];
    const result = await fn({
      get: async (path) => (snap.has(path) ? clone(snap.get(path)) : null),
      set: (path, data) => { staged.push({ path, data: clone(data) }); }
    });
    if (result && result.abort) {
      this.writes.push({ op: 'abort', status: result.status });
      return result;
    }
    for (const w of staged) {
      this.docs.set(w.path, w.data);
      this.writes.push({ op: 'set', path: w.path });
    }
    return result;
  }
}

function harness(data, now) {
  const db = new MemoryFirestore();
  db.docs.set(PATHS.state, clone(data || book()));
  let clock = now == null ? 1800000000000 : now;
  let n = 0;
  const suffixes = ['k3mz', 'aaaa', 'bbbb', 'cccc'];
  return {
    db,
    env: env(),
    deps() {
      return { db, now: () => clock, random: () => suffixes[n++] || 'zzzz' };
    },
    setNow(v) { clock = v; }
  };
}

function req(method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;
  return new Request('https://bot.test' + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
}

async function call(h, method, path, body, key = BOT_KEY) {
  const res = await handle(req(method, path, body, key), h.env, h.deps());
  const data = await res.json();
  return { status: res.status, data };
}

function state(h) {
  return h.db.docs.get(PATHS.state);
}

function cust(h, id) {
  return state(h).cust.find((c) => c.id === id);
}

test('read: search, detail, recent 5, no money fields, auth required', async () => {
  const h = harness();
  const denied = await call(h, 'GET', '/customers?name=王', undefined, '');
  assert.equal(denied.status, 401);
  assert.equal(h.db.writes.length, 0);

  const list = await call(h, 'GET', '/customers?name=王&phone=0912-000-111');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.customers.map((c) => c.id), ['lead-1', 'deal-1', 'deal-2']);
  const lead = list.data.customers[0];
  assert.equal(lead.stage, 'LEAD');
  assert.equal(lead.progress, 'LEAD');
  assert.equal(lead.category, 'NEW');
  assert.equal(lead.nextContactDate, '2026-10-01');
  assert.equal(lead.agentName, '林專員');
  assert.equal(lead.records.length, 3);
  assert.equal(lead.records[0].content, '系統註記');
  assert.equal(lead.records[0].sys, true);
  assert.equal(lead.records[0].store, 'history');
  assert.equal(lead.records[0].customerId, 'deal-1');
  assert.equal(JSON.stringify(list.data).includes('舊的名單紀錄'), false);
  assert.equal(JSON.stringify(list.data).includes('88888'), false);

  const many = await call(h, 'GET', '/customers?name=多紀錄');
  assert.equal(many.data.customers[0].records.length, 5);
  assert.equal(many.data.customers[0].recordCount, 6);
  assert.deepEqual(many.data.customers[0].records.map((r) => r.date), [
    '2026-01-06', '2026-01-05', '2026-01-04', '2026-01-03', '2026-01-02'
  ]);

  const one = await call(h, 'GET', '/customers/many');
  assert.equal(one.status, 200);
  assert.equal(one.data.customer.records.length, 6);
  const missing = await call(h, 'GET', '/customers/nobody');
  assert.equal(missing.status, 404);

  const won = await call(h, 'GET', '/customers/won-1');
  const wonJson = JSON.stringify(won.data);
  assert.equal(wonJson.includes('50000'), false);
  assert.equal(wonJson.includes('終身'), false);
  assert.equal(won.data.customer.category, 'WON');
  assert.equal(h.db.writes.length, 0);
});

test('preview writes nothing to the team document', async () => {
  const h = harness();
  const before = clone(state(h));
  const res = await call(h, 'POST', '/preview', {
    op: 'appendContact',
    customerId: 'solo',
    date: '2026-10-16',
    method: '電話',
    content: '問了家庭狀況',
    time: '9:05',
    progress: 'WON',
    premium: '1'
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.baseRev, 7);
  assert.equal(res.data.previewId, 'pv-1800000000000-k3mz');
  assert.equal(res.data.diff.changes[0].store, 'history');
  assert.equal(res.data.diff.changes[0].record.progress, 'KEY_VISIT');
  assert.equal(res.data.diff.changes[0].record.time, '09:05');
  assert.deepEqual(state(h), before);
  assert.deepEqual(h.db.writes.map((w) => w.path), [PATHS.preview(res.data.previewId)]);
  const pending = h.db.docs.get(PATHS.preview(res.data.previewId));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.expireAt.__timestamp, res.data.expiresAt);

  const bad = await call(h, 'POST', '/preview', { op: 'delete', customerId: 'solo' });
  assert.equal(bad.status, 400);
  assert.deepEqual(state(h), before);
});

test('commit success, other keys preserved, backup and audit written', async () => {
  const h = harness();
  const before = clone(state(h));
  const preview = await call(h, 'POST', '/preview', {
    op: 'appendContact', customerId: 'solo', date: '2026-10-16', method: '面談', content: '第一次見面'
  });
  const res = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL });
  assert.equal(res.status, 200);
  assert.equal(res.data.newRev, 8);
  const after = state(h);
  assert.equal(after._rev, 8);
  assert.equal(after._updatedAt, 1800000000000);
  assert.deepEqual(after.per, before.per);
  assert.deepEqual(after.goals, before.goals);
  assert.deepEqual(after.tags, before.tags);
  assert.deepEqual(after.pnl, before.pnl);
  assert.deepEqual(after.sched, before.sched);
  assert.deepEqual(after.act, before.act);
  assert.deepEqual(after.members, before.members);
  assert.equal(after.extraNote, '不要弄丟');
  assert.equal(after.cust.length, before.cust.length);
  const solo = cust(h, 'solo');
  assert.equal(solo.history.length, 1);
  assert.deepEqual(solo.history[0], {
    id: 'h-1800000000000', date: '2026-10-16', content: '第一次見面', progress: 'KEY_VISIT', method: '面談'
  });
  assert.equal(solo.category, 'NEW');
  assert.equal(cust(h, 'won-1').premium, '50000');
  assert.equal(cust(h, 'won-1').category, 'WON');
  assert.equal(cust(h, 'deal-1').premium, '88888');

  const sets = h.db.writes.filter((w) => w.op === 'set').map((w) => w.path);
  const backupAt = sets.findIndex((p) => p.includes('/bot_backups/'));
  const stateAt = sets.findIndex((p) => p === PATHS.state);
  const auditAt = sets.findIndex((p) => p.includes('/bot_audit/'));
  assert.ok(backupAt > 0 && backupAt < stateAt && stateAt < auditAt);
  const backup = h.db.docs.get(PATHS.backup(res.data.backupId));
  assert.equal(backup._rev, 7);
  assert.equal(backup.extraNote, '不要弄丟');
  assert.deepEqual(backup.members, before.members);
  assert.deepEqual(backup.per, before.per);
  assert.equal(backup.cust.find((c) => c.id === 'solo').history.length, 0);
  assert.equal(backup._backup.previewId, preview.data.previewId);
  const audit = h.db.docs.get(PATHS.audit(res.data.auditId));
  assert.equal(audit.botName, '助理甲');
  assert.equal(audit.op, 'appendContact');
  assert.equal(audit.baseRev, 7);
  assert.equal(audit.newRev, 8);
  assert.equal(audit.customerId, 'solo');
  assert.equal(h.db.docs.get(PATHS.preview(preview.data.previewId)).status, 'committed');
  assert.equal(sets.some((p) => p.includes('fintrack')), false);

  const again = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL });
  assert.equal(again.status, 404);
  assert.equal(state(h)._rev, 8);
});

test('commit rejected without the owner approval secret', async () => {
  const h = harness();
  const before = clone(state(h));
  const preview = await call(h, 'POST', '/preview', {
    op: 'appendContact', customerId: 'solo', date: '2026-10-16', method: 'Line', content: '傳了訊息'
  });
  const writes = h.db.writes.length;
  const missing = await call(h, 'POST', '/commit', { previewId: preview.data.previewId });
  assert.equal(missing.status, 403);
  const botKeyAsCode = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: BOT_KEY });
  assert.equal(botKeyAsCode.status, 403);
  const noBot = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL }, '');
  assert.equal(noBot.status, 401);
  assert.equal(h.db.writes.length, writes);
  assert.deepEqual(state(h), before);
  assert.equal([...h.db.docs.keys()].some((p) => p.includes('bot_backups') || p.includes('bot_audit')), false);
  assert.equal(h.db.docs.get(PATHS.preview(preview.data.previewId)).status, 'pending');
});

test('commit aborts when _rev changed and writes no backup', async () => {
  const h = harness();
  const preview = await call(h, 'POST', '/preview', {
    op: 'setNextContact', customerId: 'solo', date: '2026-11-01'
  });
  const live = h.db.docs.get(PATHS.state);
  live._rev = 8;
  live._updatedAt = 2222;
  const beforeCust = clone(live.cust);
  const res = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL });
  assert.equal(res.status, 409);
  assert.equal(state(h)._rev, 8);
  assert.deepEqual(state(h).cust, beforeCust);
  assert.equal(cust(h, 'solo').nextContactDate, '');
  assert.equal([...h.db.docs.keys()].some((p) => p.includes('bot_backups') || p.includes('bot_audit')), false);
  assert.equal(h.db.writes.some((w) => w.op === 'abort'), true);
});

test('link propagation: history vs contacts, default deal, next-contact date', async () => {
  const h = harness();
  const unlinked = await call(h, 'POST', '/preview', {
    op: 'appendContact', customerId: 'lead-plain', date: '2026-10-16', method: '其他', content: '還在名單', time: '15:30'
  });
  assert.equal(unlinked.data.diff.changes[0].store, 'contacts');
  assert.equal(unlinked.data.diff.changes[0].customerId, 'lead-plain');
  let committed = await call(h, 'POST', '/commit', { previewId: unlinked.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  const plain = cust(h, 'lead-plain');
  assert.equal(plain.history.length, 0);
  assert.equal(plain.contacts.length, 2);
  assert.equal(plain.contacts[1].id, 'lc-1800000000000-k3mz');
  assert.equal(plain.contacts[1].method, '其他');
  assert.equal(plain.contacts[1].time, '15:30');
  assert.equal(plain.contacts[1].progress, undefined);
  assert.equal(plain.category, 'NEW');

  h.setNow(1800000001000);
  const linked = await call(h, 'POST', '/preview', {
    op: 'appendContact', customerId: 'lead-1', date: '2026-10-17', method: '電話', content: '打給本人'
  });
  assert.equal(linked.data.diff.changes[0].store, 'history');
  assert.equal(linked.data.diff.changes[0].customerId, 'deal-1');
  assert.equal(linked.data.diff.changes[0].record.progress, 'NURTURE');
  committed = await call(h, 'POST', '/commit', { previewId: linked.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'deal-1').history.length, 3);
  assert.equal(cust(h, 'deal-1').history[2].content, '打給本人');
  assert.equal(cust(h, 'deal-2').history.length, 1);
  assert.equal(cust(h, 'lead-1').contacts.length, 1);
  assert.equal(cust(h, 'lead-1').contacts[0].content, '舊的名單紀錄');

  h.setNow(1800000002000);
  const direct = await call(h, 'POST', '/preview', {
    op: 'appendContact', customerId: 'deal-2', date: '2026-10-18', method: 'Line', content: '這張單自己的紀錄'
  });
  assert.equal(direct.data.diff.changes[0].customerId, 'deal-2');
  committed = await call(h, 'POST', '/commit', { previewId: direct.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'deal-2').history.length, 2);
  assert.equal(cust(h, 'deal-2').history[1].progress, 'FIRST_VISIT');
  assert.equal(cust(h, 'deal-2').history[1].content, '這張單自己的紀錄');
  assert.equal(cust(h, 'deal-1').history.length, 3);

  h.setNow(1800000003000);
  const nxt = await call(h, 'POST', '/preview', {
    op: 'setNextContact', customerId: 'deal-2', date: '2026-12-01'
  });
  const ids = nxt.data.diff.changes.map((c) => c.customerId).sort();
  assert.deepEqual(ids, ['deal-1', 'deal-2', 'lead-1']);
  committed = await call(h, 'POST', '/commit', { previewId: nxt.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'lead-1').nextContactDate, '2026-12-01');
  assert.equal(cust(h, 'deal-1').nextContactDate, '2026-12-01');
  assert.equal(cust(h, 'deal-2').nextContactDate, '2026-12-01');
  assert.equal(cust(h, 'solo').nextContactDate, '');
  assert.equal(cust(h, 'won-1').category, 'WON');
  assert.equal(cust(h, 'won-1').premium, '50000');
  assert.deepEqual(state(h).members, book().members);

  h.setNow(1800000004000);
  const only = await call(h, 'POST', '/preview', {
    op: 'setNextContact', customerId: 'solo', date: '2026-12-02'
  });
  assert.deepEqual(only.data.diff.changes.map((c) => c.customerId), ['solo']);
  committed = await call(h, 'POST', '/commit', { previewId: only.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'solo').nextContactDate, '2026-12-02');
  assert.equal(cust(h, 'lead-1').nextContactDate, '2026-12-01');
});

test('expired preview and delete are refused', async () => {
  const h = harness();
  const preview = await call(h, 'POST', '/preview', {
    op: 'setNextContact', customerId: 'solo', date: '2026-12-03'
  });
  h.setNow(1800000000000 + 31 * 60 * 1000);
  const late = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL });
  assert.equal(late.status, 410);
  assert.equal(state(h)._rev, 7);
  const del = await handle(req('DELETE', '/customers/solo', undefined, BOT_KEY), h.env, h.deps());
  assert.equal(del.status, 405);
  assert.equal(cust(h, 'solo').id, 'solo');
});

test('firestore values round-trip and a transaction retries after ABORTED', async () => {
  const original = {
    cust: [{ id: 'solo', name: '陳阿姨', history: [], nextContactDate: '' }],
    per: [{ id: 'p1' }],
    members: [{ name: '林專員', admin: false }],
    extraNote: '不要弄丟',
    blank: '',
    flag: false,
    nothing: null,
    _rev: 7,
    _updatedAt: 1000
  };
  assert.deepEqual(decodeFields(encodeFields(original)), original);
  const stamped = { expireAt: { __timestamp: '2026-10-16T12:30:00.000Z' } };
  assert.deepEqual(decodeFields(encodeFields(stamped)), stamped);

  resetAuthCache();
  const calls = [];
  let commits = 0;
  const previewDoc = {
    previewId: 'pv-1800000000000-k3mz',
    teamId: TEAM,
    botName: '助理甲',
    op: 'setNextContact',
    request: { customerId: 'solo', date: '2026-12-09' },
    idSource: { now: 1800000000000, suffix: 'k3mz' },
    baseRev: 7,
    diff: {
      summary: 'x',
      changes: [{ kind: 'set', customerId: 'solo', customerName: '陳阿姨', field: 'nextContactDate', before: '', after: '2026-12-09' }]
    },
    status: 'pending',
    createdAt: '2026-10-16T12:00:00.000Z',
    expireAt: { __timestamp: '2026-10-16T12:30:00.000Z' }
  };
  const fetchImpl = async (url, options) => {
    calls.push(url + ' ' + (options && options.method));
    if (String(url).includes('signInWithPassword')) {
      return jsonRes({ idToken: 'firebase-token', expiresIn: '3600' });
    }
    if (String(url).includes(':beginTransaction')) return jsonRes({ transaction: 'tx-' + calls.length });
    if (String(url).includes(':rollback')) return jsonRes({});
    if (String(url).includes(':commit')) {
      commits += 1;
      const body = JSON.parse(options.body);
      if (commits === 1) return jsonRes({ error: { status: 'ABORTED', message: 'conflict' } }, 409);
      const names = body.writes.map((w) => w.update.name);
      assert.equal(names[0].includes('/bot_backups/'), true);
      assert.equal(names[1].endsWith('/global_state/' + TEAM), true);
      assert.equal(names[2].includes('/bot_audit/'), true);
      const fields = body.writes[1].update.fields;
      assert.equal(fields.extraNote.stringValue, '不要弄丟');
      assert.equal(fields.per.arrayValue.values[0].mapValue.fields.id.stringValue, 'p1');
      assert.equal(fields.members.arrayValue.values.length, 1);
      assert.equal(fields._rev.integerValue, '8');
      assert.equal(fields.cust.arrayValue.values[0].mapValue.fields.nextContactDate.stringValue, '2026-12-09');
      assert.equal(JSON.stringify(names).includes('fintrack'), false);
      return jsonRes({ commitTime: '2026-10-16T12:00:01.000Z' });
    }
    if (String(url).includes('/bot_previews/')) return jsonRes({ fields: encodeFields(previewDoc) });
    if (String(url).includes('/global_state/')) return jsonRes({ fields: encodeFields(original) });
    return jsonRes({ error: { message: 'unexpected ' + url } }, 500);
  };
  const db = createRestFirestore(env(), fetchImpl);
  const txResult = await db.runTransaction(async (tx) => {
    const pending = await tx.get(PATHS.preview('pv-1800000000000-k3mz'));
    const doc = await tx.get(PATHS.state);
    assert.equal(pending.baseRev, 7);
    assert.equal(doc._rev, 7);
    tx.set(PATHS.backup('bk-1-aaaa'), Object.assign({}, doc, { _backup: { at: 't' } }));
    const next = clone(doc);
    next.cust[0].nextContactDate = '2026-12-09';
    next._rev = 8;
    tx.set(PATHS.state, next);
    tx.set(PATHS.audit('au-1-bbbb'), { op: 'setNextContact' });
    return { ok: true };
  });
  assert.equal(txResult.ok, true);
  assert.equal(commits, 2);
  assert.equal(calls.filter((c) => c.includes(':rollback')).length, 1);
});

function jsonRes(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
