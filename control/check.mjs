import assert from 'node:assert/strict';
import { createHash, createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = '17Fox-CSC/pesticide-release-check-sandbox';
const repositoryId = 1469469532;
const context = 'independent-sandbox-release';
const fullSha = /^[0-9a-f]{40}$/;
const number = /^[1-9][0-9]{0,11}$/;
const git = (...args) => execFileSync('git', args, { maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const sha = content => createHash('sha256').update(content).digest('hex');

export function verify({ base, head, merge }) {
  for (const ref of [base, head, merge]) assert.match(ref, fullSha);
  const parents = git('cat-file', '-p', merge).split('\n\n', 1)[0].split('\n')
    .filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  assert.deepEqual(parents, [base, head], 'Unexpected merge parents');
  assert.equal(git('rev-parse', 'HEAD').trim(), base, 'The checker must run from the exact base');
  const diff = git('diff', '--no-renames', '--name-only', '-z', base, merge).split('\0').filter(Boolean);
  assert(diff.length && diff.every(file => file.startsWith('data/')), 'A release may only modify data/');
  const approval = JSON.parse(git('show', base + ':control/approval.json'));
  assert.equal(approval.repositoryId, repositoryId);
  assert.equal(approval.mode, 'synthetic-sandbox-only');
  assert.match(approval.previousBase, fullSha);
  assert.deepEqual(git('show','-s','--format=%P',base).trim().split(' '), [approval.previousBase], 'Approval base advanced');
  assert.equal(git('diff','--no-renames','--name-only',approval.previousBase,base).trim(),'control/approval.json');
  const entries = git('ls-tree','-r','-z','--full-tree',merge,'--','data/').split('\0').filter(Boolean);
  const files = {};
  for (const entry of entries) {
    const separator = entry.indexOf('\t');
    const file = entry.slice(separator + 1);
    const [mode, type, blob] = entry.slice(0, separator).split(' ');
    assert(Object.hasOwn(approval.files,file), 'Unexpected candidate path');
    assert.equal(mode, '100644');
    assert.equal(type, 'blob');
    assert.match(blob, fullSha);
    files[file] = sha(execFileSync('git', ['cat-file','blob',blob], {maxBuffer: 65536}));
  }
  assert.deepEqual(files, approval.files, 'Candidate bytes do not match trusted approval');
  const manifest = JSON.parse(git('show', merge + ':data/manifest.json'));
  assert.deepEqual(manifest.history, ['A']);
}

const api = (endpoint, token, body) => fetch('https://api.github.com' + endpoint, {
  method: body ? 'POST' : 'GET',
  redirect: 'error',
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(15000),
}).then(async response => {
  if (!response.ok) throw new Error('GitHub API request failed with HTTP ' + response.status);
  return response.json();
});

async function run() {
  const env = process.env;
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REPOSITORY_ID, String(repositoryId));
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF, repository + '/.github/workflows/independent.yml@refs/heads/main');
  for (const n of [env.INPUT_PR, env.RELEASE_APP_ID, env.RELEASE_INSTALLATION_ID]) {
    if (!n || !number.test(n)) throw new Error('Missing or invalid PR/App/installation ID');
  }
  if (!env.RELEASE_APP_PRIVATE_KEY) throw new Error('The protected environment key is not configured');
  const now = Math.floor(Date.now()/1000);
  const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const jwtBody = [b64({alg:'RS256',typ:'JWT'}),b64({iat:now-30,exp:now+540,iss:env.RELEASE_APP_ID})].join('.');
  const jwt = jwtBody + '.' + createSign('RSA-SHA256').update(jwtBody).sign(env.RELEASE_APP_PRIVATE_KEY,'base64url');
  const auth = await api('/app/installations/'+env.RELEASE_INSTALLATION_ID+'/access_tokens', jwt, {
    repository_ids:[repositoryId],
    permissions:{contents:'read',pull_requests:'read',statuses:'write'},
  });
  assert.deepEqual(auth.permissions,{contents:'read',pull_requests:'read',statuses:'write',metadata:'read'});
  const token = auth.token;
  const repoApi = '/repos/'+repository;
  async function state() {
    const [main, pr] = await Promise.all([
      api(repoApi+'/branches/main',token),
      api(repoApi+'/pulls/'+env.INPUT_PR,token),
    ]);
    assert.equal(pr.state,'open');
    assert.equal(pr.base.repo.id, repositoryId);
    assert.equal(pr.base.ref,'main');
    assert.equal(pr.base.sha, main.commit.sha);
    const refs = {base:pr.base.sha,head:pr.head.sha,merge:pr.merge_commit_sha};
    for (const ref of Object.values(refs)) assert.match(ref,fullSha);
    return refs;
  }
  try {
    const checked = await state();
    assert.equal(checked.base, env.GITHUB_SHA, 'Workflow main advanced');
    git('fetch','--no-tags','origin','refs/pull/'+env.INPUT_PR+'/merge');
    assert.equal(git('rev-parse','FETCH_HEAD').trim(),checked.merge, 'GitHub merge ref differs from API');
    let reason;
    try { verify(checked); } catch (error) { reason = error.name + ': ' + String(error.message).split('\n')[0]; }
    assert.deepEqual(await state(), checked, 'PR changed while checking');
    const result = await api(repoApi+'/statuses/'+checked.merge, token, {
      context, state:reason?'failure':'success',
      description:reason?'Synthetic candidate rejected':'Exact synthetic approval verified',
      target_url:'https://github.com/'+repository+'/actions/runs/'+env.GITHUB_RUN_ID,
    });
    assert.equal(result.state,reason?'failure':'success');
    assert.equal(result.context,context);
    console.log(JSON.stringify({ ...checked, state:result.state, context:result.context, actor:result.creator.login, appId:env.RELEASE_APP_ID, reason }));
    if (reason) process.exitCode=1;
  } finally {
    await fetch('https://api.github.com/installation/token', {
      method:'DELETE', headers:{Authorization:'Bearer '+token}, signal:AbortSignal.timeout(10000),
    }).catch(()=>{});
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    // Never print request objects, auth payloads, or key material.
    console.error(error.name + ': ' + String(error.message).split('\n')[0]);
    process.exitCode=1;
  });
}

// negative test fixture
