// REST v3: repositories, branches, commits, contents, labels, issues, comments,
// pull requests, files and merges. One shared store; every view below reads from it.

import { ForgeError, globalId, type Comment, type Forge, type Issue, type Label, type Pull, type Repo } from './store.ts';
import { err, json, type Ctx, type Req, type Res } from './types.ts';

function repoView(repo: Repo, ctx: Ctx): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: ctx.forge.viewer.id, type: 'User', html_url: `${ctx.forge.viewer.login}` },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${repo.fullName}.git`,
    git_url: `${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch_ref: repo.defaultBranch,
  };
}

function labelView(label: Label, index: number): Record<string, unknown> {
  return {
    id: index + 1,
    node_id: globalId('label', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

function issueView(issue: Issue, repo: Repo, ctx: Ctx): Record<string, unknown> {
  const labels = issue.labels.map((name) => {
    const found = repo.labels.get(name);
    return found ? labelView(found, [...repo.labels.keys()].indexOf(name)) : { name, color: 'ededed', description: '' };
  });
  const comments = repo.comments.get(issue.number) ?? [];
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: issue.user, id: ctx.forge.viewer.id, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullView(pull: Pull, repo: Repo, forge: Forge): Record<string, unknown> {
  const headSha = forge.pullHeadSha(repo, pull);
  const baseSha = forge.pullBaseSha(repo, pull);
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: forge.pullMergeable(repo, pull) === 'MERGEABLE',
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    user: { login: pull.user, id: forge.viewer.id, type: 'User' },
    assignee: null,
    requested_reviewers: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentView(comment: Comment, repo: Repo, ctx: Ctx): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: comment.user, id: ctx.forge.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitView(repo: Repo, view: { sha: string; message: string; author: string; committer: string; timestamp: number; iso: string }, forge: Forge): Record<string, unknown> {
  const author = parseIdentity(view.author);
  const committer = parseIdentity(view.committer);
  return {
    sha: view.sha,
    node_id: globalId('commit', repo.id, view.sha),
    commit: {
      message: view.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
    },
    author: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    committer: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    parents: [],
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${view.sha}`,
  };
}

function pagination(req: Req, total: number, page: number, perPage: number): Record<string, string> {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const query = new URLSearchParams(req.query);
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `${req.baseUrl}${req.path}?${query.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page < totalPages) links.push(`<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  return links.length ? { Link: links.join(', ') } : {};
}

function pageParams(req: Req): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function bodyObject(req: Req): Record<string, unknown> {
  if (req.body === undefined || req.body === null) return {};
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new ForgeError(400, 'Invalid request body');
  return req.body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return typeof value === 'number' ? value : undefined;
}

function requireRepo(ctx: Ctx, owner: string, name: string): Repo {
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) throw new ForgeError(404, 'Not Found');
  return repo;
}

/** The REST surface. Returns null when the path is not an /api/v3 route. */
export function handleRest(ctx: Ctx, req: Req): Res | null {
  if (req.segments[0] !== 'api' || req.segments[1] !== 'v3') return null;
  const seg = req.segments.slice(2);
  const method = req.method;

  try {
    // API root and meta.
    if (seg.length === 0 && method === 'GET') {
      return json(200, {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        user_url: `${req.baseUrl}/api/v3/users/{user}`,
        rate_limit_url: `${req.baseUrl}/api/v3/rate_limit`,
      }, { 'X-Oauth-Scopes': 'repo, read:org' });
    }
    if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
      return json(200, { installed_version: '1.0.0' });
    }
    if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
      const viewer = ctx.forge.viewer;
      return json(200, {
        login: viewer.login,
        id: viewer.id,
        node_id: globalId('user', viewer.id),
        name: viewer.name,
        email: viewer.email,
        type: 'User',
        html_url: `/users/${viewer.login}`,
        url: `${req.baseUrl}/api/v3/user`,
      });
    }
    // POST /user/repos and GET /user/repos.
    if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
      if (method === 'POST') {
        if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
        const body = bodyObject(req);
        const name = stringField(body, 'name');
        if (!name) throw new ForgeError(422, 'name is required');
        const description = stringField(body, 'description') ?? '';
        const isPrivate = body.private === true;
        const repo = ctx.forge.createRepo(ctx.forge.viewer.login, name, description, isPrivate);
        return json(201, repoView(repo, ctx));
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(req);
        const all = ctx.forge.listRepos(ctx.forge.viewer.login);
        return json(200, pageOf(all, page, perPage).map((repo) => repoView(repo, ctx)), pagination(req, all.length, page, perPage));
      }
    }
    // /repos/{owner}/{name}/...
    if (seg.length >= 3 && seg[0] === 'repos') {
      const owner = seg[1];
      const name = seg[2];
      const rest = seg.slice(3);
      if (rest.length === 0) {
        if (method === 'GET') return json(200, repoView(requireRepo(ctx, owner, name), ctx));
        if (method === 'PATCH') {
          if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
          const repo = requireRepo(ctx, owner, name);
          const body = bodyObject(req);
          const description = stringField(body, 'description');
          if (description !== undefined) repo.description = description;
          const newName = stringField(body, 'name');
          if (newName !== undefined && newName !== name) {
            if (ctx.forge.getRepo(owner, newName)) throw new ForgeError(422, 'Repository already exists');
            ctx.forge.repos.delete(ctx.forge.repoKey(owner, name));
            repo.name = newName;
            ctx.forge.repos.set(ctx.forge.repoKey(owner, newName), repo);
          }
          repo.updatedAt = ctx.forge.tick().iso;
          return json(200, repoView(repo, ctx));
        }
        if (method === 'DELETE') {
          requireRepo(ctx, owner, name);
          ctx.forge.deleteRepo(owner, name);
          return { status: 204 };
        }
      }
      const repo = requireRepo(ctx, owner, name);
      return handleRepoSubroutes(ctx, req, repo, rest);
    }
    return err(404, 'Not Found');
  } catch (error) {
    if (error instanceof ForgeError) return err(error.status, error.message);
    throw error;
  }
}

function handleRepoSubroutes(ctx: Ctx, req: Req, repo: Repo, rest: string[]): Res {
  const method = req.method;
  const forge = ctx.forge;

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = repo.branches().map((b) => ({
        name: b.name,
        commit: { sha: b.sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${b.sha}` },
        protected: false,
      }));
      return json(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.branchTip(rest[1]);
      if (sha === undefined) throw new ForgeError(404, 'Not Found');
      return json(200, {
        name: rest[1],
        commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      });
    }
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
      const body = bodyObject(req);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (!ref || !sha) throw new ForgeError(422, 'ref and sha are required');
      forge.createRef(repo, ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}` });
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const sha = repo.branchTip(branch);
      if (sha === undefined) throw new ForgeError(404, 'Not Found');
      return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const sha = req.query.get('sha') ?? undefined;
    const { page, perPage } = pageParams(req);
    const all = repo.listCommits(sha);
    const views = pageOf(all, page, perPage).map((view) => commitView(repo, view, forge));
    return json(200, views, pagination(req, all.length, page, perPage));
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = req.query.get('ref') ?? undefined;
      const resolved = forge.resolveContent(repo, path, ref);
      if (!resolved) throw new ForgeError(404, 'Not Found');
      if (resolved.kind === 'file') {
        const name = path.split('/').pop() ?? path;
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: resolved.data.length,
          name,
          path,
          content: resolved.data.toString('base64'),
          sha: resolved.oid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: `/repos/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
          git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${resolved.oid}`,
          download_url: `/repos/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
        });
      }
      return json(200, resolved.entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
        html_url: `/repos/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${entry.path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
        download_url: entry.mode === '40000' ? null : `/repos/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${entry.path}`,
      })));
    }
    if (method === 'PUT') {
      if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
      const body = bodyObject(req);
      const message = stringField(body, 'message') ?? '';
      const content = stringField(body, 'content');
      if (content === undefined) throw new ForgeError(422, 'content is required');
      const branch = stringField(body, 'branch');
      const sha = stringField(body, 'sha');
      const result = forge.commitFile(repo, {
        path,
        content: Buffer.from(content, 'base64'),
        message,
        branch: branch ?? undefined,
        sha: sha ?? undefined,
      });
      return json(result.created ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.contentSha,
          size: Buffer.from(content, 'base64').length,
          encoding: 'base64',
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        },
        commit: { sha: result.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
      const body = bodyObject(req);
      const message = stringField(body, 'message') ?? '';
      const sha = stringField(body, 'sha');
      const commitSha = forge.deleteFile(repo, { path, message, sha: sha ?? undefined });
      return json(200, { commit: { sha: commitSha, message } });
    }
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
      const body = bodyObject(req);
      const name = stringField(body, 'name');
      if (!name) throw new ForgeError(422, 'name is required');
      const color = stringField(body, 'color') ?? 'ededed';
      const description = stringField(body, 'description') ?? '';
      const label = forge.createLabel(repo, name, color, description);
      return json(201, labelView(label, [...repo.labels.keys()].indexOf(name)));
    }
    if (rest.length === 1 && method === 'GET') {
      return json(200, [...repo.labels.values()].map((label, i) => labelView(label, i)));
    }
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
        const body = bodyObject(req);
        const title = stringField(body, 'title');
        if (!title) throw new ForgeError(422, 'title is required');
        const issueBody = stringField(body, 'body') ?? '';
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        const issue = forge.createIssue(repo, { title, body: issueBody, labels });
        return json(201, issueView(issue, repo, ctx));
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(req);
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'asc';
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        if (sort === 'created' && direction === 'desc') list.reverse();
        return json(200, pageOf(list, page, perPage).map((issue) => issueView(issue, repo, ctx)), pagination(req, list.length, page, perPage));
      }
    }
    const number = Number(rest[1]);
    if (Number.isInteger(number) && number > 0) {
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = forge.getIssue(repo, number);
          if (!issue) throw new ForgeError(404, 'Not Found');
          return json(200, issueView(issue, repo, ctx));
        }
        if (method === 'PATCH') {
          if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
          const body = bodyObject(req);
          const issue = forge.patchIssue(repo, number, {
            state: stringField(body, 'state'),
            title: stringField(body, 'title'),
            body: stringField(body, 'body'),
          });
          return json(200, issueView(issue, repo, ctx));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
          const body = bodyObject(req);
          const text = stringField(body, 'body');
          if (text === undefined) throw new ForgeError(422, 'body is required');
          const comment = forge.addComment(repo, number, text);
          return json(201, commentView(comment, repo, ctx));
        }
        if (method === 'GET') {
          const issue = forge.getIssue(repo, number);
          if (!issue) throw new ForgeError(404, 'Not Found');
          const comments = repo.comments.get(number) ?? [];
          return json(200, comments.map((c) => commentView(c, repo, ctx)));
        }
      }
    }
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
        const body = bodyObject(req);
        const title = stringField(body, 'title');
        const head = stringField(body, 'head');
        const base = stringField(body, 'base');
        if (!title || !head || !base) throw new ForgeError(422, 'title, head and base are required');
        const pullBody = stringField(body, 'body') ?? '';
        const pull = forge.createPull(repo, { title, body: pullBody, head, base });
        return json(201, pullView(pull, repo, forge));
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(req);
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        return json(200, pageOf(list, page, perPage).map((pull) => pullView(pull, repo, forge)), pagination(req, list.length, page, perPage));
      }
    }
    const number = Number(rest[1]);
    if (Number.isInteger(number) && number > 0) {
      if (rest.length === 2 && method === 'GET') {
        const pull = forge.getPull(repo, number);
        if (!pull) throw new ForgeError(404, 'Not Found');
        return json(200, pullView(pull, repo, forge));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = forge.getPull(repo, number);
        if (!pull) throw new ForgeError(404, 'Not Found');
        return json(200, forge.pullFiles(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (req.bodyMalformed) throw new ForgeError(400, 'Invalid JSON body');
        const pull = forge.getPull(repo, number);
        if (!pull) throw new ForgeError(404, 'Not Found');
        const body = bodyObject(req);
        const methodName = stringField(body, 'merge_method') ?? '';
        const mergeSha = forge.mergePull(repo, pull, methodName);
        return json(200, { merged: true, sha: mergeSha, message: `Pull request #${number} merged` });
      }
    }
  }

  throw new ForgeError(404, 'Not Found');
}
