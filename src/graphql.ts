// GraphQL v4: a small parser and executor for exactly the documents gh and
// github-mcp-server send (viewer, repository fields, __type probes, issue and
// pull-request reads, the create/close/merge mutations, node(id:), batching).
// No directives, no subscriptions, no named fragments beyond inline `... on Type`.

import { decodeGlobalId, globalId, ForgeError, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { err, json, type Ctx, type Req, type Res } from './types.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias?: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition?: string;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: string[];
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1];
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === '"') out += '"';
          else if (next === '\\') out += '\\';
          else if (next === '/') out += '/';
          else out += next;
          i += 2;
        } else {
          out += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables: string[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      // A named fragment spread: skip it (the documents do not use named fragments).
      this.expectName();
      return { kind: 'fragment', selections: [] };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(args: Array<{ name: string; value: Value }>, name: string, variables: Record<string, unknown>): unknown {
  const found = args.find((a) => a.name === name);
  return found ? resolveValue(found.value, variables) : undefined;
}

// ---------------------------------------------------------------- nodes

type Node =
  | { __typename: 'Query' }
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; nodes: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; paths: string[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'Type'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { __typename: 'MutationResult'; payload: Record<string, unknown> };

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'url'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommitSha', 'headRef', 'baseRef', 'author', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'MILESTONE', 'LABEL', 'WIKI'];

function typeInfo(name: string): Node | null {
  switch (name) {
    case 'Issue':
      return { __typename: 'Type', name, kind: 'OBJECT', fields: ISSUE_TYPE_FIELDS, enumValues: [] };
    case 'PullRequest':
      return { __typename: 'Type', name, kind: 'OBJECT', fields: PULL_TYPE_FIELDS, enumValues: [] };
    case 'Repository':
      return { __typename: 'Type', name, kind: 'OBJECT', fields: REPO_TYPE_FIELDS, enumValues: [] };
    case 'SearchType':
      return { __typename: 'Type', name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES };
    case 'User':
      return { __typename: 'Type', name, kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: [] };
    case 'IssueState':
      return { __typename: 'Type', name, kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] };
    case 'PullRequestState':
      return { __typename: 'Type', name, kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] };
    case 'MergeableState':
      return { __typename: 'Type', name, kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] };
    case 'RepositoryPermission':
      return { __typename: 'Type', name, kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueCursor(issue: Issue): string {
  return Buffer.from(`issue:${issue.number}`, 'utf8').toString('base64');
}

function resolveIssueConnection(forge: Forge, repo: Repo, args: Array<{ name: string; value: Value }>, variables: Record<string, unknown>): Node {
  const first = argValue(args, 'first', variables);
  const after = argValue(args, 'after', variables);
  const states = argValue(args, 'states', variables);
  const orderBy = argValue(args, 'orderBy', variables) as Record<string, unknown> | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  const field = orderBy?.field;
  if (field === 'CREATED_AT' || field === 'UPDATED_AT' || field === undefined) {
    list.sort((a, b) => (a.number - b.number) * direction);
  }
  if (typeof after === 'string' && after !== '') {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const match = /^issue:(\d+)$/.exec(text);
      if (match) {
        const index = list.findIndex((issue) => issue.number === Number(match[1]));
        if (index >= 0) list = list.slice(index + 1);
      }
    } catch {
      // An unreadable cursor starts from the beginning.
    }
  }
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]) : null;
  return {
    __typename: 'IssueConnection',
    repo,
    nodes: page,
    pageInfo: { hasNextPage, endCursor },
  };
}

function resolveNode(forge: Forge, id: string): Node | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const kind = decoded.kind;
  const parts = decoded.parts;
  if (kind === 'repo') {
    const repoId = Number(parts[0]);
    for (const repo of forge.repos.values()) if (repo.id === repoId) return { __typename: 'Repository', repo };
    return null;
  }
  if (kind === 'issue') {
    const repoId = Number(parts[0]);
    const number = Number(parts[1]);
    for (const repo of forge.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = forge.getIssue(repo, number);
      if (issue) return { __typename: 'Issue', repo, issue };
    }
    return null;
  }
  if (kind === 'pull') {
    const repoId = Number(parts[0]);
    const number = Number(parts[1]);
    for (const repo of forge.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = forge.getPull(repo, number);
      if (pull) return { __typename: 'PullRequest', repo, pull };
    }
    return null;
  }
  return null;
}

function resolveRepoByGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'repo') return null;
  const repoId = Number(decoded.parts[0]);
  for (const repo of forge.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function resolveIssueByGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const node = resolveNode(forge, id);
  if (node?.__typename === 'Issue') return { repo: node.repo, issue: node.issue };
  return null;
}

function resolvePullByGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const node = resolveNode(forge, id);
  if (node?.__typename === 'PullRequest') return { repo: node.repo, pull: node.pull };
  return null;
}

function executeMutation(forge: Forge, field: FieldSelection, variables: Record<string, unknown>, ctx: ExecCtx): Record<string, unknown> {
  const input = (argValue(field.args, 'input', variables) ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = resolveRepoByGlobalId(forge, input.repositoryId);
      if (!repo) throw new Error(`createIssue: unknown repository ${String(input.repositoryId)}`);
      const issue = forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { issue: { __typename: 'Issue', repo, issue } };
    }
    case 'closeIssue': {
      const found = resolveIssueByGlobalId(forge, input.issueId);
      if (!found) throw new Error(`closeIssue: unknown issue ${String(input.issueId)}`);
      forge.patchIssue(found.repo, found.issue.number, { state: 'closed' });
      return { issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } };
    }
    case 'createPullRequest': {
      const repo = resolveRepoByGlobalId(forge, input.repositoryId);
      if (!repo) throw new Error(`createPullRequest: unknown repository ${String(input.repositoryId)}`);
      const pull = forge.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { pullRequest: { __typename: 'PullRequest', repo, pull } };
    }
    case 'mergePullRequest': {
      const found = resolvePullByGlobalId(forge, input.pullRequestId);
      if (!found) throw new Error(`mergePullRequest: unknown pull request ${String(input.pullRequestId)}`);
      forge.mergePull(found.repo, found.pull, String(input.mergeMethod ?? 'SQUASH'));
      return { pullRequest: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } };
    }
    case 'addComment': {
      const found = resolveIssueByGlobalId(forge, input.subjectId);
      if (!found) throw new Error(`addComment: unknown subject ${String(input.subjectId)}`);
      const comment = forge.addComment(found.repo, found.issue.number, String(input.body ?? ''));
      return { commentEdge: { node: { id: comment.nodeId, body: comment.body } } };
    }
    default:
      throw new Error(`unknown mutation ${field.name}`);
  }
}

/** Resolve one field of a node to its raw value (scalar, node, array of nodes, or null). */
function resolveField(forge: Forge, node: Node, field: FieldSelection, ctx: ExecCtx): unknown {
  const args = field.args;
  const variables = ctx.variables;
  switch (node.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: forge.viewer.login, id: forge.viewer.id };
      if (field.name === 'repository') {
        const owner = String(argValue(args, 'owner', variables) ?? '');
        const name = String(argValue(args, 'name', variables) ?? '');
        const repo = forge.getRepo(owner, name);
        return repo ? { __typename: 'Repository', repo } : null;
      }
      if (field.name === 'node') {
        const id = String(argValue(args, 'id', variables) ?? '');
        return resolveNode(forge, id);
      }
      if (field.name === '__type') {
        const name = String(argValue(args, 'name', variables) ?? '');
        return typeInfo(name);
      }
      return undefined;
    }
    case 'User': {
      if (field.name === 'login') return node.login;
      if (field.name === 'id') return globalId('user', node.id);
      if (field.name === 'name') return forge.viewer.name;
      if (field.name === 'email') return forge.viewer.email;
      return undefined;
    }
    case 'Repository': {
      const repo = node.repo;
      switch (field.name) {
        case 'id':
          return globalId('repo', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { __typename: 'User', login: repo.owner, id: forge.viewer.id };
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.isPrivate;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'url':
          return `/repos/${repo.owner}/${repo.name}`;
        case 'issue': {
          const number = argValue(args, 'number', variables);
          const issue = typeof number === 'number' ? forge.getIssue(repo, number) : undefined;
          return issue ? { __typename: 'Issue', repo, issue } : null;
        }
        case 'issues':
          return resolveIssueConnection(forge, repo, args, variables);
        case 'pullRequests': {
          const first = argValue(args, 'first', variables);
          const list = typeof first === 'number' ? repo.pulls.slice(0, first) : [...repo.pulls];
          return { __typename: 'PullRequestConnection', repo, nodes: list };
        }
        case 'pullRequest': {
          const number = argValue(args, 'number', variables);
          const pull = typeof number === 'number' ? forge.getPull(repo, number) : undefined;
          return pull ? { __typename: 'PullRequest', repo, pull } : null;
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = node.issue;
      switch (field.name) {
        case 'id':
          return issue.nodeId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'author':
          return { __typename: 'User', login: issue.user, id: forge.viewer.id };
        case 'url':
          return `/repos/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = node.pull;
      switch (field.name) {
        case 'id':
          return pull.nodeId;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return forge.pullMergeable(node.repo, pull);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.closedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommitSha':
          return pull.mergeCommitSha;
        case 'author':
          return { __typename: 'User', login: pull.user, id: forge.viewer.id };
        case 'url':
          return `/repos/${node.repo.owner}/${node.repo.name}/pull/${pull.number}`;
        case 'files': {
          const first = argValue(args, 'first', variables);
          const files = forge.pullFiles(node.repo, pull);
          const paths = files.map((f) => f.filename);
          const limited = typeof first === 'number' ? paths.slice(0, first) : paths;
          return { __typename: 'PullRequestChangedFileConnection', paths: limited };
        }
        default:
          return undefined;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return node.nodes.map((issue) => ({ __typename: 'Issue', repo: node.repo, issue }));
      }
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', ...node.pageInfo };
      if (field.name === 'totalCount') return node.nodes.length;
      return undefined;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return node.nodes.map((pull) => ({ __typename: 'PullRequest', repo: node.repo, pull }));
      }
      return undefined;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') {
        return node.paths.map((path) => ({ __typename: 'PullRequestChangedFile', path }));
      }
      return undefined;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return node.path;
      return undefined;
    }
    case 'Ref': {
      if (field.name === 'name') return node.name;
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'endCursor') return node.endCursor;
      return undefined;
    }
    case 'Type': {
      if (field.name === 'name') return node.name;
      if (field.name === 'kind') return node.kind;
      if (field.name === 'fields') return node.fields.map((name) => ({ name }));
      if (field.name === 'enumValues') return node.enumValues.map((name) => ({ name }));
      return undefined;
    }
    case 'MutationResult': {
      const value = node.payload[field.name];
      return value;
    }
    default:
      return undefined;
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>);
}

/** Execute a selection set against a node, returning the response object. */
function executeSelections(forge: Forge, node: Node, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== node.__typename) continue;
      const inner = executeSelections(forge, node, selection.selections, ctx);
      Object.assign(out, inner);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(forge, node, selection, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${node.__typename}".` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(forge, value, selection.selections, ctx);
  }
  return out;
}

function completeValue(forge: Forge, value: unknown, selections: Selection[], ctx: ExecCtx): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(forge, entry, selections, ctx));
  if (isNode(value)) {
    if (selections.length === 0) return null;
    return executeSelections(forge, value, selections, ctx);
  }
  if (typeof value === 'object') {
    // A plain object (a mutation payload or a {name} field entry): resolve its fields.
    if (selections.length === 0) return value;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      const key = selection.alias ?? selection.name;
      const raw = (value as Record<string, unknown>)[selection.name];
      if (raw === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Object".` });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(forge, raw, selection.selections, ctx);
    }
    return out;
  }
  return value;
}

function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const ctx: ExecCtx = { forge, variables, errors: [] };
  if (operation.kind === 'mutation') {
    const out: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      if (selection.kind === 'fragment') continue;
      const key = selection.alias ?? selection.name;
      try {
        const payload = executeMutation(forge, selection, variables, ctx);
        out[key] = completeValue(forge, { __typename: 'MutationResult', payload } as Node, selection.selections, ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        out[key] = null;
      }
    }
    return { data: out, errors: ctx.errors };
  }
  const data = executeSelections(forge, { __typename: 'Query' }, operation.selections, ctx);
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------- HTTP

function executeDocument(forge: Forge, document: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let operations: Operation[];
  try {
    operations = new Parser(document).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) {
    operation = operations.find((op) => op.name === operationName);
    if (!operation) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    operation = operations[0];
  }
  if (!operation) return { errors: [{ message: 'No operation in document.' }] };
  const { data, errors } = executeOperation(forge, operation, variables);
  const out: Record<string, unknown> = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

/** The GraphQL surface. Returns null when the path is not /api/graphql. */
export function handleGraphql(ctx: Ctx, req: Req): Res | null {
  if (req.segments.join('/') !== 'api/graphql') return null;
  if (req.method !== 'POST') return err(405, 'Method Not Allowed');
  if (req.bodyMalformed) return err(400, 'Invalid JSON body');
  const body = req.body;
  if (body === undefined || body === null) return err(400, 'Missing request body');
  if (Array.isArray(body)) {
    const responses = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid operation document.' }] };
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      return executeDocument(ctx.forge, query, variables, operationName);
    });
    return json(200, responses);
  }
  if (typeof body !== 'object') return err(400, 'Invalid request body');
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  return json(200, executeDocument(ctx.forge, query, variables, operationName));
}
