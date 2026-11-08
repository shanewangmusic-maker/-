/* 團隊成員與財務規劃的畫面權限。
   這是純函式，不連 Firebase。Firestore 規則仍須在主控台另行對齊，此檔不能代替後端。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CrmAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var OWNER_EMAIL = 'shanewangmusic@gmail.com';

  function normEmail(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }
  function memberList(members) {
    return Array.isArray(members) ? members : [];
  }
  function findMemberByEmail(members, email) {
    var e = normEmail(email);
    if (!e) return null;
    var list = memberList(members);
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m && normEmail(m.email) === e) return m;
    }
    return null;
  }

  /* 已登入、但不在名單，或名單沒有任何非空白 Email：不是管理者。
     尚未取得登入 Email 也不是管理者。擁有者常數與勾選 admin 的成員仍是。 */
  function isCrmAdmin(email, members, ownerEmail) {
    var e = normEmail(email);
    if (!e) return false;
    if (e === normEmail(ownerEmail || OWNER_EMAIL)) return true;
    var member = findMemberByEmail(members, e);
    return !!(member && member.admin === true);
  }

  function canAccessClient(email, client, members, ownerEmail) {
    email = normEmail(email);
    if (!email || !client || typeof client !== 'object') return { ok: false, reason: 'missing', role: '', agentName: '' };
    var agentName = String(client.agentName || '').trim();
    var member = findMemberByEmail(members, email);
    if (isCrmAdmin(email, members, ownerEmail)) {
      return { ok: true, role: 'owner', reason: 'owner', agentName: agentName };
    }
    if (!member) return { ok: false, reason: 'personal', role: '', agentName: agentName };
    if (!agentName || String(member.name || '').trim() === agentName) {
      return { ok: true, role: 'agent', reason: 'agent', agentName: agentName };
    }
    return { ok: false, reason: 'not-agent', role: '', agentName: agentName };
  }

  /* planKnown:true 表示呼叫端已經讀過 requested 那份文件（沒有則 planDoc 為 null）。
     還沒讀過時，只依 CRM 決定要不要讀，避免一般成員先把未授權的文件抓下來。 */
  function selectPlanTarget(opts) {
    opts = opts || {};
    var clickedId = String(opts.clickedId || '');
    var requested = String(opts.requestedPlan || clickedId);
    var clicked = canAccessClient(opts.email, opts.clickedClient, opts.members, opts.ownerEmail);
    if (!clicked.ok) {
      return { ok: false, reason: clicked.reason, role: '', planId: '', existing: null, needsLoad: false };
    }
    if (!requested || requested === clickedId) {
      var own = opts.ownDoc || null;
      return { ok: true, reason: 'same-plan', role: clicked.role, planId: clickedId, existing: own, needsLoad: !own && opts.ownKnown !== true };
    }
    var planKnown = opts.planKnown === true || (opts.planKnown !== false && !!opts.planDoc);
    if (clicked.role === 'owner') {
      if (!planKnown) {
        return { ok: true, reason: 'owner-cross', role: 'owner', planId: requested, existing: null, needsLoad: true };
      }
      if (opts.planDoc) {
        return { ok: true, reason: 'owner-cross', role: 'owner', planId: requested, existing: opts.planDoc, needsLoad: false };
      }
      return { ok: true, reason: 'same-plan', role: 'owner', planId: clickedId, existing: opts.ownDoc || null, needsLoad: false };
    }
    if (!opts.planClient) {
      return { ok: false, reason: 'cross-plan', role: 'agent', planId: '', existing: null, needsLoad: false };
    }
    var other = canAccessClient(opts.email, opts.planClient, opts.members, opts.ownerEmail);
    if (!other.ok) {
      return { ok: false, reason: 'cross-plan', role: 'agent', planId: '', existing: null, needsLoad: false };
    }
    if (!planKnown) {
      return { ok: true, reason: 'plan-client', role: other.role, planId: requested, existing: null, needsLoad: true };
    }
    if (opts.planDoc) {
      var stored = String(opts.planDoc.agentName || '').trim();
      if (stored && other.role !== 'owner') {
        var member = findMemberByEmail(opts.members, opts.email);
        var name = member ? String(member.name || '').trim() : '';
        if (stored !== name) {
          return { ok: false, reason: 'cross-plan', role: 'agent', planId: '', existing: null, needsLoad: false };
        }
      }
      return { ok: true, reason: 'plan-client', role: other.role, planId: requested, existing: opts.planDoc, needsLoad: false };
    }
    return { ok: true, reason: 'plan-client-new', role: other.role, planId: requested, existing: null, needsLoad: false };
  }

  function mayWritePlan(grant, planId, email) {
    if (!grant || grant.ok !== true) return false;
    var id = String(planId || '');
    if (!id || id !== String(grant.planId || '')) return false;
    return normEmail(email) !== '' && normEmail(email) === normEmail(grant.email);
  }

  return {
    OWNER_EMAIL: OWNER_EMAIL,
    normEmail: normEmail,
    findMemberByEmail: findMemberByEmail,
    isCrmAdmin: isCrmAdmin,
    canAccessClient: canAccessClient,
    selectPlanTarget: selectPlanTarget,
    mayWritePlan: mayWritePlan
  };
});
