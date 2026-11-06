// Firebase Auth 電子郵件登入 + Firestore REST。
// 金鑰只從環境變數讀，不寫進檔案。

import { envTrim } from './logic.js';

export class FirestoreError extends Error {
  constructor(message, httpStatus, code) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code || '';
  }
}

let authCache = { key: '', token: '', exp: 0 };

export function resetAuthCache() {
  authCache = { key: '', token: '', exp: 0 };
}

export function encodeValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('無法儲存的數字');
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    if (typeof v.__timestamp === 'string' && Object.keys(v).length === 1) {
      return { timestampValue: v.__timestamp };
    }
    return { mapValue: { fields: encodeFields(v) } };
  }
  throw new Error('無法儲存的欄位型別');
}

export function encodeFields(obj) {
  const fields = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fields;
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    fields[k] = encodeValue(obj[k]);
  }
  return fields;
}

export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('integerValue' in v) {
    const n = Number(v.integerValue);
    if (!Number.isSafeInteger(n)) throw new Error('雲端數字超出安全範圍');
    return n;
  }
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return { __timestamp: v.timestampValue };
  if ('mapValue' in v) return decodeFields((v.mapValue && v.mapValue.fields) || {});
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeValue);
  throw new Error('雲端資料含有這支程式不支援的型別，已停止以免寫壞其他欄位');
}

export function decodeFields(fields) {
  const obj = {};
  if (!fields || typeof fields !== 'object') return obj;
  for (const k of Object.keys(fields)) obj[k] = decodeValue(fields[k]);
  return obj;
}

function documentName(projectId, path) {
  return 'projects/' + projectId + '/databases/(default)/documents/' + path;
}

function rootUrl(projectId) {
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/databases/(default)/documents';
}

function docUrl(projectId, path, query) {
  const segs = String(path || '').split('/').map(encodeURIComponent).join('/');
  const url = rootUrl(projectId) + '/' + segs;
  if (!query) return url;
  return url + '?' + new URLSearchParams(query).toString();
}

function writeOf(projectId, path, data) {
  return {
    update: {
      name: documentName(projectId, path),
      fields: encodeFields(data)
    }
  };
}

export function createRestFirestore(env, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const projectId = envTrim(env && env.FIREBASE_PROJECT_ID) || 'fish-teem';
  const apiKey = envTrim(env && env.FIREBASE_API_KEY);
  const email = envTrim(env && env.BOT_EMAIL);
  const password = envTrim(env && env.BOT_PASSWORD);
  if (!apiKey || !email || !password) {
    const err = new Error('缺少 FIREBASE_API_KEY、BOT_EMAIL 或 BOT_PASSWORD');
    err.statusCode = 500;
    throw err;
  }

  async function idToken() {
    const key = email + '\n' + apiKey;
    const now = Date.now();
    if (authCache.key === key && authCache.token && authCache.exp > now + 60000) return authCache.token;
    const res = await fetchFn(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    const body = await readBody(res);
    if (!res.ok || !body.idToken) {
      const message = (body.error && body.error.message) || 'Firebase 登入失敗';
      throw new FirestoreError(message, res.status, 'UNAUTHENTICATED');
    }
    const sec = Number(body.expiresIn || 3600);
    authCache = { key, token: body.idToken, exp: now + sec * 1000 };
    return body.idToken;
  }

  async function call(url, options) {
    const token = await idToken();
    const res = await fetchFn(url, {
      method: options.method || 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json'
      },
      body: options.body
    });
    const body = await readBody(res);
    if (!res.ok) {
      const status = body.error && (body.error.status || '');
      const message = (body.error && body.error.message) || ('HTTP ' + res.status);
      throw new FirestoreError(message, res.status, status);
    }
    return body;
  }

  async function readPlain(path, tx) {
    const query = tx ? { transaction: tx } : null;
    try {
      const body = await call(docUrl(projectId, path, query), { method: 'GET' });
      return decodeFields(body.fields || {});
    } catch (e) {
      if (e instanceof FirestoreError && e.httpStatus === 404) return null;
      throw e;
    }
  }

  return {
    async getDoc(path) {
      return readPlain(path);
    },
    async listDocs(collectionPath) {
      const out = [];
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        const query = { pageSize: '100' };
        if (pageToken) query.pageToken = pageToken;
        let body;
        try {
          body = await call(docUrl(projectId, collectionPath, query), { method: 'GET' });
        } catch (e) {
          if (e instanceof FirestoreError && e.httpStatus === 404) return out;
          throw e;
        }
        const docs = Array.isArray(body.documents) ? body.documents : [];
        docs.forEach((doc) => {
          const id = String(doc.name || '').split('/').pop();
          out.push(Object.assign(decodeFields(doc.fields || {}), { id }));
        });
        pageToken = body.nextPageToken || '';
        if (!pageToken) break;
      }
      return out;
    },
    // 只新增：文件已存在就不寫（回傳 created:false），用來做闖關事件的去重
    async createDoc(path, data) {
      const w = writeOf(projectId, path, data);
      w.currentDocument = { exists: false };
      try {
        await call(rootUrl(projectId) + ':commit', { method: 'POST', body: JSON.stringify({ writes: [w] }) });
        return { created: true };
      } catch (e) {
        if (e instanceof FirestoreError && (e.code === 'ALREADY_EXISTS' || e.code === 'FAILED_PRECONDITION')) return { created: false };
        throw e;
      }
    },
    async setDoc(path, data) {
      await call(rootUrl(projectId) + ':commit', {
        method: 'POST',
        body: JSON.stringify({ writes: [writeOf(projectId, path, data)] })
      });
    },
    async runTransaction(fn) {
      // 不用 beginTransaction（用一般登入帳號會被雲端拒絕）；改成讀取時記住版本，寫入時要求版本沒變，效果一樣安全
      let last = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const seen = new Map();
        try {
          const staged = [];
          const result = await fn({
            get: async (path) => {
              try {
                const body = await call(docUrl(projectId, path, null), { method: 'GET' });
                seen.set(path, body.updateTime || null);
                return decodeFields(body.fields || {});
              } catch (e) {
                if (e instanceof FirestoreError && e.httpStatus === 404) { seen.set(path, false); return null; }
                throw e;
              }
            },
            set: (path, data) => { staged.push({ path, w: writeOf(projectId, path, data) }); }
          });
          if (result && result.abort) return result;
          const writes = staged.map(({ path, w }) => {
            if (seen.has(path)) {
              const t = seen.get(path);
              w.currentDocument = t ? { updateTime: t } : { exists: false };
            }
            return w;
          });
          await call(rootUrl(projectId) + ':commit', { method: 'POST', body: JSON.stringify({ writes }) });
          return result;
        } catch (e) {
          last = e;
          const conflict = e instanceof FirestoreError && (e.code === 'ABORTED' || e.code === 'FAILED_PRECONDITION');
          if (conflict && attempt < 4) continue;
          throw e;
        }
      }
      throw last || new FirestoreError('雲端交易失敗', 503, 'ABORTED');
    }
  };
}

async function rollback(call, projectId, tx) {
  await call(rootUrl(projectId) + ':rollback', {
    method: 'POST',
    body: JSON.stringify({ transaction: tx })
  });
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}
