/* 離線權限回歸。不連 Firebase、不讀正式客戶資料。執行：node crm-access.test.js */
var assert = require('assert');
var A = require('./crm-access.js');
var OWNER = 'owner@example.test';

function acc(email, agentName, members) {
  return A.canAccessClient(email, { id: 'c1', agentName: agentName }, members, OWNER);
}
function plan(opts) {
  return A.selectPlanTarget(Object.assign({
    email: 'member@example.test',
    members: [{ email: 'member@example.test', name: '甲' }],
    ownerEmail: OWNER,
    clickedId: 'A',
    clickedClient: { id: 'A', agentName: '甲' },
    requestedPlan: 'A',
    ownDoc: { id: 'A', agentName: '甲', snap: { ok: true } },
    planDoc: null,
    planClient: null
  }, opts));
}

var cases = [];
function check(name, fn) {
  cases.push(name);
  fn();
  console.log('ok  ' + name);
}

check('空白、缺欄、只有空白、非陣列的成員名單，不會把登入者升成擁有者', function () {
  ['', '   ', null, undefined].forEach(function (blank) {
    var members = [{ name: '甲', email: blank }, { name: '乙' }];
    var r = acc('member@example.test', '甲', members);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'personal');
    assert.strictEqual(A.isCrmAdmin('member@example.test', members, OWNER), false);
  });
  assert.strictEqual(acc('member@example.test', '甲', []).ok, false);
  assert.strictEqual(acc('member@example.test', '甲', null).ok, false);
  assert.strictEqual(acc('member@example.test', '甲', { email: 'member@example.test' }).ok, false);
  assert.strictEqual(A.isCrmAdmin('member@example.test', [], OWNER), false);
  assert.strictEqual(A.isCrmAdmin('member@example.test', null, OWNER), false);
});

check('未登入或沒有 Email 不能當管理者，也不能開規劃', function () {
  var members = [{ email: 'member@example.test', name: '甲', admin: true }];
  assert.strictEqual(A.isCrmAdmin('', members, OWNER), false);
  assert.strictEqual(A.isCrmAdmin('   ', members, OWNER), false);
  assert.strictEqual(A.isCrmAdmin(null, members, OWNER), false);
  assert.strictEqual(acc('', '甲', members).reason, 'missing');
  assert.strictEqual(acc('   ', '甲', members).reason, 'missing');
});

check('不在名單的登入者被拒，不再預設成管理者', function () {
  var members = [{ email: 'member@example.test', name: '甲' }];
  var r = acc('stranger@example.test', '甲', members);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'personal');
  assert.strictEqual(A.isCrmAdmin('stranger@example.test', members, OWNER), false);
});

check('擁有者與明確勾選的管理者仍可看任何負責業務', function () {
  var members = [
    { email: 'admin@example.test', name: '管', admin: true },
    { email: 'member@example.test', name: '甲' }
  ];
  assert.strictEqual(acc(OWNER, '別人', members).ok, true);
  assert.strictEqual(acc(OWNER, '別人', members).role, 'owner');
  assert.strictEqual(A.isCrmAdmin(OWNER, [], OWNER), true);
  var adm = acc('admin@example.test', '別人', members);
  assert.strictEqual(adm.ok, true);
  assert.strictEqual(adm.role, 'owner');
  assert.strictEqual(A.isCrmAdmin('  Admin@example.test  ', members, OWNER), true);
});

check('一般成員：姓名相符可開，不符拒絕；空白負責業務仍可開', function () {
  var members = [{ email: '  member@example.test ', name: ' 甲 ' }];
  var ok = acc('member@example.test', '甲', members);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.role, 'agent');
  var bad = acc('member@example.test', '乙', members);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'not-agent');
  var blank = acc('member@example.test', '   ', members);
  assert.strictEqual(blank.ok, true);
  assert.strictEqual(blank.role, 'agent');
});

check('同一份規劃可以讀寫；不能藉另一個 client 代理未授權的 plan', function () {
  var members = [{ email: 'member@example.test', name: '甲' }];
  var base = {
    email: 'member@example.test',
    members: members,
    ownerEmail: OWNER,
    clickedId: 'A',
    clickedClient: { id: 'A', agentName: '甲' },
    ownDoc: { id: 'A', agentName: '甲' }
  };
  var same = plan(base);
  assert.strictEqual(same.ok, true);
  assert.strictEqual(same.planId, 'A');
  assert.strictEqual(same.reason, 'same-plan');
  var grant = { ok: true, email: 'member@example.test', planId: 'A' };
  assert.strictEqual(A.mayWritePlan(grant, 'A', 'member@example.test'), true);
  assert.strictEqual(A.mayWritePlan(grant, 'B', 'member@example.test'), false);
  assert.strictEqual(A.mayWritePlan(grant, 'A', 'other@example.test'), false);
  assert.strictEqual(A.mayWritePlan(null, 'A', 'member@example.test'), false);

  var foreign = plan(Object.assign({}, base, {
    requestedPlan: 'B',
    planClient: { id: 'B', agentName: '乙' },
    planDoc: { id: 'B', agentName: '乙', snap: { secret: true } }
  }));
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.reason, 'cross-plan');
  assert.strictEqual(foreign.planId, '');
  assert.strictEqual(foreign.existing, null);

  var orphan = plan(Object.assign({}, base, {
    requestedPlan: 'orphan',
    planDoc: { id: 'orphan', agentName: '', snap: { secret: true } }
  }));
  assert.strictEqual(orphan.ok, false);
  assert.strictEqual(orphan.reason, 'cross-plan');

  var missingForeign = plan(Object.assign({}, base, {
    requestedPlan: 'B',
    planClient: { id: 'B', agentName: '乙' },
    planDoc: null
  }));
  assert.strictEqual(missingForeign.ok, false);
  assert.notStrictEqual(missingForeign.planId, 'B');
});

check('成員對另一位自己有權限的客戶，可以開那份規劃並儲存', function () {
  var members = [{ email: 'member@example.test', name: '甲' }];
  var shared = plan({
    email: 'member@example.test',
    members: members,
    clickedId: 'A',
    clickedClient: { id: 'A', agentName: '甲' },
    requestedPlan: 'B',
    planClient: { id: 'B', agentName: '' },
    planDoc: { id: 'B', agentName: '甲', snap: { ok: true } },
    ownDoc: { id: 'A', agentName: '甲' }
  });
  assert.strictEqual(shared.ok, true);
  assert.strictEqual(shared.planId, 'B');
  assert.strictEqual(A.mayWritePlan({ ok: true, email: 'member@example.test', planId: shared.planId }, 'B', 'member@example.test'), true);
});

check('文件上的負責業務若是別人，不能因為 CRM 空白就讀走那份別的規劃', function () {
  var denied = plan({
    requestedPlan: 'B',
    planClient: { id: 'B', agentName: '' },
    planDoc: { id: 'B', agentName: '乙', snap: { secret: true } }
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'cross-plan');
});

check('擁有者可以跨規劃讀取；對方文件不存在時不會改寫到那個陌生 id', function () {
  var members = [{ email: 'member@example.test', name: '甲' }];
  var opened = A.selectPlanTarget({
    email: OWNER,
    members: members,
    ownerEmail: OWNER,
    clickedId: 'A',
    clickedClient: { id: 'A', agentName: '甲' },
    requestedPlan: 'B',
    planClient: { id: 'B', agentName: '乙' },
    planDoc: { id: 'B', agentName: '乙' },
    ownDoc: null
  });
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(opened.planId, 'B');
  assert.strictEqual(opened.role, 'owner');
  var absent = A.selectPlanTarget({
    email: OWNER,
    members: members,
    ownerEmail: OWNER,
    clickedId: 'A',
    clickedClient: { id: 'A', agentName: '甲' },
    requestedPlan: 'B',
    planClient: { id: 'B', agentName: '乙' },
    planDoc: null,
    planKnown: true,
    ownDoc: { id: 'A', agentName: '甲' }
  });
  assert.strictEqual(absent.ok, true);
  assert.strictEqual(absent.planId, 'A');
  assert.notStrictEqual(absent.planId, 'B');
});

var failed = 0;
cases.forEach(function (name) {});
console.log('crm-access.test.js');
console.log('cases ' + cases.length);
console.log('PASS');
