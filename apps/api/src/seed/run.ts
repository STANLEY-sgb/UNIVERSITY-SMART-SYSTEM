import { PrismaClient } from '@prisma/client';
import { loadDotenv } from '../config/dotenv';
import { seedCore } from './core';
import { DEMO_PASSWORD, seedDemo } from './demo';

async function main(): Promise<void> {
  loadDotenv();
  const prisma = new PrismaClient();
  try {
    await seedCore(prisma);
    console.log('Seeded roles and permissions.');

    if (process.env.SEED_DEMO_ACCOUNTS === 'true') {
      if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
      const r = await seedDemo(prisma);
      console.log(`Seeded fictional demo data: ${r.students} students, ${r.staffAccounts} staff accounts.`);
      console.log(`Demo logins: <role>@kiu-demo.test / studentNN@kiu-demo.test  password: ${DEMO_PASSWORD}  (DEVELOPMENT ONLY)`);
    } else {
      console.log('SEED_DEMO_ACCOUNTS is not "true": skipped demo data.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
