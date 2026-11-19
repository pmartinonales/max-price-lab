import express from 'express';
import type { Server } from 'node:http';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from './db';
import { createApp, type AppOptions } from './app';

/** Project root, resolved from this file so the server can be started from any working directory. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface StartOptions {
  port?: number;
  db?: DB;
  dataDir?: string;
  clientFactory?: AppOptions['clientFactory'];
  production?: boolean;
}

export async function startServer(opts: StartOptions = {}): Promise<{ server: Server; port: number }> {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const production = opts.production ?? process.env.NODE_ENV === 'production';
  const db = opts.db ?? openDb();
  const app = createApp({ db, dataDir: opts.dataDir, clientFactory: opts.clientFactory });

  if (production) {
    const dist = resolve(PROJECT_ROOT, 'dist/client');
    if (!existsSync(dist)) throw new Error('Run "npm run build" first');
    app.use(express.static(dist));
    app.get(/^(?!\/api|\/webhook).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  } else {
    // One process, one port: Vite serves the UI as middleware next to the API and webhook.
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: resolve(PROJECT_ROOT, 'vite.config.ts'),
      root: resolve(PROJECT_ROOT, 'src/client'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = await new Promise<Server>((ok) => {
    const s = app.listen(port, () => ok(s));
  });
  return { server, port };
}
