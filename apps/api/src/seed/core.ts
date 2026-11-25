import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLE_DEFINITIONS } from '@kiu/shared';

/** Roles + permissions. Idempotent and safe in every environment. */
export async function seedCore(prisma: PrismaClient): Promise<void> {
  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code, description: code.replace(/\./g, ' ') } });
  }
  const perms = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));

  for (const def of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { code: def.code },
      update: { name: def.name, description: def.description, isSystem: true },
      create: { code: def.code, name: def.name, description: def.description, isSystem: true },
    });
    // Reconcile permissions so catalogue changes apply on re-seed.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions.map((p) => ({ roleId: role.id, permissionId: perms.get(p)! })),
      skipDuplicates: true,
    });
  }
}
