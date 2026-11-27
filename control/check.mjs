import assert from 'node:assert/strict';
import { createSign } from 'node:crypto';
import { registrationTarget, repositoryId, verify, verifyRegistration } from './mirror-model.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = '17Fox-CSC/pesticide-release-check-sandbox';
const context = 'independent-sandbox-release';
const fullSha = /^[0-9a-f]{40}$/;
const number = /^[1-9][0-9]{0,11}$/;
const git = (...args) => execFileSync('git', args, { maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
export { verify };

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
  assert.equal(env.RELEASE_APP_ID, '5896859', 'Unexpected signing App');
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
  async function state(prNumber) {
    const [main, pr] = await Promise.all([
      api(repoApi+'/branches/main',token),
      api(repoApi+'/pulls/'+prNumber,token),
    ]);
    assert.equal(pr.number, prNumber);
    assert.equal(pr.state,'open');
    assert.equal(pr.base.repo.id, repositoryId);
    assert.equal(pr.base.ref,'main');
    assert.equal(pr.base.sha, main.commit.sha);
    const { sha:base } = pr.base;
    const { sha:head } = pr.head;
    const merge = pr.merge_commit_sha;
    for (const ref of [base,head,merge]) assert.match(ref,fullSha);
    const refs = {repository:repositoryId, pr:pr.number, base, head, merge, open:true};
    return refs;
  }
  function fetchMerge(refs) {
    git('fetch','--no-tags','origin','refs/pull/'+refs.pr+'/merge');
    assert.equal(git('rev-parse','FETCH_HEAD').trim(),refs.merge, 'GitHub merge ref differs from API');
  }
  try {
    const checked = await state(Number(env.INPUT_PR));
    assert.equal(checked.base, env.GITHUB_SHA, 'Workflow main advanced');
    fetchMerge(checked);
    let reason, evidence, target;
    try {
      const number = registrationTarget(checked);
      if (number === null) {
        evidence = verify(checked);
      } else {
        target = await state(number);
        fetchMerge(target);
        evidence = verifyRegistration(checked, target);
        assert.deepEqual(await state(target.pr), target, 'Target release PR changed while checking');
      }
    } catch (error) { reason = error.name + ': ' + String(error.message).split('\n')[0]; }
    assert.deepEqual(await state(checked.pr), checked, 'PR changed while checking');
    const result = await api(repoApi+'/statuses/'+checked.merge, token, {
      context, state:reason?'failure':'success',
      description:reason?'Synthetic candidate rejected':target?'Synthetic registration verified':'Exact synthetic release verified',
      target_url:'https://github.com/'+repository+'/actions/runs/'+env.GITHUB_RUN_ID,
    });
    assert.equal(result.state,reason?'failure':'success');
    assert.equal(result.context,context);
    console.log(JSON.stringify({ ...checked, state:result.state, context:result.context, actor:result.creator.login, appId:env.RELEASE_APP_ID, evidence, target, reason }));
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
