// Git smart HTTP: info/refs advertisements, protocol v2 upload-pack (ls-refs, fetch),
// protocol v0 upload-pack fetch, and v0 receive-pack (push). All packs are built and
// read by hand in src/gitcore.ts; the server sends plain (non-delta) packs only.

import {
  collectForFetch,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  sidebandPackets,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { ForgeError, type Forge, type Repo } from './store.ts';
import { err, json, type Ctx, type Req, type Res } from './types.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/**
 * Cache of successful fetch responses, keyed by repository plus the raw request
 * body. A fetch response is a pure function of the (immutable) objects and the
 * request — the client's own shallow lines ride in the body — so identical
 * requests get byte-identical responses. This matters for the clone workload:
 * 50 concurrent identical shallow clones would otherwise each pay a full
 * synchronous zlib deflate on the single Node thread. Failed fetches (a want
 * that does not exist yet) are never cached, because a later push could make
 * the same request succeed. Bounded FIFO eviction keeps the cache small.
 */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheGet(key: string): Buffer | undefined {
  return fetchCache.get(key);
}

function fetchCachePut(key: string, body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, body);
}

const UPLOAD_V2_CAPS = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow thin-pack ofs-delta', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta agent=forge/1.0 shallow';
const RECEIVE_V0_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

function repoOr404(ctx: Ctx, owner: string, name: string): Repo {
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) throw new ForgeError(404, 'Not Found');
  return repo;
}

/** The tag target commit, when a ref points at an annotated tag object. */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  const target = parseTag(object.data).object;
  const targetObject = repo.objects.get(target);
  return targetObject?.type === 'commit' ? target : undefined;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs in advertisement order: HEAD, branches, tags (a tag's peeled line follows it). */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultBranch = repo.defaultBranch;
  const headTip = repo.branchTip(defaultBranch);
  lines.push({ oid: headTip ?? ZERO_OID, name: 'HEAD' });
  const branches = repo.branches();
  for (const branch of branches) lines.push({ oid: branch.sha, name: `refs/heads/${branch.name}` });
  const tags: Array<{ name: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/tags/')) tags.push({ name: ref.slice('refs/tags/'.length), oid });
  }
  tags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const tag of tags) {
    lines.push({ oid: tag.oid, name: `refs/tags/${tag.name}`, peeled: peeledOf(repo, tag.oid) });
  }
  return lines;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const preamble = encodePktLine(`# service=${service}\n`);
  const flush = Buffer.from('0000', 'ascii');
  const parts: Buffer[] = [preamble, flush];
  const lines: string[] = [];
  for (const ref of refLines(repo)) {
    if (ref.name === 'HEAD') {
      const tip = repo.branchTip(repo.defaultBranch);
      if (tip === undefined) continue; // unborn HEAD: no line; the empty-repo form below carries the capabilities
      lines.push(`${tip} HEAD`);
    } else {
      lines.push(`${ref.oid} ${ref.name}`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(encodePktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(flush);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const preamble = encodePktLine('# service=git-upload-pack\n');
  const flush = Buffer.from('0000', 'ascii');
  const lines: Buffer[] = [preamble, flush, encodePktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) lines.push(encodePktLine(`${cap}\n`));
  lines.push(flush);
  return Buffer.concat(lines);
}

/** Split a request body into its leading pkt-lines and the raw bytes after the first flush. */
function splitPktLinesAndRest(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  const hex = /^[0-9a-fA-F]{4}$/;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!hex.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      return { lines, rest: body.subarray(offset) };
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520 || offset + length > body.length) {
      throw new Error('malformed pkt-line');
    }
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

/** Parse the want/have/shallow/deepen lines of a fetch request (v2 or v0). */
function parseFetchLines(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isObjectId(oid)) req.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isObjectId(oid)) req.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0];
      if (isObjectId(oid)) req.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

function fetchPack(repo: Repo, req: FetchRequest): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const closure = collectForFetch(repo.lookup, req.wants, { depth: req.depth, haves: req.haves, shallow: req.shallow });
  const objects: GitObject[] = [];
  for (const oid of closure.objects) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: closure.shallow, unshallow: closure.unshallow };
}

function v2FetchResponse(repo: Repo, req: FetchRequest, cacheKey?: string): Buffer {
  const parts: Buffer[] = [];
  try {
    const { objects, shallow, unshallow } = fetchPack(repo, req);
    const pack = writePack(objects);
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(Buffer.from('0001', 'ascii'));
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(encodePktLine('packfile\n'));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
    const body = Buffer.concat(parts);
    if (cacheKey !== undefined) fetchCachePut(cacheKey, body);
    return body;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(Buffer.from('0001', 'ascii'));
    parts.push(encodePktLine('packfile\n'));
    for (const packet of sidebandPackets(3, Buffer.from(`${message}\n`, 'utf8'))) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, req: FetchRequest, cacheKey?: string): Buffer {
  const parts: Buffer[] = [];
  try {
    const { objects, shallow, unshallow } = fetchPack(repo, req);
    const pack = writePack(objects);
    parts.push(encodePktLine('NAK\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
    const body = Buffer.concat(parts);
    if (cacheKey !== undefined) fetchCachePut(cacheKey, body);
    return body;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    parts.push(encodePktLine('NAK\n'));
    for (const packet of sidebandPackets(3, Buffer.from(`${message}\n`, 'utf8'))) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

function v2LsRefsResponse(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD') {
      const tip = repo.branchTip(repo.defaultBranch);
      if (tip === undefined) {
        if (unborn) parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        continue;
      }
      const attrs = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(encodePktLine(`${tip} HEAD${attrs}\n`));
      continue;
    }
    const attrs: string[] = [];
    if (peel && ref.peeled) attrs.push(`peeled:${ref.peeled}`);
    parts.push(encodePktLine(`${ref.oid} ${ref.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: string[]): { commands: PushCommand[]; capabilities: Map<string, string> } {
  const commands: PushCommand[] = [];
  const capabilities = new Map<string, string>();
  lines.forEach((raw, index) => {
    const line = raw.replace(/\n$/, '');
    if (!line) return;
    let command = line;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        command = line.slice(0, nul);
        for (const token of line.slice(nul + 1).split(' ')) {
          if (!token) continue;
          const eq = token.indexOf('=');
          if (eq < 0) capabilities.set(token, '');
          else capabilities.set(token.slice(0, eq), token.slice(eq + 1));
        }
      }
    }
    const parts = command.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(command)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });
  return { commands, capabilities };
}

/** True when `descendant` is the commit `ancestor` or descends from it. */
function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

function handleReceivePack(ctx: Ctx, repo: Repo, body: Buffer): Res {
  let commands: PushCommand[] = [];
  let capabilities = new Map<string, string>();
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const split = splitPktLinesAndRest(body);
    const parsed = parsePushCommands(split.lines);
    commands = parsed.commands;
    capabilities = parsed.capabilities;
    packBytes = split.rest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = encodePktLines([`unpack ${message}\n`]);
    const framed = capabilities.has('side-band-64k') ? Buffer.concat(sidebandPackets(1, report)) : report;
    return { status: 200, raw: framed, contentType: RECEIVE_RESULT };
  }
  if (commands.length === 0) {
    const report = encodePktLines(['unpack ok\n']);
    const framed = capabilities.has('side-band-64k') ? Buffer.concat(sidebandPackets(1, report)) : report;
    return { status: 200, raw: framed, contentType: RECEIVE_RESULT };
  }
  const reportLines: string[] = [];
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes);
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackDetail = error instanceof Error ? error.message : String(error);
    }
  }
  if (unpackDetail === 'ok') {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        } else if (current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const object = repo.objects.get(command.newOid);
      if (!object) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      const isBranch = command.ref.startsWith('refs/heads/');
      if (isBranch && object.type === 'tag') {
        reportLines.push(`ng ${command.ref} not a commit\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update: old must match and the new tip must descend from it.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (!isDescendant(repo, command.newOid, command.oldOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} ${unpackDetail}\n`);
  }
  const report = encodePktLines([`unpack ${unpackDetail}\n`, ...reportLines]);
  const framed = capabilities.has('side-band-64k') ? Buffer.concat(sidebandPackets(1, report)) : report;
  return { status: 200, raw: framed, contentType: RECEIVE_RESULT };
}

/** The git smart-HTTP surface. Returns null when the path is not a git route. */
export function handleGit(ctx: Ctx, req: Req): Res | null {
  // /{owner}/{repo}.git/info/refs?service=... | /{owner}/{repo}.git/git-upload-pack | git-receive-pack
  if (req.segments.length < 2) return null;
  const repoSegment = req.segments[1];
  if (!repoSegment.endsWith('.git')) return null;
  const owner = req.segments[0];
  const name = repoSegment.slice(0, -4);
  const tail = req.segments.slice(2);
  try {
    const repo = repoOr404(ctx, owner, name);
    if (req.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = req.query.get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const body = v2 ? v2Advertisement(repo) : v0Advertisement('git-upload-pack', repo);
        return { status: 200, raw: body, contentType: UPLOAD_AD };
      }
      if (service === 'git-receive-pack') {
        return { status: 200, raw: v0Advertisement('git-receive-pack', repo), contentType: RECEIVE_AD };
      }
      return err(400, 'Missing service parameter');
    }
    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      let lines: string[];
      try {
        lines = decodePktLines(req.rawBody).filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : ''));
      } catch {
        return err(400, 'Malformed pkt-line stream');
      }
      const first = lines[0]?.replace(/\n$/, '') ?? '';
      if (first.startsWith('command=ls-refs')) {
        return { status: 200, raw: v2LsRefsResponse(repo, lines), contentType: UPLOAD_RESULT };
      }
      const cacheKey = `${repo.fullName}\0${req.rawBody.toString('utf8')}`;
      const cached = fetchCacheGet(cacheKey);
      if (cached !== undefined) {
        return { status: 200, raw: cached, contentType: UPLOAD_RESULT };
      }
      if (first.startsWith('command=fetch')) {
        return { status: 200, raw: v2FetchResponse(repo, parseFetchLines(lines), cacheKey), contentType: UPLOAD_RESULT };
      }
      if (first.startsWith('want ')) {
        return { status: 200, raw: v0FetchResponse(repo, parseFetchLines(lines), cacheKey), contentType: UPLOAD_RESULT };
      }
      return err(400, 'Unknown git-upload-pack command');
    }
    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      return handleReceivePack(ctx, repo, req.rawBody);
    }
    return err(404, 'Not Found');
  } catch (error) {
    if (error instanceof ForgeError) return json(error.status, { message: error.message });
    throw error;
  }
}
