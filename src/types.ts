// Shared request/response types for the four surfaces.

import type { Forge } from './store.ts';

export interface Req {
  method: string;
  /** Decoded path segments, without the leading slash and without empty segments. */
  segments: string[];
  /** The raw path (percent-decoded per segment, slashes kept). */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The request body as raw bytes (empty when none was sent). */
  rawBody: Buffer;
  /** The parsed JSON body, when the body parsed as JSON (undefined when no body). */
  body: unknown;
  /** True when a body was sent but did not parse as JSON. */
  bodyMalformed: boolean;
  /** The entry's own base URL (from the Host header), for absolute pagination links. */
  baseUrl: string;
  /** The bearer token the request carried, or null. */
  token: string | null;
}

export interface Ctx {
  forge: Forge;
  /** The token the server accepts (MAKEFUN_SHOP_TOKEN). */
  token: string;
}

export interface Res {
  status: number;
  headers?: Record<string, string>;
  /** A JSON-serializable body (undefined sends no body). */
  body?: unknown;
  /** Raw bytes to send instead of a JSON body (for git smart-HTTP). */
  raw?: Buffer;
  contentType?: string;
}

/** A JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Res {
  return { status, headers, body };
}

/** A JSON error body in GitHub's `{message}` shape. */
export function err(status: number, message: string): Res {
  return { status, body: { message } };
}
