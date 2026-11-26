import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

export const repositoryId = 1469469532;
const sha = value => createHash('sha256').update(value).digest('hex');
const fullSha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const files = [
  'manufacturers.ndjson', 'meta.json', 'price-history.json', 'price-latest.json',
  'price-list.json', 'price-lite.json', 'registrations.ndjson',
];
const fixed = {
  'manufacturers.ndjson': '19ec71dd3d6d07eb7a0673ccb0633a37faacbabd752df2f5239c2a7d9a5fe88b',
  'meta.json': 'd66e94248b7a7d5d2ae4af2e7055d92210cd817e85ec89cefc029c987a8dd966',
  'registrations.ndjson': 'd1de6f637617e32f9982225c45ca1f7a04d256c29f994710d28c3c7c6e0b90f9',
};
const issues = [
  { version: 'v20261101000000-aaaaaaaa', id: 101, date: '2026-11-01', dataDate: '2026-11-01' },
  { version: 'v20261109000000-bbbbbbbb', id: 102, date: '2026-11-09', dataDate: '2026-11-08' },
];
const control = {
  registry: 'control/release-registry.json',
  approval: 'control/release-approval.json',
  p0: 'control/release-p0.json',
};
const latestKeys = ['note', 'sourceId', 'source', 'url', 'date', 'dataDate', 'unit', 'rawUnit', 'index', 'quotes'];
const quoteKeys = ['name', 'price', 'cat', 'spec'];

export function verify({ repository, pr, base, head, merge, cwd = process.cwd() }) {
  assert.equal(repository, repositoryId, 'Wrong repository');
  assert(Number.isSafeInteger(pr) && pr > 0, 'Invalid PR number');
  for (const ref of [base, head, merge]) assert.match(ref, fullSha);
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = (...args) => git(...args).toString().trim();
  const changed = (a, b) => git('diff', '--no-renames', '--name-only', '-z', a, b).toString().split('\0').filter(Boolean).sort();
  const read = (ref, path) => {
    assert.equal(text('ls-tree', ref, '--', path).split(' ')[0], '100644', 'Missing or non-regular file: ' + path);
    return git('show', ref + ':' + path);
  };
  const json = (ref, path) => JSON.parse(read(ref, path));
  assert.equal(text('rev-parse', 'HEAD'), base, 'The checker must run from the exact protected base');
  assert.deepEqual(text('show', '-s', '--format=%P', merge).split(' '), [base, head], 'Unexpected merge parents');
  const ancestor = text('merge-base', '--all', base, head);
  assert.match(ancestor, fullSha, 'Ambiguous merge base');
  for (const diff of [changed(ancestor, head), changed(base, merge)]) {
    assert(diff.length && diff.every(path => path.startsWith('data/')), 'A release may only modify data/');
  }

  const registry = json(base, control.registry);
  assert.equal(registry.schema, 1);
  assert.match(registry.previousBase, fullSha);
  assert.equal(text('show', '-s', '--format=%P', base), registry.previousBase, 'Approval base advanced');
  assert.equal(ancestor, registry.previousBase, 'Candidate does not fork from the pre-approval base');
  const registration = changed(registry.previousBase, base);
  assert(registration.length && registration.every(path => Object.values(control).includes(path)) &&
    registration.includes(control.registry), 'Trusted registration commit may only change release control records');
  const approvalBytes = read(base, control.approval);
  assert.match(registry.approvalSha256, digest);
  assert.equal(sha(approvalBytes), registry.approvalSha256, 'Approval record digest mismatch');
  const approval = JSON.parse(approvalBytes);
  assert.equal(approval.schema, 1);
  assert.equal(approval.mode, 'synthetic-sandbox-only');
  assert.equal(approval.repository, repository);
  assert.equal(approval.pr, pr);
  assert.equal(approval.head, head, 'Candidate head differs from trusted approval');

  const p0Bytes = read(base, control.p0);
  assert.match(approval.p0EvidenceSha256, digest);
  assert.equal(sha(p0Bytes), approval.p0EvidenceSha256, 'P0 evidence digest mismatch');
  assert.deepEqual(JSON.parse(p0Bytes), {
    schema: 1, scope: 'synthetic-sandbox-only', repository, pr, action: approval.action,
    decision: 'simulate-only',
  }, 'Invalid synthetic P0 evidence');

  function pointers(ref, pins) {
    const get = name => {
      const bytes = read(ref, 'data/' + name + '.json');
      assert.match(pins[name + 'Sha256'], digest);
      assert.equal(sha(bytes), pins[name + 'Sha256'], name + ' digest mismatch');
      return JSON.parse(bytes);
    };
    const index = get('index');
    const manifest = get('manifest');
    assert.equal(index.current, manifest.current, 'Pointers disagree');
    return { index, manifest };
  }
  function validateTree(ref, index, manifest, pins, ordered, rollbackTarget) {
    assert.deepEqual(manifest.history.map(entry => entry.version), ordered, 'Unexpected ordered history');
    assert.equal(index.current, ordered.at(-1), 'Index does not name history tip');
    assert.equal(index.basePath, './' + index.current + '/site');
    assert.equal(index.sitePrefix, 'site/');
    assert.deepEqual(Object.keys(manifest.versions).sort(), ordered.toSorted(), 'Unexpected manifest versions');
    assert.deepEqual(Object.keys(pins).sort(), ordered.toSorted(), 'Unexpected approved versions');
    const expected = ['data/index.json', 'data/manifest.json'];
    const payloads = {};
    for (const [i, version] of ordered.entries()) {
      const entry = manifest.versions[version], pin = pins[version];
      assert.equal(entry.version, version);
      assert.equal(entry.supersedes, ordered[i - 1] ?? null, 'Unexpected predecessor');
      assert.equal(entry.siteCount, 7);
      assert.equal(entry.cacheCount, 0);
      assert.deepEqual(entry.cache ?? {}, {});
      assert.deepEqual(entry.site, pin, 'Manifest payload differs from trusted approval');
      assert.deepEqual(Object.keys(pin).sort(), files, 'Expected exactly seven approved files');
      const paths = {};
      for (const name of files) {
        const path = 'data/' + version + '/site/' + name;
        expected.push(path, path + '.gz');
        const raw = read(ref, path), zipped = read(ref, path + '.gz');
        assert.deepEqual(pin[name], {
          sha256: sha(raw), bytes: raw.length, gzSha256: sha(zipped), gzSize: zipped.length,
        }, 'File or gzip digest mismatch: ' + name);
        if (Object.hasOwn(fixed, name)) assert.equal(pin[name].sha256, fixed[name], 'Unapproved synthetic fixed file: ' + name);
        assert(raw.length > 0 && gunzipSync(zipped, { maxOutputLength: raw.length }).equals(raw), 'Gzip differs: ' + name);
        paths[name] = path;
      }
      const mirrorDigest = sha(files.map(name => 'site/' + name + ':' + pin[name].sha256).join('\n'));
      assert.equal(entry.mirrorDigest, mirrorDigest, 'Version mirror digest mismatch');
      assert.equal(manifest.history[i].mirrorDigest, mirrorDigest);
      if (i === ordered.length - 1) assert.equal(index.mirrorDigest, mirrorDigest, 'Index mirror digest mismatch');
      const readPrice = name => json(ref, paths['price-' + name + '.json']);
      const latest = readPrice('latest');
      assert(Object.keys(latest).every(k => latestKeys.includes(k)) && Array.isArray(latest.quotes) &&
        latest.quotes.length > 0 && latest.quotes.every(q => Object.keys(q).every(k => quoteKeys.includes(k))),
      'Public price-latest contains private fields');
      payloads[version] = { latest, list: readPrice('list'), history: readPrice('history'), lite: readPrice('lite') };
    }
    const paths = git('ls-tree', '-r', '--name-only', '-z', ref, '--', 'data/').toString().split('\0').filter(Boolean).sort();
    assert.deepEqual(paths, expected.sort(), 'Unexpected or missing staged data paths');
    assert.equal(rollbackTarget, ordered.at(-2) ?? null, 'Unexpected rollback target');
    return payloads;
  }

  const [a,b] = issues;
  assert(['align','advance'].includes(approval.action), 'Unsupported release action');
  const advance = approval.action === 'advance';
  const ordered = advance ? [a.version,b.version] : [a.version];
  assert.deepEqual(approval.orderedVersions, ordered, 'Approval has unsafe history');
  const active = pointers(base, approval.active);
  const stage = pointers(merge, approval.stage);
  const data = validateTree(merge, stage.index, stage.manifest, approval.stage.versions, ordered, approval.rollbackTarget);
  assert.equal(active.index.current, approval.active.version, 'Wrong active version');
  if (advance) {
    assert.equal(active.index.current, a.version, 'Advance requires active A');
    const activePin = active.manifest.versions[a.version].site;
    validateTree(base, active.index, active.manifest, { [a.version]: activePin }, [a.version], null);
    assert.deepEqual(approval.stage.versions[a.version], activePin, 'Staged rollback A differs from active A');
    for (const name of Object.keys(fixed)) {
      assert.deepEqual(approval.stage.versions[b.version][name], activePin[name], 'Advance changed protected payload: ' + name);
    }
  } else {
    assert.equal(active.index.current, 'v20261027020308-00000000', 'Alignment requires the synthetic legacy active version');
  }

  function market(payload, issue) {
    const { latest, list, history } = payload;
    assert.equal(latest.date, issue.date, 'Unexpected publication date');
    assert.equal(latest.dataDate, issue.dataDate, 'Unexpected market date');
    assert.equal(list.items.at(-1).id, issue.id, 'Unexpected issue ID');
    assert.equal(list.items.at(-1).date, issue.date);
    assert.equal(history.articles.at(-1).id, issue.id);
    assert.equal(history.articles.at(-1).date, issue.date);
    assert.equal(history.articles.at(-1).dataDate, issue.dataDate);
  }
  market(data[a.version], a);
  if (advance) {
    market(data[b.version], b);
    const prior = data[a.version], next = data[b.version];
    for (const [old, fresh] of [[prior.list.items, next.list.items], [prior.history.articles, next.history.articles]]) {
      assert.equal(fresh.length, old.length + 1, 'Expected exactly one new issue');
      assert.deepEqual(fresh.slice(0,-1), old, 'Historical issues rewritten');
      assert(!old.some(item => item.id === b.id || item.date === b.date), 'Duplicate issue');
    }
    for (const layer of ['history','lite']) {
      const old = prior[layer], fresh = next[layer];
      for (const [name, series] of Object.entries(fresh.series)) {
        const historical = series.points.filter(p => (layer === 'history' ? p.date : p[0]) !== b.date);
        if (Object.hasOwn(old.series,name)) assert.deepEqual({ ...series, points: historical }, old.series[name], 'Historical series rewritten');
        else assert.deepEqual(historical, [], 'Unexpected historical series');
      }
      assert(Object.keys(old.series).every(k => Object.hasOwn(fresh.series,k)), 'Historical series removed');
      assert.deepEqual(Object.fromEntries(Object.entries(fresh.indices).map(([k,v]) =>
        [k,v.filter(p => p.date !== b.dataDate)])), old.indices, 'Historical indices rewritten');
    }
  }
  return { approvalSha256: registry.approvalSha256, p0EvidenceSha256: approval.p0EvidenceSha256 };
}
