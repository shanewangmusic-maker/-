import {
  DEFAULT_OWNER_EMAIL,
  PREVIEW_TTL_MS,
  applyOp,
  backupCopy,
  changeSetOf,
  cloudRev,
  envTrim,
  expireMillis,
  fintrackRevOf,
  isPlanId,
  isPreviewId,
  matchCustomer,
  normalizeOp,
  packFintrack,
  pathsFor,
  planFintrack,
  planQuestCounts,
  planQuestEvents,
  questEventDoc,
  planUndo,
  publicCustomer,
  randomSuffix,
  safeEqual,
  stable,
  teamIdFrom,
  unpackFintrack,
  withCustomers
} from './logic.js';
import { FirestoreError, createRestFirestore } from './firestore.js';

// 每次部署前改這一行，GET /health 就看得出線上是哪一版
export const VERSION = '2026-10-17.1';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-bot-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
}

function routeOf(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (p === '/health') return { name: 'health' };
  if (p === '/customers') return { name: 'list' };
  if (p === '/history') return { name: 'history' };
  if (p === '/preview') return { name: 'preview' };
  if (p === '/commit') return { name: 'commit' };
  const fin = /^\/fintrack\/([^/]+)$/.exec(p);
  if (fin) return { name: 'fintrack', id: decodeURIComponent(fin[1]) };
  const m = /^\/customers\/([^/]+)$/.exec(p);
  if (m) return { name: 'one', id: decodeURIComponent(m[1]) };
  return { name: 'unknown', path: p };
}

function botFrom(request, env) {
  const header = request.headers.get('x-bot-key');
  const auth = request.headers.get('authorization') || '';
  let token = header ? header.trim() : '';
  if (!token && /^Bearer\s+/i.test(auth)) token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: '請在 Authorization: Bearer 或 X-Bot-Key 帶入這個機器人的金鑰', status: 401 };
  let map;
  try { map = JSON.parse(envTrim(env.BOT_KEYS)); } catch (_) { return { error: 'BOT_KEYS 不是合法的 JSON', status: 500 }; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { error: 'BOT_KEYS 必須是 {"機器人名字":"金鑰"}', status: 500 };
  const names = Object.keys(map);
  for (let i = 0; i < names.length; i++) {
    if (safeEqual(token, envTrim(map[names[i]]))) return { name: String(names[i]) };
  }
  return { error: '金鑰不正確', status: 401 };
}

function requireTeam(env) {
  const teamId = teamIdFrom(env);
  if (!teamId) return { error: '尚未設定 TEAM_ID', status: 500 };
  if (!/^[A-Z0-9._-]{1,64}$/.test(teamId)) {
    return { error: 'TEAM_ID 只接受英文、數字、底線、點、減號', status: 500 };
  }
  return { teamId, paths: pathsFor(teamId) };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 800000) return { error: '內容太長', status: 413 };
  if (!text) return { error: '請提供 JSON', status: 400 };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '請提供 JSON 物件', status: 400 };
    return { body };
  } catch (_) {
    return { error: 'JSON 格式不正確', status: 400 };
  }
}

function customersOf(doc) {
  return doc && Array.isArray(doc.cust) ? doc.cust : [];
}

async function listCustomers(url, db, paths) {
  const doc = await db.getDoc(paths.state);
  if (!doc) return json({ error: '找不到這個團隊的資料' }, 404);
  const nameQ = (url.searchParams.get('name') || '').trim().toLowerCase();
  const phoneQ = (url.searchParams.get('phone') || '').replace(/\D/g, '');
  const list = customersOf(doc).filter((c) => c && c.id && matchCustomer(c, nameQ, phoneQ));
  return json({
    ok: true,
    customers: list.map((c) => publicCustomer(customersOf(doc), c, 5))
  });
}

async function oneCustomer(id, db, paths) {
  const doc = await db.getDoc(paths.state);
  if (!doc) return json({ error: '找不到這個團隊的資料' }, 404);
  const list = customersOf(doc);
  const c = list.find((x) => x && x.id === id);
  if (!c) return json({ error: '找不到這位客戶' }, 404);
  return json({ ok: true, customer: publicCustomer(list, c, null) });
}

async function oneFintrack(id, db, paths) {
  if (!isPlanId(id)) return json({ error: 'planId 不正確' }, 400);
  const doc = await db.getDoc(paths.fintrack(id));
  if (!doc) return json({ error: '找不到這份財務規劃' }, 404);
  return json({ ok: true, planId: id, plan: unpackFintrack(doc) });
}

async function listHistory(url, db, paths) {
  const limitRaw = Number(url.searchParams.get('limit') || 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 20));
  if (!db.listDocs) return json({ error: '無法列出操作紀錄' }, 500);
  const rows = await db.listDocs(paths.auditCollection);
  const commits = rows.filter((row) => row && row.op).map((row) => ({
    id: row.id || '',
    at: row.at || '',
    botName: row.botName || '',
    op: row.op || '',
    previewId: row.previewId || '',
    customerId: row.customerId || '',
    planId: row.planId || '',
    backupId: row.backupId || '',
    baseRev: row.baseRev,
    newRev: row.newRev,
    summary: row.summary || ''
  }));
  commits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return json({ ok: true, commits: commits.slice(0, limit) });
}

async function buildPreview(norm, db, paths, deps) {
  const now = deps.now();
  const idSource = { now, suffix: deps.random() };
  if (norm.scope === 'fintrack') {
    const team = await db.getDoc(paths.state);
    if (!team) return { error: '找不到這個團隊的資料', status: 404 };
    const existing = await db.getDoc(paths.fintrack(norm.request.planId));
    const applied = planFintrack(existing, norm.request, paths.teamId, norm.op === 'createFintrack');
    if (applied.error) return { error: applied.error, status: 400 };
    return { applied, idSource, baseRev: applied.baseRev, planId: norm.request.planId };
  }
  if (norm.scope === 'quest') {
    const cfg = questConfigOf(deps.env || {});
    if (!cfg.enabled) return { error: cfg.reason, status: 409 };
    const applied = planQuestCounts(norm.request, idSource);
    return { applied, idSource, baseRev: 0 };
  }
  if (norm.scope === 'undo') {
    const backup = await db.getDoc(paths.backup(norm.request.backupId));
    if (!backup) return { error: '找不到這份備份', status: 404 };
    const meta = backup._backup || {};
    const kind = meta.kind || (Array.isArray(backup.cust) ? 'global_state' : 'fintrack');
    const current = kind === 'fintrack'
      ? await db.getDoc(paths.fintrack(meta.planId || ''))
      : await db.getDoc(paths.state);
    if (!current) return { error: '找不到要還原的資料', status: 404 };
    const legacy = kind === 'global_state' && meta.previewId && isPreviewId(meta.previewId)
      ? await db.getDoc(paths.preview(meta.previewId))
      : null;
    const applied = planUndo(backup, current, kind, legacy);
    if (applied.error) return { error: applied.error, status: 400 };
    return { applied, idSource, baseRev: applied.baseRev, planId: applied.planId || '', undoKind: kind, backupId: norm.request.backupId };
  }
  const doc = await db.getDoc(paths.state);
  if (!doc) return { error: '找不到這個團隊的資料', status: 404 };
  const applied = applyOp(doc, norm.op, norm.request, idSource);
  if (applied.error) return { error: applied.error, status: 400 };
  return { applied, idSource, baseRev: cloudRev(doc) };
}

// 行動闖關寫入設定：要等 Firestore 規則允許 crmbot 寫入擁有者的 auto，才把 QUEST_AUTO_WRITE 設成 1
export function questConfigOf(env) {
  const uid = envTrim(env && env.QUEST_OWNER_UID);
  if (envTrim(env && env.QUEST_AUTO_WRITE) !== '1') {
    return { enabled: false, reason: '行動闖關寫入尚未開啟（需要先更新 Firestore 規則，再設定 QUEST_OWNER_UID 與 QUEST_AUTO_WRITE=1）' };
  }
  if (!/^[A-Za-z0-9]{6,128}$/.test(uid)) return { enabled: false, reason: 'QUEST_OWNER_UID 沒有設定或格式不對' };
  return { enabled: true, uid };
}

// CRM 已經寫好之後才做，失敗也不影響 CRM；同一個事件編號只會建立一次
async function writeQuestEvents(db, cfg, paths, events, jobs, now, previewId) {
  if (!cfg.enabled) return { written: [], skipped: [], disabled: cfg.reason };
  if (!db.createDoc) return { written: [], skipped: [], error: '無法寫入行動闖關' };
  let seen = [];
  let note = '';
  try { seen = db.listDocs ? await db.listDocs(paths.questAutoCollection(cfg.uid)) : []; }
  catch (_) { seen = []; note = '讀不到已計過的事件，只用事件編號去重'; }
  const planned = [];
  (events || []).forEach((e) => planned.push(e));
  (jobs || []).forEach((job) => {
    planQuestEvents(job, seen.concat(planned)).forEach((e) => planned.push(e));
  });
  const written = [];
  const skipped = [];
  try {
    for (const ev of planned) {
      const r = await db.createDoc(paths.questAuto(cfg.uid, ev.id), questEventDoc(ev, cfg.uid, paths.teamId, now, previewId));
      (r && r.created === false ? skipped : written).push(ev.id);
    }
  } catch (e) {
    return { written, skipped, error: '行動闖關寫入失敗（CRM 已經寫好）：' + (e && e.message ? e.message : e), note };
  }
  const out = { written, skipped };
  if (note) out.note = note;
  return out;
}

function ownerEmailsOf(env) {
  const raw = envTrim(env && env.QUEST_OWNER_EMAIL) || DEFAULT_OWNER_EMAIL;
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

async function preview(request, env, db, paths, bot, deps) {
  const parsed = await readJson(request);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const norm = normalizeOp(parsed.body, { ownerEmails: ownerEmailsOf(env) });
  if (norm.error) return json({ error: norm.error }, 400);
  const built = await buildPreview(norm, db, paths, Object.assign({ env }, deps));
  if (built.error) return json({ error: built.error }, built.status);
  const previewId = 'pv-' + built.idSource.now + '-' + built.idSource.suffix;
  const expires = new Date(built.idSource.now + PREVIEW_TTL_MS).toISOString();
  const pending = {
    previewId,
    teamId: paths.teamId,
    botName: bot.name,
    op: norm.op,
    target: built.applied.target || 'state',
    request: norm.request,
    idSource: built.idSource,
    baseRev: built.baseRev,
    diff: built.applied.diff,
    status: 'pending',
    createdAt: new Date(built.idSource.now).toISOString(),
    expireAt: { __timestamp: expires }
  };
  if (built.planId) pending.planId = built.planId;
  if (built.backupId) pending.backupId = built.backupId;
  if (built.undoKind) pending.undoKind = built.undoKind;
  await db.setDoc(paths.preview(previewId), pending);
  const body = {
    ok: true,
    previewId,
    baseRev: pending.baseRev,
    diff: built.applied.diff,
    expiresAt: expires
  };
  return json(body);
}

function commitBody(previewId, pending, newRev, backupId, auditId, diff) {
  return { ok: true, previewId, baseRev: pending.baseRev, newRev, backupId, auditId, diff };
}

function writeCommit(tx, paths, item) {
  const extraMeta = { resultRev: item.newRev };
  if (item.backupMeta.kind === 'global_state') {
    // 記下這次到底改了什麼，之後就算別人又改過，也能只還原這一次
    extraMeta.changeSetJson = JSON.stringify(changeSetOf(item.backupDoc, item.nextDoc));
  }
  if (item.questEventIds && item.questEventIds.length) extraMeta.questEventIds = item.questEventIds;
  tx.set(paths.backup(item.backupId), backupCopy(item.backupDoc, Object.assign(extraMeta, {
    at: new Date(item.now).toISOString(),
    previewId: item.previewId,
    botName: item.bot.name,
    op: item.pending.op,
    teamId: paths.teamId
  }, item.backupMeta)));
  tx.set(item.nextPath, item.nextDoc);
  tx.set(paths.audit(item.auditId), {
    at: new Date(item.now).toISOString(),
    teamId: paths.teamId,
    botName: item.bot.name,
    op: item.pending.op,
    previewId: item.previewId,
    customerId: item.customerId || '',
    planId: item.backupMeta.planId || '',
    backupId: item.backupId,
    baseRev: item.pending.baseRev,
    newRev: item.newRev,
    summary: item.pending.diff.summary,
    diff: item.pending.diff
  });
  tx.set(paths.preview(item.previewId), Object.assign({}, item.pending, {
    status: 'committed',
    committedAt: new Date(item.now).toISOString(),
    backupId: item.backupId,
    auditId: item.auditId
  }));
}

async function commitFintrack(tx, paths, pending, bot, deps, now, previewId) {
  const current = await tx.get(paths.fintrack(pending.planId));
  const creating = pending.op === 'createFintrack';
  if (creating && current) return { abort: true, status: 409, error: '這份財務規劃剛被建立，請重新預覽' };
  if (!creating && !current) return { abort: true, status: 404, error: '找不到這份財務規劃' };
  if (!creating && fintrackRevOf(current) !== pending.baseRev) {
    return { abort: true, status: 409, error: '財務規劃剛被別人更新，這份預覽已作廢。請重新預覽。' };
  }
  const applied = planFintrack(current, pending.request, paths.teamId, creating);
  if (applied.error) return { abort: true, status: 409, error: applied.error };
  if (stable(applied.diff) !== stable(pending.diff)) {
    return { abort: true, status: 409, error: '預覽時的差異和現在不一致，已取消寫入' };
  }
  const backupId = 'bk-' + now + '-' + deps.random();
  const auditId = 'au-' + now + '-' + deps.random();
  const next = applied.doc;
  next.rev = (creating ? 0 : fintrackRevOf(current)) + 1;
  next.updatedAt = now;
  const packed = packFintrack(next);
  if (packed.error) return { abort: true, status: 400, error: packed.error };
  writeCommit(tx, paths, {
    backupId, auditId, previewId, bot, pending, now,
    backupDoc: current || { planId: pending.planId, existed: false },
    backupMeta: { kind: 'fintrack', planId: pending.planId },
    nextPath: paths.fintrack(pending.planId),
    nextDoc: packed.doc,
    newRev: packed.doc.rev,
    customerId: pending.planId
  });
  return { body: commitBody(previewId, pending, packed.doc.rev, backupId, auditId, applied.diff) };
}

async function commitUndo(tx, paths, pending, bot, deps, now, previewId) {
  const backup = await tx.get(paths.backup(pending.backupId));
  if (!backup) return { abort: true, status: 404, error: '找不到這份備份' };
  const kind = pending.undoKind || ((backup._backup && backup._backup.kind) || (Array.isArray(backup.cust) ? 'global_state' : 'fintrack'));
  const planId = pending.planId || (backup._backup && backup._backup.planId) || '';
  const current = kind === 'fintrack' ? await tx.get(paths.fintrack(planId)) : await tx.get(paths.state);
  if (!current) return { abort: true, status: 404, error: '找不到要還原的資料' };
  const currentRev = kind === 'fintrack' ? fintrackRevOf(current) : cloudRev(current);
  if (currentRev !== pending.baseRev) {
    return { abort: true, status: 409, error: '資料剛被別人更新，這份還原已作廢。請重新預覽。' };
  }
  const bmeta = backup._backup || {};
  const legacy = kind === 'global_state' && bmeta.previewId && isPreviewId(bmeta.previewId)
    ? await tx.get(paths.preview(bmeta.previewId))
    : null;
  const applied = planUndo(backup, current, kind, legacy);
  if (applied.error) return { abort: true, status: 409, error: applied.error };
  if (stable(applied.diff) !== stable(pending.diff)) {
    return { abort: true, status: 409, error: '預覽時的差異和現在不一致，已取消寫入' };
  }
  const backupId = 'bk-' + now + '-' + deps.random();
  const auditId = 'au-' + now + '-' + deps.random();
  const restored = applied.snapshot;
  let nextPath = paths.state;
  let newRev = currentRev + 1;
  if (kind === 'fintrack') {
    restored.rev = newRev;
    restored.updatedAt = now;
    nextPath = paths.fintrack(planId);
    const packed = packFintrack(restored);
    if (packed.error) return { abort: true, status: 400, error: packed.error };
    writeCommit(tx, paths, {
      backupId, auditId, previewId, bot, pending, now,
      backupDoc: current,
      backupMeta: { kind: 'fintrack', planId },
      nextPath,
      nextDoc: packed.doc,
      newRev,
      customerId: planId
    });
  } else if (applied.mode === 'targeted') {
    const next = withCustomers(current, applied.customers, now);
    Object.keys(applied.docPatch || {}).forEach((key) => {
      const p = applied.docPatch[key];
      if (p.remove) delete next[key]; else next[key] = p.set;
    });
    newRev = next._rev;
    writeCommit(tx, paths, {
      backupId, auditId, previewId, bot, pending, now,
      backupDoc: current,
      backupMeta: { kind: 'global_state' },
      nextPath,
      nextDoc: next,
      newRev,
      customerId: ''
    });
  } else {
    restored._rev = newRev;
    restored._updatedAt = now;
    writeCommit(tx, paths, {
      backupId, auditId, previewId, bot, pending, now,
      backupDoc: current,
      backupMeta: { kind: 'global_state' },
      nextPath,
      nextDoc: restored,
      newRev,
      customerId: ''
    });
  }
  return { body: commitBody(previewId, pending, newRev, backupId, auditId, applied.diff) };
}

async function commitQuest(tx, paths, pending, bot, deps, now, previewId, cfg) {
  if (!cfg.enabled) return { abort: true, status: 409, error: cfg.reason };
  const applied = planQuestCounts(pending.request, pending.idSource);
  if (stable(applied.diff) !== stable(pending.diff)) {
    return { abort: true, status: 409, error: '預覽時的差異和現在不一致，已取消寫入' };
  }
  const auditId = 'au-' + now + '-' + deps.random();
  tx.set(paths.audit(auditId), {
    at: new Date(now).toISOString(), teamId: paths.teamId, botName: bot.name, op: pending.op,
    previewId, customerId: '', planId: '', backupId: '', baseRev: 0, newRev: 0,
    summary: pending.diff.summary, diff: pending.diff
  });
  tx.set(paths.preview(previewId), Object.assign({}, pending, { status: 'committed', committedAt: new Date(now).toISOString(), auditId }));
  return { body: { ok: true, previewId, auditId, diff: applied.diff }, questEvents: applied.events };
}

async function commit(request, env, db, paths, bot, deps) {
  const secret = envTrim(env.APPROVAL_SECRET);
  if (!secret) return json({ error: '尚未設定 APPROVAL_SECRET' }, 500);
  const parsed = await readJson(request);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const previewId = String(parsed.body.previewId || '');
  if (!isPreviewId(previewId)) return json({ error: 'previewId 不正確' }, 400);
  if (!safeEqual(parsed.body.approvalCode, secret)) {
    return json({ error: '確認碼不正確。機器人的金鑰不能代替擁有者確認。' }, 403);
  }
  const now = deps.now();
  const result = await db.runTransaction(async (tx) => {
    const pending = await tx.get(paths.preview(previewId));
    if (!pending || pending.status !== 'pending' || pending.teamId !== paths.teamId) {
      return { abort: true, status: 404, error: '找不到這份待確認的預覽，或已經用過' };
    }
    if (expireMillis(pending) <= now) {
      return { abort: true, status: 410, error: '這份預覽已過期，請重新預覽' };
    }
    const target = pending.target || 'state';
    if (target === 'fintrack') return commitFintrack(tx, paths, pending, bot, deps, now, previewId);
    if (target === 'undo') return commitUndo(tx, paths, pending, bot, deps, now, previewId);
    if (target === 'quest') return commitQuest(tx, paths, pending, bot, deps, now, previewId, questConfigOf(env));
    const doc = await tx.get(paths.state);
    if (!doc) return { abort: true, status: 404, error: '找不到這個團隊的資料' };
    if (cloudRev(doc) !== pending.baseRev) {
      return { abort: true, status: 409, error: '資料剛被別人更新，這份預覽已作廢。請重新預覽。' };
    }
    const applied = applyOp(doc, pending.op, pending.request, pending.idSource);
    if (applied.error) return { abort: true, status: 409, error: applied.error };
    if (stable(applied.diff) !== stable(pending.diff)) {
      return { abort: true, status: 409, error: '預覽時的差異和現在不一致，已取消寫入' };
    }
    const backupId = 'bk-' + now + '-' + deps.random();
    const auditId = 'au-' + now + '-' + deps.random();
    const next = withCustomers(doc, applied.customers, now);
    const customerId = pending.request.customerId || (applied.diff.changes[0] && applied.diff.changes[0].customerId) || '';
    writeCommit(tx, paths, {
      backupId, auditId, previewId, bot, pending, now,
      backupDoc: doc,
      backupMeta: { kind: 'global_state' },
      nextPath: paths.state,
      nextDoc: next,
      newRev: next._rev,
      customerId
    });
    return { body: commitBody(previewId, pending, next._rev, backupId, auditId, applied.diff), questJobs: applied.questJobs || [] };
  });
  if (result && result.abort) return json({ error: result.error }, result.status);
  if ((result.questJobs && result.questJobs.length) || (result.questEvents && result.questEvents.length)) {
    result.body.quest = await writeQuestEvents(db, questConfigOf(env), paths, result.questEvents || [], result.questJobs || [], now, previewId);
  }
  return json(result.body);
}

export async function handle(request, env, deps) {
  const extra = deps || {};
  const url = new URL(request.url);
  const route = routeOf(url.pathname);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (route.name === 'health' && request.method === 'GET') {
    return json({ ok: true, service: 'crm-bot-api', version: VERSION });
  }
  if (request.method === 'DELETE') return json({ error: '不提供刪除' }, 405);
  try {
    const team = requireTeam(env || {});
    if (team.error) return json({ error: team.error }, team.status);
    const bot = botFrom(request, env || {});
    if (bot.error) return json({ error: bot.error }, bot.status);
    const db = extra.db || createRestFirestore(env);
    const clock = {
      now: extra.now || (() => Date.now()),
      random: extra.random || randomSuffix
    };
    if (route.name === 'list' && request.method === 'GET') return await listCustomers(url, db, team.paths);
    if (route.name === 'one' && request.method === 'GET') return await oneCustomer(route.id, db, team.paths);
    if (route.name === 'fintrack' && request.method === 'GET') return await oneFintrack(route.id, db, team.paths);
    if (route.name === 'history' && request.method === 'GET') return await listHistory(url, db, team.paths);
    if (route.name === 'preview' && request.method === 'POST') return await preview(request, env || {}, db, Object.assign({ teamId: team.teamId }, team.paths), bot, clock);
    if (route.name === 'commit' && request.method === 'POST') return await commit(request, env, db, Object.assign({ teamId: team.teamId }, team.paths), bot, clock);
    if (route.name === 'unknown') return json({ error: '找不到這個網址' }, 404);
    return json({ error: '這個網址不接受此方法' }, 405);
  } catch (e) {
    const status = e && e.statusCode ? e.statusCode : 502;
    const message = e instanceof FirestoreError ? '雲端讀寫失敗' : (e && e.message ? e.message : '處理失敗');
    return json({ error: message }, status >= 400 && status < 600 ? status : 502);
  }
}

export default {
  fetch(request, env) {
    return handle(request, env);
  }
};
