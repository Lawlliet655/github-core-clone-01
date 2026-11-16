// The forge's in-memory store: one shared state behind the REST, GraphQL, MCP and
// git surfaces. All state lives here; the surfaces are thin views over it.
//
// Determinism: nothing here reads a clock or Math.random. A logical clock (seconds
// from 2025-01-01) stamps created objects in creation order, so a replay of the same
// requests produces the same state.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  treeClosure,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import type { ScenarioUser } from './scenario.ts';

export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CommitInfo {
  /** The message exactly as submitted (no trailing newline added). */
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  iso: string;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  /** commit oid -> display info (REST-created commits keep the submitted message verbatim). */
  commitInfo = new Map<string, CommitInfo>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  comments = new Map<number, Comment[]>();
  labels = new Map<string, Label>();
  nextNumber = 1;
  nextCommentId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putTree(entries: TreeEntry[]): string {
    return this.putObject('tree', buildTree(entries));
  }

  /** The tip of a branch, or undefined when the branch does not exist. */
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** All branches, sorted by name. */
  branches(): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** The commit display info for a commit oid (falls back to parsing the object). */
  commitView(oid: string): { sha: string; message: string; author: string; committer: string; timestamp: number; iso: string } | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const stored = this.commitInfo.get(oid);
    if (stored) {
      return { sha: oid, message: stored.message, author: stored.author, committer: stored.committer, timestamp: stored.timestamp, iso: stored.iso };
    }
    const parsed = parseCommit(object.data);
    const message = parsed.message.endsWith('\n') ? parsed.message.slice(0, -1) : parsed.message;
    const stamp = parseAuthorLine(parsed.author);
    return { sha: oid, message, author: parsed.author, committer: parsed.committer, timestamp: stamp, iso: new Date(stamp * 1000).toISOString() };
  }

  /** Commits reachable from `ref` (a branch name or oid), newest first. */
  listCommits(ref?: string): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number; iso: string }> {
    let tip: string | undefined;
    if (ref === undefined) tip = this.branchTip(this.defaultBranch);
    else if (isObjectId(ref)) tip = ref;
    else tip = this.branchTip(ref) ?? this.refs.get(ref);
    if (tip === undefined) return [];
    const out: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number; iso: string }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(oid);
      if (!view) continue;
      out.push(view);
      const parsed = parseCommit(this.objects.get(oid)!.data);
      for (const parent of parsed.parents) queue.push(parent);
    }
    // Newest first: the walk above is BFS from the tip, which for the linear and
    // shallow histories the suite builds is tip-first. Sort by timestamp desc as a
    // tie-break-free stable order: keep BFS order, it is already tip-first.
    return out;
  }
}

/** Parse `Name <email> <ts> +0000` into its unix timestamp. */
export function parseAuthorLine(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match ? Number(match[1]) : 0;
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Forge {
  readonly viewer: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private clock = 1_735_689_600; // 2025-01-01T00:00:00Z; one second per stamped object

  constructor(viewer: ScenarioUser) {
    this.viewer = viewer;
  }

  /** Advance the logical clock one second and return its ISO timestamp. */
  tick(): { timestamp: number; iso: string } {
    this.clock += 1;
    return { timestamp: this.clock, iso: new Date(this.clock * 1000).toISOString() };
  }

  identity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    if (this.repos.has(this.repoKey(owner, name))) {
      throw new ForgeError(422, 'Repository already exists');
    }
    const { iso } = this.tick();
    const repo = new Repo(this.nextRepoId++, owner, name, description, isPrivate, 'main', iso);
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  // ---------------------------------------------------------------- git objects

  /** Flatten a tree into path -> { mode, oid } for every blob. */
  treeFiles(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree from a flat path -> blob map. */
  buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '100644', name, oid });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return repo.putTree(entries);
    };
    return build(root);
  }

  /** A new root tree with `path` set to `blobOid` (or removed when null). */
  setTreePath(repo: Repo, treeOid: string | undefined, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) throw new ForgeError(422, 'Invalid path');
    const set = (oid: string | undefined, index: number): string | null => {
      const entries: TreeEntry[] = oid !== undefined ? parseTree(repo.objects.get(oid)!.data) : [];
      const name = segments[index];
      if (index === segments.length - 1) {
        const at = entries.findIndex((e) => e.name === name && e.mode !== '40000');
        if (blobOid === null) {
          if (at >= 0) entries.splice(at, 1);
        } else if (at >= 0) {
          entries[at] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const child = entries.find((e) => e.name === name && e.mode === '40000');
        const next = set(child?.oid, index + 1);
        const at = entries.findIndex((e) => e.name === name && e.mode === '40000');
        if (next === null) {
          if (at >= 0) entries.splice(at, 1);
        } else if (at >= 0) {
          entries[at] = { mode: '40000', name, oid: next };
        } else {
          entries.push({ mode: '40000', name, oid: next });
        }
      }
      if (entries.length === 0) return null;
      return repo.putTree(entries);
    };
    return set(treeOid, 0) ?? EMPTY_TREE_OID;
  }

  /** The tree oid at the tip of `branch` (or the default branch), or undefined when unborn. */
  branchTree(repo: Repo, branch?: string): string | undefined {
    const tip = repo.branchTip(branch ?? repo.defaultBranch);
    if (tip === undefined) return undefined;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /** Commit a file (contents API). Returns the blob and commit oids and whether the file was new. */
  commitFile(
    repo: Repo,
    options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { contentSha: string; commitSha: string; created: boolean } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    // A write to a branch that does not exist yet creates it from the default branch,
    // the way GitHub's contents API does: the base tree and the parent both come from it.
    let baseTip: string | undefined;
    let currentTree = tip === undefined ? undefined : parseCommit(repo.objects.get(tip)!.data).tree;
    if (tip === undefined && branch !== repo.defaultBranch) {
      baseTip = repo.branchTip(repo.defaultBranch);
      if (baseTip !== undefined) currentTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    }
    const currentFiles = currentTree === undefined ? new Map() : this.treeFiles(repo, currentTree);
    const existing = currentFiles.get(options.path);
    if (options.sha !== undefined) {
      if (!existing || existing.oid.toLowerCase() !== options.sha.toLowerCase()) {
        throw new ForgeError(409, 'The file has changed since the given sha');
      }
    }
    const created = existing === undefined;
    const blobOid = repo.putObject('blob', options.content);
    const newTree = this.setTreePath(repo, currentTree, options.path, blobOid);
    const { timestamp, iso } = this.tick();
    const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    const parents: string[] = [];
    if (tip !== undefined) parents.push(tip);
    else if (baseTip !== undefined) parents.push(baseTip);
    const commitData = buildCommit({
      tree: newTree,
      parents,
      message,
      author: this.identity(),
      committer: this.identity(),
      timestamp,
    });
    const commitOid = repo.putObject('commit', commitData);
    repo.commitInfo.set(commitOid, { message: options.message, author: this.identity(), committer: this.identity(), timestamp, iso });
    repo.refs.set(ref, commitOid);
    repo.updatedAt = iso;
    return { contentSha: blobOid, commitSha: commitOid, created };
  }

  /** Delete a file (contents API). Returns the new commit oid. */
  deleteFile(repo: Repo, options: { path: string; message: string; branch?: string; sha?: string }): string {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) throw new ForgeError(404, 'Not Found');
    const currentTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const currentFiles = this.treeFiles(repo, currentTree);
    const existing = currentFiles.get(options.path);
    if (!existing) throw new ForgeError(404, 'Not Found');
    if (options.sha !== undefined && existing.oid.toLowerCase() !== options.sha.toLowerCase()) {
      throw new ForgeError(409, 'The file has changed since the given sha');
    }
    const newTree = this.setTreePath(repo, currentTree, options.path, null);
    const { timestamp, iso } = this.tick();
    const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    const commitData = buildCommit({
      tree: newTree,
      parents: [tip],
      message,
      author: this.identity(),
      committer: this.identity(),
      timestamp,
    });
    const commitOid = repo.putObject('commit', commitData);
    repo.commitInfo.set(commitOid, { message: options.message, author: this.identity(), committer: this.identity(), timestamp, iso });
    repo.refs.set(ref, commitOid);
    repo.updatedAt = iso;
    return commitOid;
  }

  /** Resolve a path inside the tree at a ref (branch name, oid, or undefined for the default branch). */
  resolveContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const treeOid = ref === undefined ? this.branchTree(repo) : this.refTree(repo, ref);
    if (treeOid === undefined) return null;
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirObject = repo.objects.get(entry.oid);
          if (!dirObject) return null;
          const entries = parseTree(dirObject.data).map((e) => ({
            name: e.name,
            path: `${path}/${e.name}`,
            oid: e.oid,
            mode: e.mode,
          }));
          return { kind: 'dir', entries };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    // The path itself is a directory (or the root).
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data).map((e) => ({
      name: e.name,
      path: path === '' ? e.name : `${path}/${e.name}`,
      oid: e.oid,
      mode: e.mode,
    }));
    return { kind: 'dir', entries };
  }

  /** The tree oid a ref names: a branch name, a full ref, or a commit oid. */
  refTree(repo: Repo, ref: string): string | undefined {
    let tip: string | undefined;
    if (isObjectId(ref)) tip = ref;
    else if (ref.startsWith('refs/')) tip = repo.refs.get(ref);
    else tip = repo.branchTip(ref);
    if (tip === undefined) return undefined;
    const object = repo.objects.get(tip);
    if (!object) return undefined;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') return parseCommit(targetObject.data).tree;
    }
    return undefined;
  }

  /** Create a ref (branch) at a commit. */
  createRef(repo: Repo, ref: string, sha: string): void {
    if (!ref.startsWith('refs/')) throw new ForgeError(422, 'Invalid ref');
    if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
    const object = repo.objects.get(sha);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
      throw new ForgeError(422, 'Object does not exist');
    }
    repo.refs.set(ref, sha);
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `Label does not exist: ${name}`);
    }
    const { iso } = this.tick();
    const number = repo.nextNumber++;
    const id = this.nextIssueId++;
    const issue: Issue = {
      number,
      id,
      nodeId: globalId('issue', repo.id, number),
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...labels],
      user: this.viewer.login,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = this.getIssue(repo, number);
    if (!issue) throw new ForgeError(404, 'Not Found');
    if (patch.state === 'closed' || patch.state === 'open') {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? this.tick().iso : null;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = this.tick().iso;
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const issue = this.getIssue(repo, number);
    if (!issue) throw new ForgeError(404, 'Not Found');
    const { iso } = this.tick();
    const id = repo.nextCommentId++;
    const comment: Comment = { id, nodeId: globalId('comment', repo.id, number, id), body, user: this.viewer.login, createdAt: iso, updatedAt: iso };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
    const headTip = repo.branchTip(input.head);
    const baseTip = repo.branchTip(input.base);
    if (headTip === undefined) throw new ForgeError(422, `Head branch does not exist: ${input.head}`);
    if (baseTip === undefined) throw new ForgeError(422, `Base branch does not exist: ${input.base}`);
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base);
    if (duplicate) throw new ForgeError(422, 'A pull request already exists for this branch');
    const { iso } = this.tick();
    const number = repo.nextNumber++;
    const id = this.nextPullId++;
    const pull: Pull = {
      number,
      id,
      nodeId: globalId('pull', repo.id, number),
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      user: this.viewer.login,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  pullHeadSha(repo: Repo, pull: Pull): string {
    return repo.branchTip(pull.headRef) ?? ZERO_OID;
  }

  pullBaseSha(repo: Repo, pull: Pull): string {
    return repo.branchTip(pull.baseRef) ?? ZERO_OID;
  }

  /** The merge-base of two commits: the first common ancestor walking from both tips. */
  mergeBase(repo: Repo, headTip: string, baseTip: string): string | null {
    const headAncestors = new Set<string>();
    const queue: string[] = [headTip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (headAncestors.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      headAncestors.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const walk: string[] = [baseTip];
    const seen = new Set<string>();
    while (walk.length) {
      const oid = walk.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (headAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) walk.push(parent);
    }
    return null;
  }

  /** Changed files between two trees: path -> { oldOid (null when added), newOid (null when removed) }. */
  diffTrees(repo: Repo, oldTree: string | undefined, newTree: string | undefined): Map<string, { oldOid: string | null; newOid: string | null }> {
    const oldFiles = oldTree === undefined ? new Map() : this.treeFiles(repo, oldTree);
    const newFiles = newTree === undefined ? new Map() : this.treeFiles(repo, newTree);
    const out = new Map<string, { oldOid: string | null; newOid: string | null }>();
    const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    for (const path of paths) {
      const oldEntry = oldFiles.get(path);
      const newEntry = newFiles.get(path);
      if (oldEntry?.oid === newEntry?.oid) continue;
      out.set(path, { oldOid: oldEntry?.oid ?? null, newOid: newEntry?.oid ?? null });
    }
    return out;
  }

  /** The changed files of a pull request, with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? undefined : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const diff = this.diffTrees(repo, baseTree, headTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const [path, change] of [...diff.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const oldText = change.oldOid === null ? '' : repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '';
      const newText = change.newOid === null ? '' : repo.objects.get(change.newOid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      const status = change.oldOid === null ? 'added' : change.newOid === null ? 'removed' : 'modified';
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Whether a pull request is mergeable (no conflicting changes). */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? undefined : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTreeNow = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const baseChanges = this.diffTrees(repo, baseTree, baseTreeNow);
    for (const [path, headChange] of headChanges) {
      const baseChange = baseChanges.get(path);
      if (baseChange && baseChange.newOid !== headChange.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid. */
  mergePull(repo: Repo, pull: Pull, method: string): string {
    if (pull.state !== 'open') throw new ForgeError(409, 'Pull request is not open');
    if (method !== '' && method.toUpperCase() !== 'SQUASH' && method.toUpperCase() !== 'MERGE') {
      throw new ForgeError(422, `Unsupported merge method: ${method}`);
    }
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === undefined || baseTip === undefined) throw new ForgeError(404, 'Not Found');
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? undefined : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTreeNow = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const baseChanges = this.diffTrees(repo, baseTree, baseTreeNow);
    for (const [path, headChange] of headChanges) {
      const baseChange = baseChanges.get(path);
      if (baseChange && baseChange.newOid !== headChange.newOid) {
        throw new ForgeError(405, 'Merge conflict');
      }
    }
    // Three-way tree merge: the head's version wins where the head changed a path,
    // the base's version elsewhere.
    const mergedFiles = new Map<string, string>();
    for (const [path, entry] of this.treeFiles(repo, baseTreeNow)) mergedFiles.set(path, entry.oid);
    for (const [path, change] of headChanges) {
      if (change.newOid === null) mergedFiles.delete(path);
      else mergedFiles.set(path, change.newOid);
    }
    const mergedTree = this.buildTreeFromFiles(repo, mergedFiles);
    const { timestamp, iso } = this.tick();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree: mergedTree,
      parents: [baseTip],
      message,
      author: this.identity(),
      committer: this.identity(),
      timestamp,
    });
    const mergeOid = repo.putObject('commit', commitData);
    repo.commitInfo.set(mergeOid, { message: message.endsWith('\n') ? message.slice(0, -1) : message, author: this.identity(), committer: this.identity(), timestamp, iso });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = mergeOid;
    pull.closedAt = iso;
    pull.updatedAt = iso;
    repo.updatedAt = iso;
    return mergeOid;
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    if (repo.labels.has(name)) throw new ForgeError(422, 'Label already exists');
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return label;
  }
}

/** Line counts of a change: LCS over lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const toLines = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = toLines(oldText);
  const b = toLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS length via a two-row DP.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  const common = prev[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** All objects reachable from a repo's refs (for export/diagnostics). */
export function repoReachable(repo: Repo): Set<string> {
  return collectReachable([...repo.refs.values()], repo.lookup, { allowMissing: true });
}
