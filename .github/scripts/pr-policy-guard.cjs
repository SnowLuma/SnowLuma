const COMMENT_MARKER = '<!-- snowluma-pr-policy-guard -->';
const TEMPLATE_LABELS = new Set(['bug', 'enhancement']);
const PRIVILEGED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function prose(body) {
  let fence = null;
  return (body || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        ) {
          fence = null;
        }

        return '';
      }

      if (marker) {
        fence = marker[1];
        return '';
      }

      if (/^(?: {4}|\t|\s*>)/.test(line)) {
        return '';
      }

      return line;
    })
    .join('\n')
    .replace(/(`+)[\s\S]*?\1/g, '');
}

function referencedIssues(body, context) {
  const repository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
  const references = new Set();
  const pattern =
    /\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+(https?:\/\/[^\s<>]+|(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*)(?![\w/#-])/gi;

  for (const match of prose(body).matchAll(pattern)) {
    const reference = match[1].replace(/[),.;!?]+$/, '');
    let number;

    if (/^https?:\/\//i.test(reference)) {
      let url;

      try {
        url = new URL(reference);
      } catch {
        continue;
      }

      const path = url.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/i);

      if (!path || url.origin !== context.serverUrl || path[1].toLowerCase() !== repository) {
        continue;
      }

      number = Number(path[2]);
    } else {
      const [name, id] = reference.split('#');

      if (name && name.toLowerCase() !== repository) {
        continue;
      }

      number = Number(id);
    }

    if (Number.isSafeInteger(number) && number > 0) {
      references.add(number);
    }
  }

  return [...references];
}

async function violation(pr, github, context) {
  if (pr.base.ref !== 'dev') {
    return 'PR 的目标分支必须是 `dev`；`main` 仅由维护者的发布流程更新。';
  }

  const numbers = referencedIssues(pr.body, context);

  if (numbers.length === 0) {
    return 'PR 正文缺少本仓库 issue 的关联标记。请填写 `Refs #编号`、`Closes #编号`、`Fixes #编号` 或 `Resolves #编号`。';
  }

  const failures = [];

  for (const issue_number of numbers) {
    let issue;

    try {
      ({ data: issue } = await github.rest.issues.get({ ...context.repo, issue_number }));
    } catch (error) {
      if (error.status !== 404 && error.status !== 410) {
        throw error;
      }

      failures.push(`#${issue_number} 不存在或不可访问`);
      continue;
    }

    const expectedUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/issues/${issue_number}`;

    if (issue.pull_request) {
      failures.push(`#${issue_number} 是 PR，不是 issue`);
    } else if (issue.html_url.toLowerCase() !== expectedUrl.toLowerCase()) {
      failures.push(`#${issue_number} 已不属于本仓库`);
    } else if (issue.state !== 'open') {
      failures.push(`#${issue_number} 已关闭`);
    } else if (Date.parse(issue.created_at) > Date.parse(pr.created_at)) {
      failures.push(`#${issue_number} 晚于本 PR 创建，请先提 issue 再创建 PR`);
    } else if (
      !PRIVILEGED_AUTHORS.has(issue.author_association) &&
      !issue.labels.some((label) =>
        TEMPLATE_LABELS.has(typeof label === 'string' ? label : label.name),
      )
    ) {
      // Match issue-template-guard.yml immediately, without racing its
      // asynchronous close action. Its GITHUB_TOKEN cannot trigger us.
      failures.push(`#${issue_number} 未通过 issue 模板检查`);
    } else {
      return null;
    }
  }

  return `没有有效的关联 issue：${failures.join('；')}。`;
}

module.exports = async function guard({ github, context, core }) {
  const params = { ...context.repo, pull_number: context.issue.number };
  const { data: pr } = await github.rest.pulls.get(params);

  if (pr.state !== 'open' || pr.merged) {
    core.info('PR is no longer open; nothing to enforce.');
    return;
  }

  const reason = await violation(pr, github, context);

  if (!reason) {
    core.info(`PR #${pr.number} targets dev and references an eligible issue.`);
    return;
  }

  // An edit may have fixed the policy while its issue lookup was in flight.
  const { data: current } = await github.rest.pulls.get(params);

  if (
    current.state !== 'open' ||
    current.merged ||
    current.body !== pr.body ||
    current.base.ref !== pr.base.ref
  ) {
    core.info('PR changed during validation; leaving it to the next event.');
    return;
  }

  const commentParams = { ...context.repo, issue_number: pr.number };
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...commentParams,
    per_page: 100,
  });
  const previous = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(COMMENT_MARKER),
  );
  const body = [
    COMMENT_MARKER,
    '此 PR 未满足贡献要求，现自动关闭。',
    '',
    reason,
    '',
    '请先通过 [GitHub 网页模板](' +
      context.serverUrl +
      '/' +
      context.repo.owner +
      '/' +
      context.repo.repo +
      '/issues/new/choose) 提交 issue；也可以认领已有的对应 issue。',
    'PR 必须指向 `dev`，并在正文引用至少一个先于 PR 创建、仍开放且通过模板检查的本仓库 issue。注释、代码示例和引用块中的标记不计入。',
    '若已有符合要求的 issue，可修改目标分支或正文后重新打开 PR；若需新建 issue，请先完成 issue 再创建新的 PR。',
  ].join('\n');

  if (previous) {
    if (previous.body !== body) {
      await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
    }
  } else {
    await github.rest.issues.createComment({ ...commentParams, body });
  }

  await github.rest.pulls.update({ ...params, state: 'closed' });
  core.setFailed(`Closed PR #${pr.number}: ${reason}`);
};
