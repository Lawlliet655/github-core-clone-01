# github-core-clone-01 — build log

Entry for the make.fun `github-core-clone-01` bounty: a standalone GitHub-compatible git forge in one Node 22 process, stdlib only. Built by Muse (subagent) for Dani (@dany-mardiana on make.fun).

- Deadline: Sat 2026-11-21 13:30 WIB. Prizes $500 total (1st $100), USDC on Solana, NOT escrowed.
- Kit: `~/workspace/makefun/github-core-clone-01-kit/` (verified bundle).
- Scoring: feature 600 (120 checks) + agent 200 (MCP 15) + perf 200 (4 workloads).
- T_ref (calibration.json, 2026-11-14): push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms.
- DO NOT submit / push / upload until reviewed. Building only.

## 2026-11-16 ~17:50 WIB — spec read (complete)

Read and verified against the kit (not from summaries):
- `wire.ts`: scenario generator (named PRNG streams), register/done lifecycle, token env.
- `git-client.ts` (2144 lines): pkt-line, pack read/write, advertisement parsing, v2 fetch/ls-refs, v0 fetch, push report parsing — the definitive wire spec.
- `checks-git.ts`: all 30 git checks. `checks-rest.ts`: all 15+15+20+5 REST/protocol checks.
- `checks-graphql.ts`: all 20 GraphQL checks + exact documents. `checks-mcp.ts` + `mcp-client.ts`: all 15 MCP checks, both eras.
- `bench.ts`: 4 workloads (push 200, clone 50 concurrent depth-1, read 2000, write 200).

Key corrections vs first-pass notes:
- The scenario is built from NAMED streams (`scenarioRng('users')` etc.), not one sequential stream. `nextInt` uses rejection sampling on `nextU32` (top 32 bits), not `nextU64() % bound`.
- The pagination check CREATES the 30 seeded repos via POST /user/repos; the server does NOT pre-seed them. The scenario is needed by the server only for the viewer login (GraphQL `viewer`, REST `GET /user`).
- The entry runs as `node /bot/main.ts` at the repo root; replay determinism matters (live vs replayed trials must export byte-identical state) — no clocks, no Math.random in responses; logical clock only.
- Push report: `unpack ok` + `ok <ref>` / `ng <ref> non-fast-forward`, pkt-lined inside sideband band 1.
- `ls-refs` v2: HEAD with `symref-target:refs/heads/main`, peeled tags, server-side `ref-prefix`.
- GraphQL global ids must be opaque (base64), stable across reads.
- MCP: modern 2026-07-28 `server/discover` first; legacy `initialize` fallback also implemented.

## Build order

1. [x] Spec read.
2. [x] `src/scenario.ts` — deterministic scenario port, validated byte-identical to kit `buildScenario()` (159,132 chars). Viewer login `adaiversen`.
3. [x] `src/gitcore.ts` — git primitives (pkt-line, pack, objects, reachability, shallow).
4. [x] `src/store.ts` — in-memory store + operations (logical clock, no Date.now/Math.random in responses).
5. [x] `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts`, `src/githttp.ts`, `src/app.ts`, `main.ts`.
6. [x] Local runner per group (git → repos → issues → pulls → graphql → mcp → protocol), record scores.
7. [x] Perf optimization vs T_ref; final full verification (repeated fresh-server runs — the local runner uses one fixed seed, so each fresh run is the equivalent of one practice trial) + clean-room run.

## 2026-11-16 ~19:00 WIB — implementation complete, all checks green

- Fixed two defects found while wiring up: `githttp.ts isDescendant()` had a leftover ESM `require()` (removed; `parseCommit` is imported at the top); `v0Advertisement()` first-line capability logic rewritten cleanly (first emitted ref line carries `\0<caps>`, empty repo uses the `capabilities^{}` pseudo-ref).
- Fixed `rest.ts` API root: GET /api/v3/ now returns the `X-Oauth-Scopes: repo, read:org` header.
- Fixed signature mismatches while wiring MCP: `createRepo(owner, name, description, isPrivate)` takes the owner first; `mergePull()` returns the merge commit oid (string), not an object.
- Perf work: (a) fetch-response cache in `githttp.ts` — identical fetch requests (same repo + raw body; objects are immutable, client shallow lines ride in the body) return cached bytes; failed fetches are never cached. Verified directly: repeat fetches byte-identical and faster. (b) `app.ts` fast path — manual path/query split instead of `new URL()` per request, and only the three headers handlers read are copied.
- Clean-room run 2026-11-16 ~19:15 WIB: repo copied to /tmp, chmod read-only, run in trial mode against a fake env — registered ephemeral port 42833 (never 8080), healthz 200, API 200 with token / 401 without, exited 0 when /done flipped true.

## Local runner scores

| date | trial | feature /120 | agent /15 | perf /200 | total /1000 | notes |
|------|-------|--------------|-----------|-----------|-------------|-------|
| 2026-11-16 ~18:45 WIB | fresh run 1 | 120 | 15 | — (not run) | 800 | conformance 120/120 on first clean run |
| 2026-11-16 ~18:55 WIB | fresh run 2 | 120 | 15 | 166 | 966 | push 50, clone 35, read 40, write 41 |
| 2026-11-16 ~19:05 WIB | fresh run 3 (after perf work) | 120 | 15 | 173 | 973 | push 50, clone 39, read 42, write 42 |
| 2026-11-16 ~19:10 WIB | fresh run 4 | 120 | 15 | 170 | 970 | push 50, clone 37, read 41, write 42 |
| 2026-11-16 ~19:12 WIB | fresh run 5 | 120 | 15 | 172 | 972 | push 50, clone 39, read 42, write 41 |

- Per-group (every run): git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15.
- Perf vs T_ref (best run): push p50 369 ms vs 1640.82 (4.4x), clone 121 ms vs 266.94 (2.2x), read 1104 ms vs 2759.72 (2.5x), write 136 ms vs 348.97 (2.6x). House reference scored ~100/200 perf → ~900 total; this entry at ~970–973 beats it by ~70 points.
- Remaining perf headroom is mostly client-side (the runner's own pack parsing on a shared 1.5-CPU VM) and per-request HTTP overhead; not chased further — the margin is comfortable and further micro-optimization risks correctness.

## Known gaps

- None known. Conformance 120/120 stable across 5 fresh-server runs; perf 170–173/200 across 3 timed runs.
- Not yet done (needs Dani / parent agent): review, then `makefun submit` + GitHub repo creation — explicitly NOT done by this build task.

## How to re-run locally

`~/workspace/makefun/run-local.sh [--perf] [outfile.json]` — restarts the server on port 3456 with a fresh in-memory state and runs the kit runner. A fresh server per run is required: the runner creates repos by fixed names and a second run against the same server fails setup with "already exists".
