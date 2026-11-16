# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Lawlliet655/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Lawlliet655/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only.

Entry for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01):
REST v3, GraphQL v4, MCP (streamable HTTP) and git smart HTTP (protocol v2 upload-pack,
v0 receive-pack), all over one shared in-memory store.

## Run

```sh
node main.ts            # trial mode when MAKEFUN_ENV_URL is set (register, poll /done, exit 0)
MAKEFUN_SHOP_TOKEN=tok node main.ts --port 8080   # standalone mode for local testing
```

Node 22.18+ strips TypeScript types natively; there is nothing to install and no build step.

## Layout

- `main.ts` — entrypoint: lifecycle (listen on an ephemeral port, register with the env, poll `/done`).
- `src/app.ts` — HTTP server, routing, auth, request ids.
- `src/scenario.ts` — the deterministic seeded scenario (the viewer login the token names).
- `src/gitcore.ts` — git primitives: pkt-lines, packfiles, object model, reachability, shallow fetch.
- `src/store.ts` — the in-memory forge: repos, refs, objects, issues, pull requests, labels.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser and executor (the documents gh / github-mcp-server send).
- `src/mcp.ts` — MCP tools over streamable HTTP (modern 2026-07-28 + legacy handshake).
- `src/githttp.ts` — git smart-HTTP handlers (info/refs, upload-pack, receive-pack).
