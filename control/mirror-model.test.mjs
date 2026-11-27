import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { registrationTarget, repositoryId, verify, verifyRegistration } from './mirror-model.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = obj => Buffer.from(JSON.stringify(obj) + '\n');
const A = 'v20261101000000-aaaaaaaa', B = 'v20261109000000-bbbbbbbb';
const C = 'v20261123000000-cccccccc', legacy = 'v20261027020308-00000000';
const one = { id: 101, date: '2026-11-01', dataDate: '2026-11-01' };
const two = { id: 102, date: '2026-11-09', dataDate: '2026-11-08' };
const three = { id: 103, date: '2026-11-23', dataDate: '2026-11-22' };
const pr = 37;

function payload(issues) {
  const latest = issues.at(-1);
  const history = issues.map(i => ({ date: i.date, price: 101 + i.id }));
  const indices = { sample: issues.map(i => ({ date: i.dataDate, v: 101 })) };
  return {
    'manufacturers.ndjson': encoded({ licenseCode: 'synthetic-only' }),
    'meta.json': encoded({ scope: 'synthetic-only' }),
    'price-history.json': encoded({ articles: issues, series: { sample: { cat: 'synthetic', points: history } }, indices }),
    'price-latest.json': encoded({ date: latest.date, dataDate: latest.dataDate, unit: '元/吨',
      quotes: [{ name: 'synthetic', price: 100, cat: 'synthetic', spec: '90%' }] }),
    'price-list.json': encoded({ items: issues }),
    'price-lite.json': encoded({ series: { sample: { cat: 'synthetic', points: history.map(p => [p.date,p.price]) } }, indices }),
    'registrations.ndjson': encoded({ no: 'synthetic-only' }),
  };
}

function snapshot(inputs) {
  const tree = {}, versions = {}, history = [];
  for (const [version, raw] of inputs) {
    const site = {};
    for (const name of Object.keys(raw).sort()) {
      const bytes = raw[name], gz = gzipSync(bytes, { level: 9 });
      const path = 'data/' + version + '/site/' + name;
      tree[path] = bytes;
      tree[path + '.gz'] = gz;
      site[name] = { sha256: sha(bytes), bytes: bytes.length, gzSha256: sha(gz), gzSize: gz.length };
    }
    const mirrorDigest = sha(Object.entries(site).map(([k,v]) => 'site/' + k + ':' + v.sha256).join('\n'));
    versions[version] = { version, site, mirrorDigest, siteCount: 7, cacheCount: 0, cache: {}, supersedes: history.at(-1)?.version ?? null };
    history.push({ version, mirrorDigest });
  }
  const { version: current, mirrorDigest } = history.at(-1);
  tree['data/index.json'] = encoded({ current, mirrorDigest, basePath: './' + current + '/site', sitePrefix: 'site/' });
  tree['data/manifest.json'] = encoded({ current, history, versions });
  return { tree, current, versions: Object.fromEntries(Object.entries(versions).map(([k,v]) => [k,v.site])) };
}
const pins = stage => ({
  indexSha256: sha(stage.tree['data/index.json']), manifestSha256: sha(stage.tree['data/manifest.json']),
});
function fixture(t, { action = 'align', makeStage, mutateHead, mutatePins, mutateP0, mutateP0Scope, mutateApproval, mutateRegistry, omit = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'sandbox-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: ['ignore','pipe','pipe'], encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-26T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-26T00:00:00Z' },
  }).trim();
  const put = (path, bytes) => {
    const dest = join(cwd,path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  };
  const commit = msg => { git('add','-A'); git('commit','-qm',msg); return git('rev-parse','HEAD'); };
  const writeData = tree => {
    rmSync(join(cwd,'data'), { recursive: true, force: true });
    for (const [f, bytes] of Object.entries(tree)) put(f,bytes);
  };
  git('init','-q','-b','main');
  git('config','user.name','Synthetic');
  git('config','user.email','synthetic@example.invalid');
  const advance = action === 'advance';
  const active = snapshot(advance ? [[A,payload([one])]] : [[legacy,payload([{ id: 100,date:'2026-09-30',dataDate:'2026-09-27' }])]]);
  writeData(active.tree);
  for (const f of ['control/check.mjs','.github/workflows/independent.yml']) put(f, 'original synthetic fixture\n');
  const olderBase = commit('Earlier protected base');
  git('commit', '--allow-empty', '-qm', 'Controlled anchor');
  const previousBase = git('rev-parse','HEAD');
  git('switch','-qc','candidate');
  const stage = makeStage?.() ?? snapshot(advance ? [[A,payload([one])],[B,payload([one,two])]] : [[A,payload([one])]]);
  writeData(stage.tree);
  mutateHead?.(put);
  const head = commit('Synthetic candidate');
  git('switch','-q','main');
  const p0 = { schema: 1, scope: 'synthetic-sandbox-only', repository: repositoryId, pr, action, decision: 'simulate-only' };
  mutateP0Scope?.(p0);
  const approval = {
    schema: 1, mode: 'synthetic-sandbox-only', repository: repositoryId, pr, head, action,
    active: { version: active.current, ...pins(active) },
    stage: { ...pins(stage), versions: stage.versions },
    orderedVersions: advance ? [A,B] : [A], rollbackTarget: advance ? A : null,
    p0EvidenceSha256: sha(encoded(p0)),
  };
  mutatePins?.(approval);
  const registry = { schema: 1, previousBase, approvalSha256: sha(encoded(approval)) };
  mutateApproval?.(approval);
  mutateRegistry?.(registry);
  mutateP0?.(p0);
  for (const [name, value] of Object.entries({registry,approval,p0})) {
    if (!omit.includes(name)) put('control/release-' + name + '.json', encoded(value));
  }
  const base = commit('Trusted synthetic registration');
  // Construct a two-parent test-merge tree without checking out or running the candidate.
  function mergeTree(left,right) {
    const tree = git('merge-tree','--write-tree',left,right);
    return git('commit-tree',tree,'-p',left,'-p',right,'-m','Synthetic test merge');
  }
  return { refs: { repository: repositoryId, pr, base, head, merge: mergeTree(base,head), cwd },
    git, put, commit, mergeTree, registry, approval, olderBase };
}
function rejected(t, options, why) {
  const { refs } = fixture(t,options);
  assert.throws(() => verify(refs), why);
}

for (const action of ['align','advance']) {
  test('accept exact synthetic ' + action, t => {
    const { refs, registry, approval } = fixture(t,{ action });
    assert.deepEqual(verify(refs), { approvalSha256:registry.approvalSha256,p0EvidenceSha256:approval.p0EvidenceSha256 });
  });
}
for (const file of Object.keys(payload([one]))) {
  for (const ext of ['','.gz']) {
    test('reject altered ' + file + ext, t =>
      rejected(t, { mutateHead: put => put('data/' + A + '/site/' + file + ext, 'changed') }, /File or gzip digest mismatch/));
  }
}
for (const file of ['index','manifest']) {
  test('reject staged ' + file + ' drift', t => rejected(t, { mutateHead: put => put('data/' + file + '.json', '{}') }, /digest mismatch/));
  test('reject active ' + file + ' pin drift', t =>
    rejected(t, { mutatePins: a => a.active[file + 'Sha256'] = 'a'.repeat(64) }, /digest mismatch/));
}
for (const file of ['control/check.mjs','.github/workflows/independent.yml','control/release-approval.json',
  'control/release-registry.json','control/release-p0.json']) {
  test('reject candidate control change ' + file, t => {
    const omit = file.startsWith('control/release-') ? [file.slice('control/release-'.length,-'.json'.length)] : [];
    rejected(t, { omit, mutateHead: put => put(file, 'candidate data') }, /only modify data/);
  });
}
test('reject candidate P0 change even when the final merge hides it', t => {
  const p0 = { schema: 1, scope: 'synthetic-sandbox-only', repository: repositoryId, pr, action: 'align', decision: 'simulate-only' };
  rejected(t,{mutateHead:put=>put('control/release-p0.json',encoded(p0))},/only modify data/);
});
test('reject an added untrusted control file even outside the record paths', t =>
  rejected(t,{mutateHead:put=>put('control/other-approval.json','{}')},/only modify data/));
test('reject approval byte drift', t =>
  rejected(t,{mutateApproval:a=>a.drift=true},/Approval record digest mismatch/));
test('reject P0 evidence byte drift', t =>
  rejected(t,{mutateP0:p=>p.drift=true},/P0 evidence digest mismatch/));
test('reject absent approval record', t => rejected(t,{omit:['approval']},/Missing or non-regular file/));
test('reject absent P0 evidence', t => rejected(t,{omit:['p0']},/Missing or non-regular file/));
test('reject wrong repository or PR identity', t => {
  const {refs}=fixture(t);
  assert.throws(()=>verify({...refs,repository:123}),/Wrong repository/);
  assert.throws(()=>verify({...refs,pr:pr+1}),/Expected values/);
});
test('reject stale head and merge SHA', t => {
  const {refs,git,put,commit,mergeTree}=fixture(t);
  git('switch','-q','candidate');
  put('data/extra.json','{}');
  const pushed=commit('Later push');
  git('switch','-q','main');
  assert.throws(()=>verify({...refs,head:pushed}),/Unexpected merge parents/);
  assert.throws(()=>verify({...refs,head:pushed,merge:mergeTree(refs.base,pushed)}),/Candidate head differs/);
  assert.throws(()=>verify({...refs,merge:refs.head}),/Unexpected merge parents/);
});
test('reject base advancing beyond registration', t => {
  const {refs,put,commit,mergeTree}=fixture(t);
  put('README.md','later main');
  const base=commit('Base advanced');
  assert.throws(()=>verify(refs),/exact protected base/);
  assert.throws(()=>verify({...refs,base,merge:mergeTree(base,refs.head)}),/Approval base advanced/);
});
for (const key of ['supplyNote','breadth','quote-note']) {
  test('reject approved-looking private field ' + key, t => {
    const raw=payload([one]), latest=JSON.parse(raw['price-latest.json']);
    if (key==='quote-note') latest.quotes[0].note='private'; else latest[key]='private';
    raw['price-latest.json']=encoded(latest);
    rejected(t,{makeStage:()=>snapshot([[A,raw]])},/contains private fields/);
  });
}
test('bind the sanitized public output independently of private latest bytes', t => {
  const raw = payload([one]), safe = JSON.parse(raw['price-latest.json']);
  const privateIssue = { ...safe, supplyNote: 'synthetic', breadth: {}, quotes: safe.quotes.map(q => ({...q,note:'synthetic'})) };
  const stage = snapshot([[A,raw]]);
  const { refs, approval } = fixture(t,{makeStage:()=>stage});
  assert.notEqual(sha(encoded(privateIssue)), approval.stage.versions[A]['price-latest.json'].sha256);
  assert.equal(sha(raw['price-latest.json']), approval.stage.versions[A]['price-latest.json'].sha256);
  assert.doesNotThrow(()=>verify(refs));
});
for (const name of ['registrations.ndjson','manufacturers.ndjson','meta.json']) {
  test('reject self-consistent unapproved baseline ' + name, t => {
    const raw = payload([one]); raw[name] = encoded({changed:true});
    rejected(t,{makeStage:()=>snapshot([[A,raw]])},/Unapproved synthetic fixed file/);
  });
}
test('reject forged rollback target', t => rejected(t,{mutatePins:a=>a.rollbackTarget=legacy},/Unexpected rollback target/));
test('reject legacy in approved-looking staged history', t =>
  rejected(t,{makeStage:()=>snapshot([[legacy,payload([one])],[A,payload([one])]])},/Unexpected ordered history/));
test('reject missing A in advance', t =>
  rejected(t,{action:'advance',makeStage:()=>snapshot([[B,payload([one,two])]])},/Unexpected ordered history/));
test('reject A to C skip', t =>
  rejected(t,{action:'advance',makeStage:()=>snapshot([[A,payload([one])],[C,payload([one,three])]])},/Unexpected ordered history|protected payload/));
test('reject unexpected C content under B version ID', t =>
  rejected(t,{action:'advance',makeStage:()=>snapshot([[A,payload([one])],[B,payload([one,three])]])},/Unexpected publication date/));
test('reject changed A before B', t => {
  const tampered=payload([one]); tampered['meta.json']=encoded({altered:true});
  rejected(t,{action:'advance',makeStage:()=>snapshot([[A,tampered],[B,payload([one,two])]])},/Unapproved synthetic fixed file/);
});

test('reject changed latest price bytes in the staged fallback A', t => {
  const tampered=payload([one]), latest=JSON.parse(tampered['price-latest.json']);
  latest.quotes[0].price=500;
  tampered['price-latest.json']=encoded(latest);
  rejected(t,{action:'advance',makeStage:()=>snapshot([[A,tampered],[B,payload([one,two])]])},/Staged rollback A differs/);
});

const registrationPr = 71;
function registrationFixture(t, options) {
  const f = fixture(t, options);
  const {refs, registry, git, mergeTree} = f;
  const anchor = registry.previousBase;
  const registration = {
    ...refs, pr: registrationPr, base: anchor, head: refs.base, merge: mergeTree(anchor,refs.base),
  };
  const target = { ...refs, base: anchor, merge: mergeTree(anchor,refs.head), open: true };
  git('switch','-q','--detach',anchor);
  return { ...f, registration, target };
}

for (const action of ['align','advance']) {
  test('register a distinct open ' + action + ' PR and release after a protected two-parent merge', t => {
    const {git, mergeTree, registration, target, registry, approval} = registrationFixture(t,{action});
    const expected = {approvalSha256:registry.approvalSha256,p0EvidenceSha256:approval.p0EvidenceSha256};
    assert.equal(registrationTarget(registration),target.pr);
    assert.equal(registrationTarget(target),null);
    assert.deepEqual(verifyRegistration(registration,target),expected);
    // The sandbox Ruleset uses merge commits, so the trusted registration
    // needs to remain valid when main has both original GitHub parents.
    git('switch','-q','--detach',registration.merge);
    const release = { ...target, base:registration.merge, merge:mergeTree(registration.merge,target.head) };
    assert.deepEqual(verify(release),expected);
  });
}

function editRegistration(f, edit) {
  const {git,put,commit,mergeTree,registration} = f;
  git('switch','-q','--detach',registration.head);
  edit({git,put,cwd:registration.cwd});
  const head = commit('Alter registration candidate');
  // Test the same GitHub trusted checkout semantics as the signer.
  git('switch','-q','--detach',registration.base);
  return {...registration,head,merge:mergeTree(registration.base,head)};
}
for (const path of ['README.md','control/check.mjs','control/mirror-model.mjs','.github/workflows/independent.yml',
  'data/unapproved.json','control/arbitrary.json']) {
  test('reject registration mixed with ' + path, t => {
    const f = registrationFixture(t);
    const refs = editRegistration(f,({put})=>put(path,'candidate code or data'));
    assert.throws(()=>verifyRegistration(refs,f.target),/only modify its fixed control paths/);
  });
}
test('reject deletion of a fixed control file', t => {
  const f = registrationFixture(t);
  const refs = editRegistration(f,({git})=>git('rm','control/release-p0.json'));
  assert.throws(()=>verifyRegistration(refs,f.target),/Missing or non-regular file/);
});
test('reject renaming a fixed control file out of the allowlist', t => {
  const f = registrationFixture(t);
  const refs = editRegistration(f,({git})=>git('mv','control/release-p0.json','control/stolen.json'));
  assert.throws(()=>verifyRegistration(refs,f.target),/only modify its fixed control paths/);
});
test('reject rename between fixed paths when it removes required bytes', t => {
  const f = registrationFixture(t);
  const refs = editRegistration(f,({git})=>git('mv','-f','control/release-p0.json','control/release-approval.json'));
  assert.throws(()=>verifyRegistration(refs,f.target),/Missing or non-regular file/);
});
test('reject a symbolic link at a control path', t => {
  const f = registrationFixture(t);
  const refs = editRegistration(f,({cwd,git})=>{
    git('rm','control/release-p0.json');
    symlinkSync('release-approval.json',join(cwd,'control/release-p0.json'));
  });
  assert.throws(()=>verifyRegistration(refs,f.target),/Missing or non-regular file/);
});
test('reject a gitlink at a control path', t => {
  const f = registrationFixture(t);
  const {registration,git,mergeTree,target} = f;
  git('switch','-q','--detach',registration.head);
  git('rm','control/release-p0.json');
  git('update-index','--add','--cacheinfo','160000,'+registration.base+',control/release-p0.json');
  git('commit','-qm','Synthetic gitlink');
  const head=git('rev-parse','HEAD');
  git('switch','-q','--detach',registration.base);
  const refs={...registration,head,merge:mergeTree(registration.base,head)};
  assert.throws(()=>verifyRegistration(refs,target),/Missing or non-regular file/);
});
test('reject a registration approving itself', t => {
  const {registration,target}=registrationFixture(t);
  assert.throws(()=>verifyRegistration({...registration,pr:target.pr},target),/cannot approve itself/);
});
test('reject missing or closed target release PR', t => {
  const {registration,target}=registrationFixture(t);
  assert.throws(()=>verifyRegistration(registration),/missing or closed/);
  assert.throws(()=>verifyRegistration(registration,{...target,open:false}),/missing or closed/);
});
test('reject a different target PR number', t => {
  const {registration,target}=registrationFixture(t);
  assert.throws(()=>verifyRegistration(registration,{...target,pr:target.pr+1}),/Wrong target release PR/);
});
test('reject a pushed target with the same data tree and a new head', t => {
  const {registration,target,git,mergeTree}=registrationFixture(t);
  const tree=git('rev-parse',target.head+'^{tree}');
  const head=git('commit-tree',tree,'-p',target.head,'-m','New target commit');
  assert.throws(()=>verifyRegistration(registration,{...target,head,merge:mergeTree(target.base,head)}),/Candidate head differs/);
});
test('reject target release head forked from an older base', t => {
  const {registration,target,olderBase,git,mergeTree}=registrationFixture(t);
  const tree=git('rev-parse',target.head+'^{tree}');
  const head=git('commit-tree',tree,'-p',olderBase,'-m','Stale fork');
  assert.throws(()=>verifyRegistration(registration,{...target,head,merge:mergeTree(target.base,head)}),/fork from the registration base/);
});
test('reject non-data target even when its merge is well-formed', t => {
  const {registration,target}=registrationFixture(t,{mutateHead:put=>put('README.md','Unapproved')});
  assert.throws(()=>verifyRegistration(registration,target),/only modify data/);
});
test('reject candidate approval and P0 digest drift in registration', t => {
  const a=registrationFixture(t,{mutateApproval:x=>x.action='advance'});
  assert.throws(()=>verifyRegistration(a.registration,a.target),/Approval record digest mismatch/);
  const b=registrationFixture(t,{mutateP0:x=>x.decision='other'});
  assert.throws(()=>verifyRegistration(b.registration,b.target),/P0 evidence digest mismatch/);
});
test('reject approval fields and P0 scope even when digests are internally consistent', t => {
  const f=registrationFixture(t,{mutatePins:x=>x.extra='synthetic'});
  assert.throws(()=>verifyRegistration(f.registration,f.target),/Unexpected approval fields/);
  const scoped=registrationFixture(t,{mutateP0Scope:x=>x.decision='publish'});
  assert.throws(()=>verifyRegistration(scoped.registration,scoped.target),/Invalid synthetic P0 evidence/);
});
test('reject bad staged index pins during registration', t => {
  const {registration,target}=registrationFixture(t,{mutatePins:x=>x.stage.indexSha256='c'.repeat(64)});
  assert.throws(()=>verifyRegistration(registration,target),/index digest mismatch/);
});
test('reject invalid control merge parent', t => {
  const {registration,target}=registrationFixture(t);
  assert.throws(()=>verifyRegistration({...registration,merge:registration.head},target),/Unexpected merge parents/);
});
