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
  async listDocs(collectionPath) {
    const prefix = String(collectionPath || '').replace(/\/$/, '') + '/';
    const out = [];
    for (const [path, doc] of this.docs) {
      if (!path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      if (!id || id.includes('/')) continue;
      out.push(Object.assign(clone(doc), { id }));
    }
    return out;
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

test('read: search, detail, recent 5, full fields, auth required', async () => {
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
  assert.equal(lead.records.some((r) => r.content === '舊的名單紀錄'), false);
  assert.equal(lead.contacts[0].content, '舊的名單紀錄');
  assert.equal(list.data.customers[1].premium, '88888');

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
  assert.equal(won.data.customer.premium, '50000');
  assert.equal(won.data.customer.policyName, '終身');
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
  let stateReads = 0;
  let lastStateTime = '';
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
    if (String(url).includes(':beginTransaction') || String(url).includes(':rollback')) {
      return jsonRes({ error: { status: 'PERMISSION_DENIED', message: 'beginTransaction is not used' } }, 403);
    }
    if (String(url).includes(':commit')) {
      commits += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.transaction, undefined);
      const names = body.writes.map((w) => w.update.name);
      const stateWrite = body.writes.find((w) => w.update.name.endsWith('/global_state/' + TEAM));
      const backupWrite = body.writes.find((w) => w.update.name.includes('/bot_backups/'));
      const auditWrite = body.writes.find((w) => w.update.name.includes('/bot_audit/'));
      assert.deepEqual(stateWrite.currentDocument, { updateTime: lastStateTime });
      assert.equal(backupWrite.currentDocument, undefined);
      assert.equal(auditWrite.currentDocument, undefined);
      if (commits === 1) return jsonRes({ error: { status: 'ABORTED', message: 'conflict' } }, 409);
      if (commits === 2) return jsonRes({ error: { status: 'FAILED_PRECONDITION', message: 'updateTime changed' } }, 400);
      assert.equal(names[0].includes('/bot_backups/'), true);
      assert.equal(names[1].endsWith('/global_state/' + TEAM), true);
      assert.equal(names[2].includes('/bot_audit/'), true);
      const fields = stateWrite.update.fields;
      assert.equal(fields.extraNote.stringValue, '不要弄丟');
      assert.equal(fields.per.arrayValue.values[0].mapValue.fields.id.stringValue, 'p1');
      assert.equal(fields.members.arrayValue.values.length, 1);
      assert.equal(fields._rev.integerValue, '8');
      assert.equal(fields.cust.arrayValue.values[0].mapValue.fields.nextContactDate.stringValue, '2026-12-09');
      assert.equal(JSON.stringify(names).includes('fintrack'), false);
      return jsonRes({ commitTime: '2026-10-16T12:00:01.000Z' });
    }
    if (String(url).includes('/bot_previews/')) {
      return jsonRes({ fields: encodeFields(previewDoc), updateTime: '2026-10-16T12:00:00.000000Z' });
    }
    if (String(url).includes('/global_state/')) {
      stateReads += 1;
      lastStateTime = '2026-10-16T11:00:00.' + stateReads + '00000Z';
      return jsonRes({ fields: encodeFields(original), updateTime: lastStateTime });
    }
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
  assert.equal(commits, 3);
  assert.equal(stateReads, 3);
  assert.equal(calls.filter((c) => c.includes(':beginTransaction') || c.includes(':rollback')).length, 0);
});

function jsonRes(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

test('update and create customer touch only that customer', async () => {
  const h = harness();
  const before = clone(state(h));
  const bad = await call(h, 'POST', '/preview', { op: 'updateCustomer', customerId: 'solo', patch: { notAField: 'x' } });
  assert.equal(bad.status, 400);
  const preview = await call(h, 'POST', '/preview', {
    op: 'updateCustomer', customerId: 'solo', patch: { name: '陳太太', notes: '有孫子', stage: 'FIRST_VISIT' }
  });
  assert.equal(preview.status, 200);
  assert.match(preview.data.diff.text, /修改前：/);
  assert.match(preview.data.diff.text, /修改後：/);
  assert.deepEqual(state(h), before);
  let committed = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'solo').name, '陳太太');
  assert.equal(cust(h, 'solo').notes, '有孫子');
  assert.equal(cust(h, 'solo').progress, 'FIRST_VISIT');
  assert.equal(cust(h, 'solo').phone, '0988-111-222');
  assert.equal(cust(h, 'lead-1').name, '王小明');
  assert.deepEqual(state(h).members, before.members);
  assert.equal(state(h).extraNote, '不要弄丟');

  h.setNow(1800000005000);
  const created = await call(h, 'POST', '/preview', {
    op: 'createCustomer', customer: { name: '新人', phone: '0912000000', category: 'NEW', progress: 'NURTURE' }
  });
  assert.match(created.data.diff.text, /修改前：/);
  assert.match(created.data.diff.text, /新增「新人」/);
  committed = await call(h, 'POST', '/commit', { previewId: created.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  const newbie = state(h).cust.find((c) => c.name === '新人');
  assert.ok(newbie);
  assert.equal(newbie.history.length, 0);
  assert.equal(state(h).cust.length, before.cust.length + 1);
  assert.equal(cust(h, 'won-1').premium, '50000');
  assert.deepEqual(state(h).per, before.per);
});

test('delete customer and one contact warn, and leave everyone else', async () => {
  const h = harness();
  const preview = await call(h, 'POST', '/preview', { op: 'deleteCustomer', customerId: 'deal-2' });
  assert.match(preview.data.diff.warning, /即將刪除/);
  assert.match(preview.data.diff.text, /修改前：/);
  assert.match(preview.data.diff.text, /修改後：/);
  let committed = await call(h, 'POST', '/commit', { previewId: preview.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'deal-2'), undefined);
  assert.ok(cust(h, 'deal-1'));
  assert.ok(cust(h, 'lead-1'));
  assert.deepEqual(cust(h, 'lead-1').coreIds, ['deal-1']);
  assert.equal(cust(h, 'solo').name, '陳阿姨');
  assert.equal(state(h).extraNote, '不要弄丟');

  h.setNow(1800000006000);
  const edited = await call(h, 'POST', '/preview', {
    op: 'editContact', customerId: 'deal-1', contactId: 'h1', patch: { content: '改過的經營' }
  });
  assert.match(edited.data.diff.text, /修改前：/);
  assert.match(edited.data.diff.text, /改過的經營/);
  committed = await call(h, 'POST', '/commit', { previewId: edited.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'deal-1').history.find((row) => row.id === 'h1').content, '改過的經營');
  assert.equal(cust(h, 'deal-1').premium, '88888');

  h.setNow(1800000007000);
  const removed = await call(h, 'POST', '/preview', { op: 'deleteContact', customerId: 'deal-1', contactId: 'h1' });
  assert.match(removed.data.diff.warning, /即將刪除/);
  assert.match(removed.data.diff.text, /修改後：/);
  committed = await call(h, 'POST', '/commit', { previewId: removed.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'deal-1').history.some((row) => row.id === 'h1'), false);
  assert.equal(cust(h, 'deal-1').history.some((row) => row.id === 'h1b'), true);
  assert.equal(cust(h, 'lead-1').name, '王小明');
});

test('fintrack create and update do not change the customer book', async () => {
  const h = harness();
  const before = clone(state(h));
  h.db.docs.set(PATHS.fintrack('plan-b'), {
    clientId: 'plan-b', teamId: TEAM, clientName: '別人', rev: 3, snapJson: JSON.stringify({ client: { name: '別人', job: '舊' } })
  });
  const created = await call(h, 'POST', '/preview', {
    op: 'createFintrack', planId: 'plan-a', clientName: '陳阿姨',
    snap: { client: { name: '陳阿姨', birth: '', job: '教師', note: '' } }
  });
  assert.equal(created.status, 200);
  assert.match(created.data.diff.text, /修改前：/);
  assert.match(created.data.diff.text, /修改後：/);
  let committed = await call(h, 'POST', '/commit', { previewId: created.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.deepEqual(state(h), before);
  const got = await call(h, 'GET', '/fintrack/plan-a');
  assert.equal(got.status, 200);
  assert.equal(got.data.plan.clientName, '陳阿姨');
  assert.equal(got.data.plan.snap.client.job, '教師');
  assert.equal(got.data.plan.rev, 1);
  assert.equal((await call(h, 'GET', '/fintrack/plan-b')).data.plan.clientName, '別人');

  h.setNow(1800000008000);
  const updated = await call(h, 'POST', '/preview', { op: 'updateFintrack', planId: 'plan-a', clientName: '陳太太' });
  committed = await call(h, 'POST', '/commit', { previewId: updated.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  const again = await call(h, 'GET', '/fintrack/plan-a');
  assert.equal(again.data.plan.clientName, '陳太太');
  assert.equal(again.data.plan.snap.client.job, '教師');
  assert.equal(again.data.plan.rev, 2);
  assert.equal((await call(h, 'GET', '/fintrack/plan-b')).data.plan.snap.client.job, '舊');
  assert.deepEqual(state(h).cust, before.cust);
  assert.deepEqual(state(h).members, before.members);
  const backup = h.db.docs.get(PATHS.backup(committed.data.backupId));
  assert.equal(backup._backup.kind, 'fintrack');
  assert.equal(backup.clientName, '陳阿姨');

  h.setNow(1800000008500);
  const undone = await call(h, 'POST', '/preview', { op: 'undo', backupId: committed.data.backupId });
  assert.match(undone.data.diff.text, /修改前：/);
  committed = await call(h, 'POST', '/commit', { previewId: undone.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal((await call(h, 'GET', '/fintrack/plan-a')).data.plan.clientName, '陳阿姨');
  assert.equal((await call(h, 'GET', '/fintrack/plan-b')).data.plan.clientName, '別人');
  assert.deepEqual(state(h).cust, before.cust);
});

test('undo round-trip restores the previous customer and can restore forward again', async () => {
  const h = harness();
  const first = await call(h, 'POST', '/preview', {
    op: 'updateCustomer', customerId: 'solo', patch: { notes: '先改備註' }
  });
  let committed = await call(h, 'POST', '/commit', { previewId: first.data.previewId, approvalCode: APPROVAL });
  assert.equal(cust(h, 'solo').notes, '先改備註');
  const backupId = committed.data.backupId;

  h.setNow(1800000009000);
  const back = await call(h, 'POST', '/preview', { op: 'undo', backupId });
  assert.equal(back.status, 200);
  assert.match(back.data.diff.text, /修改前：/);
  assert.match(back.data.diff.text, /修改後：/);
  committed = await call(h, 'POST', '/commit', { previewId: back.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'solo').notes || '', '');
  assert.equal(cust(h, 'solo').name, '陳阿姨');
  assert.equal(cust(h, 'lead-1').phone, '0912-000-111');
  assert.equal(state(h).extraNote, '不要弄丟');

  h.setNow(1800000010000);
  const forward = await call(h, 'POST', '/preview', { op: 'undo', backupId: committed.data.backupId });
  committed = await call(h, 'POST', '/commit', { previewId: forward.data.previewId, approvalCode: APPROVAL });
  assert.equal(committed.status, 200);
  assert.equal(cust(h, 'solo').notes, '先改備註');
  assert.equal(cust(h, 'won-1').policyName, '終身');

  const history = await call(h, 'GET', '/history');
  assert.equal(history.status, 200);
  assert.ok(history.data.commits.length >= 3);
  assert.ok(history.data.commits.every((row) => row.backupId && row.op));
  assert.ok(history.data.commits.some((row) => row.op === 'undo' && row.backupId));
  assert.equal(history.data.commits[0].at >= history.data.commits[1].at, true);
});

// ---------- 還原：之後有人改過 → 只反轉那一次 ----------
function webEdit(h, fn) {
  const doc = clone(state(h));
  fn(doc);
  doc._rev = (doc._rev || 0) + 1;
  h.db.docs.set(PATHS.state, doc);
}

async function botDo(h, body, now) {
  if (now) h.setNow(now);
  const p = await call(h, 'POST', '/preview', body);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const c = await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return c.data;
}

test('undo with no later change restores the whole doc and lists what it reverts', async () => {
  const h = harness();
  const done = await botDo(h, { op: 'appendContact', customerId: 'solo', date: '2026-10-17', method: '電話', content: '機器人紀錄' });
  const backup = h.db.docs.get(PATHS.backup(done.backupId));
  assert.equal(backup._backup.resultRev, 8);
  assert.ok(JSON.parse(backup._backup.changeSetJson).some((e) => e.t === 'row-add'));
  h.setNow(1800000001000);
  const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: done.backupId });
  assert.equal(p.status, 200);
  assert.equal(p.data.diff.mode, 'whole');
  assert.match(p.data.diff.text, /刪除「陳阿姨」這次新增的紀錄/);
  const c = await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
  assert.equal(c.status, 200);
  assert.equal(cust(h, 'solo').history.length, 0);
});

test('undo after a web change only removes the bot row and keeps the web edits', async () => {
  const h = harness();
  const done = await botDo(h, { op: 'appendContact', customerId: 'solo', date: '2026-10-17', method: '電話', content: '機器人紀錄' });
  webEdit(h, (doc) => {
    const solo = doc.cust.find((c) => c.id === 'solo');
    solo.history.push({ id: 'h-web1', date: '2026-10-17', content: '網頁新增', progress: 'KEY_VISIT', byEmail: 'owner@example.com', act: 'call' });
    solo.notes = '網頁改的備註';
    doc.cust.find((c) => c.id === 'won-1').policyName = '網頁改保單';
    doc.per.push({ id: 'p2', name: '十一月' });
  });
  h.setNow(1800000002000);
  const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: done.backupId });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.diff.mode, 'targeted');
  assert.match(p.data.diff.text, /刪除「陳阿姨」這次新增的紀錄：2026-10-17 電話 機器人紀錄/);
  assert.equal(p.data.diff.changes.length, 1);
  const c = await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const solo = cust(h, 'solo');
  assert.deepEqual(solo.history.map((r) => r.id), ['h-web1']);
  assert.equal(solo.history[0].byEmail, 'owner@example.com');
  assert.equal(solo.history[0].act, 'call');
  assert.equal(solo.notes, '網頁改的備註');
  assert.equal(cust(h, 'won-1').policyName, '網頁改保單');
  assert.equal(state(h).per.length, 2);
  assert.equal(state(h)._rev, 10);
});

test('undo refuses when the edited row was changed again on the web', async () => {
  const h = harness();
  const done = await botDo(h, { op: 'editContact', customerId: 'deal-1', contactId: 'h1', patch: { content: '機器人改的' } });
  webEdit(h, (doc) => {
    doc.cust.find((c) => c.id === 'deal-1').history.find((r) => r.id === 'h1').content = '網頁又改';
  });
  h.setNow(1800000002000);
  const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: done.backupId });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /之後又被修改過/);
  assert.equal(cust(h, 'deal-1').history.find((r) => r.id === 'h1').content, '網頁又改');
});

test('targeted undo restores an edited row, a deleted row, fields and next-contact dates', async () => {
  const h = harness();
  const e1 = await botDo(h, { op: 'editContact', customerId: 'deal-1', contactId: 'h1', patch: { content: '機器人改的', time: '10:00' } });
  const e2 = await botDo(h, { op: 'deleteContact', customerId: 'many', contactId: 'hm-3' }, 1800000001000);
  const e3 = await botDo(h, { op: 'setNextContact', customerId: 'deal-2', date: '2026-11-11' }, 1800000002000);
  const e4 = await botDo(h, { op: 'updateCustomer', customerId: 'solo', patch: { notes: '機器人備註', phone: '0900' } }, 1800000003000);
  webEdit(h, (doc) => { doc.cust.find((c) => c.id === 'won-1').notes = '網頁'; });
  const undo = async (id, now) => {
    h.setNow(now);
    const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: id });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.diff.mode, 'targeted');
    const c = await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    return p.data.diff;
  };
  await undo(e1.backupId, 1800000010000);
  const h1 = cust(h, 'deal-1').history.find((r) => r.id === 'h1');
  assert.equal(h1.content, '經營');
  assert.equal(h1.time, undefined);
  await undo(e2.backupId, 1800000011000);
  assert.deepEqual(cust(h, 'many').history.map((r) => r.id), ['hm-1', 'hm-2', 'hm-3', 'hm-4', 'hm-5', 'hm-6']);
  const d3 = await undo(e3.backupId, 1800000012000);
  assert.match(d3.text, /下次聯絡日/);
  for (const id of ['lead-1', 'deal-1', 'deal-2']) assert.equal(cust(h, id).nextContactDate, '2026-10-01');
  await undo(e4.backupId, 1800000013000);
  assert.equal(cust(h, 'solo').notes, undefined);
  assert.equal(cust(h, 'solo').phone, '0988-111-222');
  assert.equal(cust(h, 'won-1').notes, '網頁');
});

test('targeted undo re-inserts a deleted customer and handles legacy backups without a change list', async () => {
  const h = harness();
  const done = await botDo(h, { op: 'deleteCustomer', customerId: 'solo' });
  const bk = h.db.docs.get(PATHS.backup(done.backupId));
  delete bk._backup.changeSetJson;
  delete bk._backup.resultRev;
  webEdit(h, (doc) => { doc.cust.find((c) => c.id === 'won-1').notes = '網頁'; });
  h.setNow(1800000005000);
  const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: done.backupId });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.match(p.data.diff.text, /放回這次刪除的客戶「陳阿姨」/);
  const c = await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
  assert.equal(c.status, 200);
  assert.equal(state(h).cust[3].id, 'solo');
  assert.equal(cust(h, 'won-1').notes, '網頁');
});

test('undo of a created customer is refused once the web edited that customer', async () => {
  const h = harness();
  const done = await botDo(h, { op: 'createCustomer', customer: { name: '新人', progress: 'NURTURE' } });
  const id = state(h).cust.find((c) => c.name === '新人').id;
  webEdit(h, (doc) => { doc.cust.find((c) => c.id === id).history.push({ id: 'h-w', date: '2026-10-17', content: 'x', progress: 'NURTURE' }); });
  h.setNow(1800000005000);
  const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: done.backupId });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /新增之後又被修改過/);
});

test('fintrack undo is refused after a later fintrack change', async () => {
  const h = harness();
  const a = await botDo(h, { op: 'createFintrack', planId: 'plan-a', clientName: 'A', snap: { client: { name: 'A' } } });
  const b = await botDo(h, { op: 'updateFintrack', planId: 'plan-a', clientName: 'B' }, 1800000001000);
  await botDo(h, { op: 'updateFintrack', planId: 'plan-a', clientName: 'C' }, 1800000002000);
  h.setNow(1800000003000);
  const p = await call(h, 'POST', '/preview', { op: 'undo', backupId: b.backupId });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /又被修改過/);
  assert.ok(a.backupId);
});

test('deleting the last deal keeps optional row fields when copying history back to the lead', async () => {
  const data = book();
  const lead = data.cust.find((c) => c.id === 'lead-1');
  lead.coreIds = ['deal-2']; lead.coreId = 'deal-2';
  data.cust.find((c) => c.id === 'deal-1').leadId = '';
  data.cust.find((c) => c.id === 'deal-2').history.push({
    id: 'h-full', date: '2026-10-17', content: '完整欄位', progress: 'FIRST_VISIT', method: '面談', time: '09:30', endTime: '10:30',
    byEmail: 'owner@example.com', act: 'appt', cat: 'visit', visitType: '初訪', by: '林專員', src: 'aq'
  });
  const h = harness(data);
  await botDo(h, { op: 'deleteCustomer', customerId: 'deal-2' });
  const ct = cust(h, 'lead-1').contacts.find((r) => r.content === '完整欄位');
  assert.ok(ct);
  for (const [k, v] of Object.entries({ time: '09:30', endTime: '10:30', byEmail: 'owner@example.com', act: 'appt', cat: 'visit', visitType: '初訪', by: '林專員', src: 'aq', method: '面談' })) {
    assert.equal(ct[k], v, k);
  }
});

test('editContact clearing the time also drops endTime', async () => {
  const data = book();
  data.cust.find((c) => c.id === 'deal-1').history[0].time = '14:00';
  data.cust.find((c) => c.id === 'deal-1').history[0].endTime = '15:00';
  const h = harness(data);
  const p = await call(h, 'POST', '/preview', { op: 'editContact', customerId: 'deal-1', contactId: 'h1', patch: { time: '' } });
  assert.equal(p.status, 200);
  assert.match(p.data.diff.text, /14:00-15:00/);
  await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
  const row = cust(h, 'deal-1').history.find((r) => r.id === 'h1');
  assert.equal(row.time, undefined);
  assert.equal(row.endTime, undefined);
  assert.equal(row.content, '經營');
});

test('health shows a version without needing a key', async () => {
  const h = harness();
  const res = await handle(req('GET', '/health'), h.env, h.deps());
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.service, 'crm-bot-api');
  assert.match(data.version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

// ---------- 階段變更：和網頁一樣的副作用；byEmail / act ----------
const OWNER = 'shanewangmusic@gmail.com';

test('stage change writes the web-style stage row, clears planned fields and stamps byEmail/act', async () => {
  const data = book();
  const solo = data.cust.find((c) => c.id === 'solo');
  solo.plannedPolicyName = '預計A'; solo.csSupervisor = '主管';
  const h = harness(data);
  const p = await call(h, 'POST', '/preview', { op: 'updateCustomer', customerId: 'solo', patch: { stage: 'HOLD' }, byEmail: 'ShaneWangMusic@gmail.com', act: 'need' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.match(p.data.diff.text, /階段由「關鍵訪」改為「待定」/);
  await call(h, 'POST', '/commit', { previewId: p.data.previewId, approvalCode: APPROVAL });
  const c = cust(h, 'solo');
  assert.equal(c.progress, 'HOLD');
  assert.equal(c.category, 'NEW');
  assert.equal(c.lastStage, 'KEY_VISIT');
  assert.equal(c.plannedPolicyName, '');
  assert.equal(c.csSupervisor, '');
  const row = c.history[c.history.length - 1];
  assert.deepEqual(row, { id: 'h-1800000000000', date: '2027-01-15', content: '階段由「關鍵訪」改為「待定」', progress: 'HOLD', byEmail: OWNER, act: 'need' });
});

test('stage WON clears progress and the next-contact date across linked records', async () => {
  const h = harness();
  await botDo(h, { op: 'updateCustomer', customerId: 'deal-1', patch: { stage: 'WON', dealDate: '2026-10-17' } });
  const c = cust(h, 'deal-1');
  assert.equal(c.category, 'WON');
  assert.equal(c.progress, '');
  for (const id of ['lead-1', 'deal-1', 'deal-2']) assert.equal(cust(h, id).nextContactDate, '');
  const row = c.history[c.history.length - 1];
  assert.equal(row.content, '階段由「經營」改為「成交」');
  assert.equal(row.progress, 'WON');
  assert.equal(row.byEmail, undefined);
});

test('non-stage edits add no stage row; LEAD conversion and bad byEmail/act are refused', async () => {
  const h = harness();
  await botDo(h, { op: 'updateCustomer', customerId: 'solo', patch: { notes: '只改備註' } });
  assert.equal(cust(h, 'solo').history.length, 0);
  let p = await call(h, 'POST', '/preview', { op: 'updateCustomer', customerId: 'lead-plain', patch: { stage: 'NURTURE' } });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /CRM 網頁/);
  p = await call(h, 'POST', '/preview', { op: 'appendContact', customerId: 'solo', date: '2026-10-17', method: '電話', content: 'x', byEmail: 'someone@example.com' });
  assert.equal(p.status, 400);
  p = await call(h, 'POST', '/preview', { op: 'appendContact', customerId: 'solo', date: '2026-10-17', method: '電話', content: 'x', act: '約訪' });
  assert.equal(p.status, 400);
});

test('appendContact stamps byEmail and act on history and on lead contacts', async () => {
  const h = harness();
  await botDo(h, { op: 'appendContact', customerId: 'solo', date: '2026-10-17', method: '電話', content: '打電話', byEmail: OWNER, act: 'call' });
  const row = cust(h, 'solo').history[0];
  assert.equal(row.byEmail, OWNER);
  assert.equal(row.act, 'call');
  assert.match(row.id, /^h-\d+$/);
  await botDo(h, { op: 'appendContact', customerId: 'lead-plain', date: '2026-10-17', method: 'Line', content: '傳訊', byEmail: OWNER, act: 'appt' }, 1800000001000);
  const ct = cust(h, 'lead-plain').contacts.find((r) => r.content === '傳訊');
  assert.equal(ct.byEmail, OWNER);
  assert.equal(ct.act, 'appt');
  await botDo(h, { op: 'appendContact', customerId: 'many', date: '2026-10-17', method: '電話', content: '沒蓋章' }, 1800000002000);
  const plain = cust(h, 'many').history.find((r) => r.content === '沒蓋章');
  assert.equal(plain.byEmail, undefined);
  assert.equal(plain.act, undefined);
});
