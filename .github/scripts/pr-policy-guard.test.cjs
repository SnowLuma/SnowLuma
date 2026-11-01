const assert = require('node:assert/strict');
const { test } = require('node:test');
const guard = require('./pr-policy-guard.cjs');

function fixture() {
  const pr = {
    number: 100,
    state: 'open',
    merged: false,
    base: { ref: 'dev' },
    body: 'Refs #42',
    created_at: '2026-11-01T10:00:00Z',
  };
  const issue = {
    number: 42,
    state: 'open',
    html_url: 'https://github.com/SnowLuma/SnowLuma/issues/42',
    created_at: '2026-11-01T09:00:00Z',
    author_association: 'NONE',
    labels: [{ name: 'bug' }],
  };
  const state = {
    pr,
    issue,
    issues: new Map([[42, issue]]),
    comments: [],
    lookups: [],
    mutations: [],
    failures: [],
    refresh: null,
    requests: 0,
  };
  const context = {
    repo: { owner: 'SnowLuma', repo: 'SnowLuma' },
    issue: { number: 100 },
    serverUrl: 'https://github.com',
  };
  const github = {
    rest: {
      pulls: {
        get: async () => {
          state.requests += 1;
          return {
            data: structuredClone(state.requests > 1 && state.refresh ? state.refresh : pr),
          };
        },
        update: async (params) => state.mutations.push({ action: 'close', ...params }),
      },
      issues: {
        get: async ({ issue_number }) => {
          state.lookups.push(issue_number);
          const result = state.issues.get(issue_number);

          if (result instanceof Error) {
            throw result;
          }

          if (!result) {
            throw Object.assign(new Error('Not found'), { status: 404 });
          }

          return { data: structuredClone(result) };
        },
        listComments: () => {},
        createComment: async (params) => state.mutations.push({ action: 'comment', ...params }),
        updateComment: async (params) =>
          state.mutations.push({ action: 'edit-comment', ...params }),
      },
    },
    paginate: async () => structuredClone(state.comments),
  };
  const core = {
    info: () => {},
    setFailed: (reason) => state.failures.push(reason),
  };
  return { ...state, state, github, run: () => guard({ github, context, core }) };
}

function assertClosed(f, reason) {
  assert.deepEqual(
    f.mutations.map((entry) => entry.action),
    ['comment', 'close'],
  );
  assert.equal(f.mutations[1].pull_number, 100);
  assert.equal(f.mutations[1].state, 'closed');
  assert.match(f.mutations[0].body, reason);
  assert.equal(f.failures.length, 1);
}

for (const body of [
  'Refs #42',
  'refs: #42',
  'Ref #42',
  'Close #42',
  'Closes #42',
  'Closed #42',
  'Fix #42',
  'Fixes #42',
  'Fixed #42',
  'Resolve #42',
  'Resolves #42',
  'Resolved #42',
  'This change fixes #42.',
  'CLOSES: #42',
  'Refs SnowLuma/SnowLuma#42',
  'Refs snowluma/snowluma#42',
  'Refs https://github.com/SnowLuma/SnowLuma/issues/42',
]) {
  test(`accepts a real issue reference: ${body}`, async () => {
    const f = fixture();
    f.pr.body = body;
    await f.run();
    assert.deepEqual(f.lookups, [42]);
    assert.deepEqual(f.mutations, []);
    assert.deepEqual(f.failures, []);
  });
}

for (const body of [
  '',
  null,
  '#42',
  'prefixRefs #42',
  'Refs #0',
  'Refs #42abc',
  'Refs #42/other',
  'Refs #9007199254740993',
  'Refs other/repo#42',
  'Refs https://github.com/other/repo/issues/42',
  'Refs https://example.org/SnowLuma/SnowLuma/issues/42',
  'Refs https://github.com/SnowLuma/SnowLuma/pull/42',
  'Refs https://%',
  '<!-- Closes #42 -->',
  '<!-- Closes #42',
  '`Refs #42`',
  '```text\nRefs #42\n```',
  '~~~\nRefs #42\n~~~',
  '```\nRefs #42',
  '> Closes #42',
  '    Refs #42',
  '\tRefs #42',
]) {
  test(`does not treat examples or invalid references as an issue: ${JSON.stringify(body)}`, async () => {
    const f = fixture();
    f.pr.body = body;
    await f.run();
    assert.deepEqual(f.lookups, []);
    assertClosed(f, /缺少本仓库 issue/);
  });
}

for (const base of ['main', 'release/v2', 'feature/example']) {
  test(`closes a PR targeting ${base} before looking up issues`, async () => {
    const f = fixture();
    f.pr.base.ref = base;
    await f.run();
    assert.deepEqual(f.lookups, []);
    assertClosed(f, /目标分支必须是 `dev`/);
  });
}

for (const [patch, reason] of [
  [{ pull_request: {} }, /是 PR，不是 issue/],
  [{ state: 'closed', state_reason: 'not_planned' }, /已关闭/],
  [{ state: 'closed', state_reason: 'completed' }, /已关闭/],
  [{ html_url: 'https://github.com/other/repo/issues/42' }, /已不属于本仓库/],
  [{ created_at: '2026-11-01T11:00:00Z' }, /晚于本 PR 创建/],
  [{ labels: [] }, /未通过 issue 模板检查/],
]) {
  test(`rejects an ineligible issue: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    Object.assign(f.issue, patch);
    await f.run();
    assertClosed(f, reason);
  });
}

test('checks the issue author exemption, not the PR author', async () => {
  const f = fixture();
  f.pr.author_association = 'OWNER';
  f.issue.labels = [];
  await f.run();
  assertClosed(f, /未通过 issue 模板检查/);
});

for (const author_association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
  test(`matches the existing issue template exemption for ${author_association}`, async () => {
    const f = fixture();
    Object.assign(f.issue, { author_association, labels: [] });
    await f.run();
    assert.deepEqual(f.mutations, []);
    assert.deepEqual(f.failures, []);
  });
}

test('accepts feature template labels and a visible marker after a code example', async () => {
  const f = fixture();
  f.issue.labels = ['enhancement'];
  f.pr.body = '```text\nRefs #999\n```\nRefs #42';
  await f.run();
  assert.deepEqual(f.lookups, [42]);
  assert.deepEqual(f.mutations, []);
});

test('deduplicates references and accepts at least one eligible issue', async () => {
  const f = fixture();
  f.pr.body = 'Refs #404\nCloses #404\nRefs #42';
  await f.run();
  assert.deepEqual(f.lookups, [404, 42]);
  assert.deepEqual(f.mutations, []);
});

for (const status of [404, 410]) {
  test(`rejects a missing or deleted issue (${status})`, async () => {
    const f = fixture();
    f.issues.set(42, Object.assign(new Error('Unavailable'), { status }));
    await f.run();
    assertClosed(f, /不存在或不可访问/);
  });
}

for (const status of [403, 429, 500]) {
  test(`fails visibly without closing a PR on an API error (${status})`, async () => {
    const f = fixture();
    const error = Object.assign(new Error('API unavailable'), { status });
    f.issues.set(42, error);
    await assert.rejects(f.run, error);
    assert.deepEqual(f.mutations, []);
  });
}

test('does not close a PR whose author fixed the body during validation', async () => {
  const f = fixture();
  f.pr.body = '';
  f.state.refresh = { ...f.pr, body: 'Refs #42' };
  await f.run();
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.failures, []);
});

test('does not close a PR whose base was corrected during validation', async () => {
  const f = fixture();
  f.pr.base.ref = 'main';
  f.state.refresh = { ...f.pr, base: { ref: 'dev' } };
  await f.run();
  assert.deepEqual(f.mutations, []);
});

test('leaves closed and merged PRs alone', async () => {
  const f = fixture();
  Object.assign(f.pr, { state: 'closed', merged: true });
  await f.run();
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.mutations, []);
});

test('updates its own previous rejection comment when a PR is reopened', async () => {
  const f = fixture();
  f.pr.body = '';
  f.comments.push({
    id: 7,
    user: { login: 'github-actions[bot]' },
    body: '<!-- snowluma-pr-policy-guard -->\nold reason',
  });
  await f.run();
  assert.deepEqual(
    f.mutations.map((entry) => entry.action),
    ['edit-comment', 'close'],
  );
  assert.equal(f.mutations[0].comment_id, 7);
});

test('does not overwrite a contributor comment containing the guard marker', async () => {
  const f = fixture();
  f.pr.body = '';
  f.comments.push({
    id: 7,
    user: { login: 'contributor' },
    body: '<!-- snowluma-pr-policy-guard -->',
  });
  await f.run();
  assertClosed(f, /缺少本仓库 issue/);
});

test('does not close the PR if its explanation cannot be posted', async () => {
  const f = fixture();
  f.pr.body = '';
  const error = Object.assign(new Error('Comment rejected'), { status: 403 });
  f.github.rest.issues.createComment = async () => {
    throw error;
  };
  await assert.rejects(f.run, error);
  assert.deepEqual(f.mutations, []);
});

test('reuses an unchanged explanation without posting or editing another comment', async () => {
  const first = fixture();
  first.pr.body = '';
  await first.run();

  const reopened = fixture();
  reopened.pr.body = '';
  reopened.comments.push({
    id: 7,
    user: { login: 'github-actions[bot]' },
    body: first.mutations[0].body,
  });
  await reopened.run();
  assert.deepEqual(
    reopened.mutations.map((entry) => entry.action),
    ['close'],
  );
});
