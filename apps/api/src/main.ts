import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadDotenv } from './config/dotenv';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const app = await createApp(env);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  new Logger('Bootstrap').log(`KIU-USCAS API listening on :${env.API_PORT} (docs: /api/docs)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
