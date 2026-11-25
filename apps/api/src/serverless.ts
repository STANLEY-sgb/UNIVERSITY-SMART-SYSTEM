import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from './bootstrap';
import { loadDotenv } from './config/dotenv';
import { loadEnv } from './config/env';

// Vercel entry point. Deliberately compiled by the normal `nest build` (tsc), not re-transformed
// by Vercel's esbuild function bundler: esbuild doesn't support `emitDecoratorMetadata`, which
// Nest's DI relies on, so decorated classes must already be plain JS before Vercel touches them.
// The thin shim at apps/api/api/[...path].js just requires this file's compiled dist/ output.

let appPromise: Promise<NestExpressApplication> | undefined;

async function getApp(): Promise<NestExpressApplication> {
  if (!appPromise) {
    appPromise = (async () => {
      loadDotenv(); // no-op on Vercel (no .env is deployed); env vars come from the project settings
      const app = await createApp(loadEnv());
      await app.init(); // no app.listen() here — Vercel owns the socket
      return app as NestExpressApplication;
    })();
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.getHttpAdapter().getInstance()(req, res);
}
