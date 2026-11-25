/**
 * Permission and role catalogue. Single source of truth used by the seed script and
 * by API guards. Permissions are enforced server-side; the UI only reflects them.
 */

export const PERMISSIONS = [
  'students.view', 'students.create', 'students.update', 'students.import',
  'cards.view', 'cards.issue', 'cards.block', 'cards.replace',
  'rules.view', 'rules.manage',
  'readers.view', 'readers.manage',
  'services.view', 'services.manage',
  'access.verify', 'access.override', 'access.logs.view',
  'finance.view', 'finance.update',
  'registry.view', 'registry.manage',
  'library.view', 'library.manage',
  'hostel.view', 'hostel.manage',
  'cafeteria.view', 'cafeteria.manage',
  'exams.view', 'exams.manage', 'exams.attendance.view',
  'attendance.view', 'attendance.manage',
  'biometrics.enroll', 'biometrics.view', 'biometrics.revoke', 'biometrics.policy.manage',
  'alerts.view', 'alerts.manage',
  'integrations.view', 'integrations.manage',
  'reports.view', 'reports.export',
  'users.view', 'users.manage', 'roles.manage',
  'audit.view', 'settings.manage',
  // Student self-service
  'me.view', 'me.card.view', 'me.card.report_lost', 'me.eligibility.view', 'me.biometrics.manage',
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export const ROLE_CODES = [
  'SUPER_ADMIN', 'ICT_ADMIN', 'CARD_OFFICER', 'BIOMETRIC_OFFICER', 'FINANCE_OFFICER',
  'REGISTRY_OFFICER', 'LIBRARIAN', 'SECURITY_OFFICER', 'INVIGILATOR', 'HOSTEL_WARDEN',
  'CAFETERIA_OPERATOR', 'MANAGEMENT', 'STUDENT',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

/** Roles that must use MFA (privileged staff). Enforced at login. */
export const MFA_REQUIRED_ROLES: readonly RoleCode[] = ['SUPER_ADMIN', 'ICT_ADMIN'];

const ALL = [...PERMISSIONS] as PermissionCode[];
const STUDENT_SELF: PermissionCode[] = [
  'me.view', 'me.card.view', 'me.card.report_lost', 'me.eligibility.view', 'me.biometrics.manage',
];

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  description: string;
  permissions: PermissionCode[];
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  { code: 'SUPER_ADMIN', name: 'Super Administrator', description: 'Full system control.',
    permissions: ALL.filter((p) => !p.startsWith('me.')) },
  { code: 'ICT_ADMIN', name: 'ICT Administrator', description: 'Operates infrastructure, readers, integrations and accounts.',
    permissions: ['students.view', 'cards.view', 'rules.view', 'readers.view', 'readers.manage', 'services.view', 'services.manage',
      'access.logs.view', 'integrations.view', 'integrations.manage', 'alerts.view', 'alerts.manage', 'reports.view',
      'users.view', 'users.manage', 'audit.view', 'settings.manage', 'biometrics.view', 'biometrics.policy.manage'] },
  { code: 'CARD_OFFICER', name: 'Card Issuance Officer', description: 'Issues, blocks and replaces virtual cards.',
    permissions: ['students.view', 'cards.view', 'cards.issue', 'cards.block', 'cards.replace', 'access.logs.view'] },
  { code: 'BIOMETRIC_OFFICER', name: 'Biometric Enrollment Officer', description: 'Enrols students for optional face verification.',
    permissions: ['students.view', 'biometrics.enroll', 'biometrics.view', 'biometrics.revoke'] },
  { code: 'FINANCE_OFFICER', name: 'Finance Officer', description: 'Maintains fee clearance status.',
    permissions: ['students.view', 'finance.view', 'finance.update', 'integrations.view', 'reports.view'] },
  { code: 'REGISTRY_OFFICER', name: 'Academic Registry Officer', description: 'Maintains students, enrolments and exam schedules.',
    permissions: ['students.view', 'students.create', 'students.update', 'students.import', 'registry.view', 'registry.manage',
      'exams.view', 'exams.manage', 'integrations.view', 'reports.view'] },
  { code: 'LIBRARIAN', name: 'Librarian', description: 'Library entry, borrowing and returns.',
    permissions: ['students.view', 'library.view', 'library.manage', 'access.verify', 'reports.view'] },
  { code: 'SECURITY_OFFICER', name: 'Security Officer', description: 'Operates campus gates; reviews alerts.',
    permissions: ['students.view', 'access.verify', 'access.override', 'access.logs.view', 'alerts.view', 'alerts.manage', 'readers.view', 'reports.view'] },
  { code: 'INVIGILATOR', name: 'Exam Invigilator', description: 'Examination hall entry and attendance.',
    permissions: ['students.view', 'access.verify', 'access.override', 'exams.view', 'exams.attendance.view', 'attendance.view', 'reports.view'] },
  { code: 'HOSTEL_WARDEN', name: 'Hostel Warden', description: 'Hostel residents and entry log.',
    permissions: ['students.view', 'hostel.view', 'hostel.manage', 'access.verify', 'access.logs.view', 'reports.view'] },
  { code: 'CAFETERIA_OPERATOR', name: 'Cafeteria Operator', description: 'Meal service verification.',
    permissions: ['cafeteria.view', 'cafeteria.manage', 'access.verify'] },
  { code: 'MANAGEMENT', name: 'University Management', description: 'Read-only analytics.',
    permissions: ['reports.view', 'reports.export', 'access.logs.view', 'alerts.view', 'audit.view'] },
  { code: 'STUDENT', name: 'Student', description: 'Own records only.', permissions: STUDENT_SELF },
];

export function permissionsForRoles(roleCodes: readonly string[]): PermissionCode[] {
  const set = new Set<PermissionCode>();
  for (const def of ROLE_DEFINITIONS) {
    if (roleCodes.includes(def.code)) def.permissions.forEach((p) => set.add(p));
  }
  return [...set];
}
