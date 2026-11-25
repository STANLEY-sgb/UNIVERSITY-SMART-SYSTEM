import { PrismaClient } from '@prisma/client';
import { loadDotenv } from '../config/dotenv';
import { seedCore } from './core';
import { seedRules } from './rules';
import { SERVICE_CATALOG } from './service-catalog';

/**
 * Production-safe bootstrap for a real deployment: roles/permissions, the fixed service
 * catalogue, and default access-rule policy per service. Deliberately creates no departments,
 * programmes, course units, academic sessions, venues, hostels, meal sittings, or people —
 * those are real data entered through the admin console, not seeded.
 *   node apps/api/dist/seed/bootstrap.js
 * Then create the first administrator with ./create-admin.ts.
 */
async function main(): Promise<void> {
  loadDotenv();
  const prisma = new PrismaClient();
  try {
    await seedCore(prisma);
    console.log('Seeded roles and permissions.');

    for (const s of SERVICE_CATALOG) {
      await prisma.service.upsert({
        where: { code: s.code }, update: {},
        create: { code: s.code, name: s.name, offlinePolicy: s.offline, requiresDirection: s.direction ?? false, sensitivity: s.sensitivity ?? 'NORMAL' },
      });
    }
    console.log(`Seeded ${SERVICE_CATALOG.length} services.`);

    const rulesCreated = await seedRules(prisma);
    console.log(`Published ${rulesCreated} default access rules (review/adjust thresholds via the admin console before relying on them).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
