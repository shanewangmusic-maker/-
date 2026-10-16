import {
  PREVIEW_TTL_MS,
  applyOp,
  backupCopy,
  cloudRev,
  contactRecords,
  envTrim,
  expireMillis,
  isPreviewId,
  matchCustomer,
  normalizeOp,
  pathsFor,
  publicCustomer,
  randomSuffix,
  safeEqual,
  stable,
  teamIdFrom,
  withCustomers
} from './logic.js';
import { FirestoreError, createRestFirestore } from './firestore.js';

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
  if (p === '/preview') return { name: 'preview' };
  if (p === '/commit') return { name: 'commit' };
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
  if (text.length > 20000) return { error: '內容太長', status: 413 };
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

async function preview(request, db, paths, bot, deps) {
  const parsed = await readJson(request);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const norm = normalizeOp(parsed.body);
  if (norm.error) return json({ error: norm.error }, 400);
  const doc = await db.getDoc(paths.state);
  if (!doc) return json({ error: '找不到這個團隊的資料' }, 404);
  const now = deps.now();
  const idSource = { now, suffix: deps.random() };
  const applied = applyOp(doc, norm.op, norm.request, idSource);
  if (applied.error) return json({ error: applied.error }, 400);
  const previewId = 'pv-' + now + '-' + idSource.suffix;
  const expires = new Date(now + PREVIEW_TTL_MS).toISOString();
  const pending = {
    previewId,
    teamId: paths.teamId,
    botName: bot.name,
    op: norm.op,
    request: norm.request,
    idSource,
    baseRev: cloudRev(doc),
    diff: applied.diff,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expireAt: { __timestamp: expires }
  };
  await db.setDoc(paths.preview(previewId), pending);
  return json({
    ok: true,
    previewId,
    baseRev: pending.baseRev,
    diff: applied.diff,
    expiresAt: expires
  });
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
    const doc = await tx.get(paths.state);
    if (!pending || pending.status !== 'pending' || pending.teamId !== paths.teamId) {
      return { abort: true, status: 404, error: '找不到這份待確認的預覽，或已經用過' };
    }
    if (expireMillis(pending) <= now) {
      return { abort: true, status: 410, error: '這份預覽已過期，請重新預覽' };
    }
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
    tx.set(paths.backup(backupId), backupCopy(doc, {
      at: new Date(now).toISOString(),
      previewId,
      botName: bot.name,
      op: pending.op,
      teamId: paths.teamId
    }));
    tx.set(paths.state, next);
    tx.set(paths.audit(auditId), {
      at: new Date(now).toISOString(),
      teamId: paths.teamId,
      botName: bot.name,
      op: pending.op,
      previewId,
      customerId: pending.request.customerId,
      baseRev: pending.baseRev,
      newRev: next._rev,
      summary: applied.diff.summary,
      diff: applied.diff
    });
    tx.set(paths.preview(previewId), Object.assign({}, pending, {
      status: 'committed',
      committedAt: new Date(now).toISOString(),
      backupId,
      auditId
    }));
    return {
      body: {
        ok: true,
        previewId,
        baseRev: pending.baseRev,
        newRev: next._rev,
        backupId,
        auditId,
        diff: applied.diff
      }
    };
  });
  if (result && result.abort) return json({ error: result.error }, result.status);
  return json(result.body);
}

export async function handle(request, env, deps) {
  const extra = deps || {};
  const url = new URL(request.url);
  const route = routeOf(url.pathname);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (route.name === 'health' && request.method === 'GET') {
    return json({ ok: true, service: 'crm-bot-api' });
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
    if (route.name === 'preview' && request.method === 'POST') return await preview(request, db, Object.assign({ teamId: team.teamId }, team.paths), bot, clock);
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
