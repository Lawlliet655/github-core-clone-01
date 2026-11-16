// The HTTP server: one Node process, stdlib only. Routes requests to the four
// surfaces (git smart-HTTP, REST v3, GraphQL, MCP), enforces bearer-token auth
// on every API surface, stamps every reply with X-GitHub-Request-Id, and
// answers anything else with a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildScenario } from './scenario.ts';
import { Forge, ForgeError } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { err, json, type Ctx, type Req, type Res } from './types.ts';

let requestCounter = 0;

/** A fresh forge whose viewer is the deterministic scenario viewer. */
export function createForge(): Forge {
  return new Forge(buildScenario().viewer);
}

function isApiPath(segments: string[]): boolean {
  return (
    (segments[0] === 'api' && segments[1] === 'v3') ||
    segments.join('/') === 'api/graphql' ||
    segments.join('/') === 'mcp'
  );
}

function bearerToken(headers: Record<string, string>): string | null {
  const authorization = headers.authorization;
  if (!authorization) return null;
  const match = /^Bearer (.+)$/.exec(authorization);
  return match ? match[1] : null;
}

function sendResponse(res: ServerResponse, result: Res): void {
  const headers: Record<string, string> = { ...(result.headers ?? {}) };
  requestCounter += 1;
  headers['X-GitHub-Request-Id'] = `req-${String(requestCounter).padStart(6, '0')}`;
  if (result.raw !== undefined) {
    headers['Content-Type'] = result.contentType ?? 'application/octet-stream';
    headers['Content-Length'] = String(result.raw.length);
    res.writeHead(result.status, headers);
    res.end(result.raw);
    return;
  }
  headers['Content-Type'] = result.contentType ?? 'application/json';
  if (result.body === undefined) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(result.body);
  headers['Content-Length'] = String(Buffer.byteLength(text, 'utf8'));
  res.writeHead(result.status, headers);
  res.end(text);
}

function route(ctx: Ctx, req: Req): Res {
  try {
    if (req.method === 'GET' && req.segments.length === 1 && req.segments[0] === 'healthz') {
      return json(200, { ok: true });
    }
    if (isApiPath(req.segments)) {
      if (req.token === null || req.token !== ctx.token) {
        return err(401, 'Bad credentials');
      }
    }
    const git = handleGit(ctx, req);
    if (git) return git;
    const rest = handleRest(ctx, req);
    if (rest) return rest;
    const graphql = handleGraphql(ctx, req);
    if (graphql) return graphql;
    const mcp = handleMcp(ctx, req);
    if (mcp) return mcp;
    return err(404, 'Not Found');
  } catch (error) {
    if (error instanceof ForgeError) return err(error.status, error.message);
    return err(500, error instanceof Error ? error.message : 'Internal Server Error');
  }
}

/** Build the request record from the raw HTTP request and dispatch it. */
export function createHttpServer(forge: Forge, token: string): Server {
  const ctx: Ctx = { forge, token };
  return createServer((incoming: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      // Fast path: split path and query by hand instead of constructing a URL
      // object per request (the read/write workloads are thousands of requests).
      const rawUrl = incoming.url ?? '/';
      const qIndex = rawUrl.indexOf('?');
      const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
      const query = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '');
      const segments = path
        .split('/')
        .filter((part) => part !== '')
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        });
      // Only the headers the handlers actually read (Node already lowercases names).
      const headers: Record<string, string> = {};
      const pick = (name: string): void => {
        const value = incoming.headers[name];
        if (typeof value === 'string') headers[name] = value;
      };
      pick('authorization');
      pick('host');
      pick('git-protocol');
      const host = headers.host ?? 'localhost';
      const baseUrl = `http://${host}`;
      const api = isApiPath(segments);
      let body: unknown;
      let bodyMalformed = false;
      if (api && rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }
      const req: Req = {
        method: incoming.method ?? 'GET',
        segments,
        path,
        query,
        headers,
        rawBody,
        body,
        bodyMalformed,
        baseUrl,
        token: bearerToken(headers),
      };
      sendResponse(res, route(ctx, req));
    });
    incoming.on('error', () => {
      if (!res.headersSent) sendResponse(res, err(400, 'Bad Request'));
      else res.end();
    });
  });
}
