// MCP (Model Context Protocol) over streamable HTTP, plain JSON responses.
// Both eras are supported: the modern 2026-07-28 era (server/discover first,
// every request declares its revision in _meta and the MCP-Protocol-Version
// header, no handshake or session) and the legacy era (initialize +
// notifications/initialized, optional Mcp-Session-Id).

import { ForgeError, type Forge } from './store.ts';
import { err, json, type Ctx, type Req, type Res } from './types.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// The six canonical tools, in a frozen constant so tools/list is byte-identical
// on every call. Required properties are only ones the caller can fill.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(text: string, structured?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
  const missing = missingArgs(tool, args);
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo(forge.viewer.login, String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
        const payload = { id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.isPrivate, default_branch: repo.defaultBranch };
        return toolResult(JSON.stringify(payload), payload);
      }
      case 'get_repo': {
        const repo = forge.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
        const payload = { id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.isPrivate, default_branch: repo.defaultBranch, description: repo.description };
        return toolResult(JSON.stringify(payload), payload);
      }
      case 'create_issue': {
        const repo = forge.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
        const issue = forge.createIssue(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '' });
        const payload = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
        return toolResult(JSON.stringify(payload), payload);
      }
      case 'list_issues': {
        const repo = forge.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        const payload = list.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
        return toolResult(JSON.stringify(payload));
      }
      case 'create_pull_request': {
        const repo = forge.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
        const pull = forge.createPull(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        const payload = { id: pull.id, number: pull.number, pull_number: pull.number, pull_request_number: pull.number, title: pull.title, state: pull.state, head: pull.headRef, base: pull.baseRef };
        return toolResult(JSON.stringify(payload), payload);
      }
      case 'merge_pull_request': {
        const repo = forge.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
        const pull = forge.getPull(repo, Number(args.pull_number));
        if (!pull) return toolError(`Pull request ${String(args.pull_number)} not found`);
        const sha = forge.mergePull(repo, pull, 'SQUASH');
        const payload = { merged: true, number: pull.number, pull_number: pull.number, sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` };
        return toolResult(JSON.stringify(payload), payload);
      }
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof ForgeError) return toolError(error.message);
    throw error;
  }
}

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function serverInfoBlock(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function handleRequest(forge: Forge, request: unknown): { status: number; body: unknown } | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const record = request as Record<string, unknown>;
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  // A request without an id is a notification: no response body, 202.
  if (id === undefined) return { status: 202, body: undefined };
  const params = (record.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: serverInfoBlock(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfoBlock() },
        }),
      };
    case 'initialize': {
      const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: serverInfoBlock(),
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = callTool(forge, name, args);
        return { status: 200, body: rpcResult(id, result) };
      } catch (error) {
        if (error instanceof RpcError) return { status: 200, body: rpcError(id, error.code, error.message) };
        return { status: 200, body: rpcError(id, -32603, error instanceof Error ? error.message : String(error)) };
      }
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/** Best-effort id extraction from a raw (unparseable) JSON body. */
function extractId(raw: Buffer): unknown {
  const text = raw.toString('utf8');
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (!match) return null;
  const rawId = match[1];
  if (rawId.startsWith('"')) {
    try {
      return JSON.parse(rawId);
    } catch {
      return null;
    }
  }
  return Number(rawId);
}

/** The MCP surface. Returns null when the path is not /mcp. */
export function handleMcp(ctx: Ctx, req: Req): Res | null {
  if (req.segments.join('/') !== 'mcp') return null;
  if (req.method !== 'POST') return err(405, 'Method Not Allowed');
  if (req.bodyMalformed) {
    return json(400, rpcError(extractId(req.rawBody), -32700, 'Parse error'));
  }
  if (req.body === undefined || req.body === null) {
    return json(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(req.body)) {
    const responses: unknown[] = [];
    for (const entry of req.body) {
      const outcome = handleRequest(ctx.forge, entry);
      if (outcome && outcome.body !== undefined) responses.push(outcome.body);
    }
    return json(200, responses);
  }
  const outcome = handleRequest(ctx.forge, req.body);
  if (!outcome) return json(400, rpcError(null, -32700, 'Parse error'));
  if (outcome.body === undefined) return { status: outcome.status };
  return json(outcome.status, outcome.body);
}
