// Entry point. Two modes:
//  - Trial mode (MAKEFUN_ENV_URL is set): listen on an ephemeral port, register
//    it with the environment, serve until the environment reports done, then
//    shut down and exit 0.
//  - Standalone mode (no MAKEFUN_ENV_URL): listen on --port or $PORT for local
//    testing with the kit's local runner.

import { createForge, createHttpServer } from './src/app.ts';

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return response.status;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? argValue('--token') ?? 'test-token';
  const forge = createForge();
  const server = createHttpServer(forge, token);

  const envUrl = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');
  if (envUrl) {
    // Trial mode.
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    const port = address.port;

    // Register the port; 200 or 409 both mean the environment knows about us.
    let delay = 250;
    for (;;) {
      try {
        const status = await postJson(`${envUrl}/register`, { port });
        if (status === 200 || status === 409) break;
      } catch {
        // The environment may not be ready yet; keep trying.
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }

    // Serve until the environment says the trial is done.
    delay = 250;
    for (;;) {
      const done = await getJson(`${envUrl}/done`);
      if (done?.done === true) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  }

  // Standalone mode.
  const port = Number(argValue('--port') ?? process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`github-core-clone listening on http://127.0.0.1:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
