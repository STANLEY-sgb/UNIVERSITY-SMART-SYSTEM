import { SERVICE_CODES } from '@kiu/shared';

/**
 * The fixed set of services the access-control engine and rules (`./rules.ts`) are written
 * against. Every deployment needs these rows to exist, demo or real — only the fictional people
 * and academic structure in `./demo.ts` are development-only.
 */
export const SERVICE_CATALOG: { code: (typeof SERVICE_CODES)[number]; name: string; offline: 'DENY_ALL' | 'CACHED_ALLOW'; direction?: boolean; sensitivity?: string }[] = [
  { code: 'GATE', name: 'Campus Gate', offline: 'CACHED_ALLOW', direction: true },
  { code: 'LIBRARY_ENTRY', name: 'Library Entry', offline: 'DENY_ALL' },
  { code: 'LIBRARY_BORROW', name: 'Library Borrowing', offline: 'DENY_ALL' },
  { code: 'EXAM', name: 'Examination Hall', offline: 'DENY_ALL' },
  { code: 'LECTURE', name: 'Lecture Attendance', offline: 'DENY_ALL' },
  { code: 'HOSTEL', name: 'Hostel Access', offline: 'DENY_ALL' },
  { code: 'CAFETERIA', name: 'Cafeteria', offline: 'DENY_ALL' },
  { code: 'LAB', name: 'Computer Laboratory', offline: 'DENY_ALL' },
  { code: 'HEALTH', name: 'Health Centre', offline: 'DENY_ALL', sensitivity: 'HEALTH' },
  { code: 'SPORTS', name: 'Sports Facilities', offline: 'DENY_ALL' },
  { code: 'TRANSPORT', name: 'University Transport', offline: 'DENY_ALL' },
  { code: 'GRADUATION', name: 'Graduation Clearance', offline: 'DENY_ALL' },
];
