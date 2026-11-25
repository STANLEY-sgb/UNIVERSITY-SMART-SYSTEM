import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { loadDotenv } from '../config/dotenv';
import { seedCore } from './core';

/**
 * Creates the first SUPER_ADMIN of a real deployment. There is no demo data and no default password:
 *   node apps/api/dist/seed/create-admin.js you@university.example "Your Name"
 * A strong random password is printed ONCE. Super administrators must enrol an authenticator app at first sign-in
 * (the API refuses everything else until they do), so a leaked password alone is not enough to use the account.
 */
async function main(): Promise<void> {
  loadDotenv();
  const [email, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(' ').trim() || 'System Administrator';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: create-admin.js <email> ["Display Name"]');
  if (/@kiu-demo\.test$/i.test(email)) throw new Error('Demo addresses are not allowed here');

  const prisma = new PrismaClient();
  try {
    await seedCore(prisma);
    if (await prisma.user.findUnique({ where: { email: email.toLowerCase() } })) throw new Error(`${email} already exists`);
    const password = randomBytes(18).toString('base64url');
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
    await prisma.user.create({
      data: {
        email: email.toLowerCase(), displayName: name, userType: 'STAFF', mustChangePassword: false,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }), roles: { create: [{ roleId: role.id }] },
      },
    });
    console.log(`Created super administrator ${email.toLowerCase()}`);
    console.log(`One-time password (store it in a password manager, it is not shown again): ${password}`);
    console.log('At first sign-in you will be asked to set up an authenticator app.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
