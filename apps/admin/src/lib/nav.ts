/** Console pages and the permissions each requires. Cosmetic only: the API enforces every permission itself. */
export interface RouteMeta { path: string; label: string; perms: string[] }

export const ROUTE_META: RouteMeta[] = [
  { path: '/', label: 'Overview', perms: ['reports.view'] },
  { path: '/academic', label: 'Departments & Programmes', perms: ['registry.view'] },
  { path: '/students', label: 'Students', perms: ['students.view'] },
  { path: '/cards', label: 'Cards', perms: ['cards.view'] },
  { path: '/readers', label: 'Readers', perms: ['readers.view'] },
  { path: '/rules', label: 'Rules', perms: ['rules.view', 'services.view'] },
  { path: '/finance', label: 'Finance', perms: ['finance.view'] },
  { path: '/library', label: 'Library', perms: ['library.view'] },
  { path: '/hostels', label: 'Hostels', perms: ['hostel.view'] },
  { path: '/meals', label: 'Meal sittings', perms: ['cafeteria.view'] },
  { path: '/timetable', label: 'Timetable', perms: ['registry.view'] },
  { path: '/face', label: 'Face verification', perms: ['biometrics.view'] },
  { path: '/overrides', label: 'Overrides', perms: ['access.override'] },
  { path: '/exams', label: 'Examinations', perms: ['exams.view'] },
  { path: '/settings', label: 'Settings', perms: ['settings.manage'] },
  { path: '/imports', label: 'Data imports', perms: ['integrations.view'] },
  { path: '/reports', label: 'Reports', perms: ['reports.view'] },
  { path: '/logs', label: 'Access logs', perms: ['access.logs.view'] },
  { path: '/alerts', label: 'Alerts', perms: ['alerts.view'] },
  { path: '/audit', label: 'Audit trail', perms: ['audit.view'] },
  { path: '/users', label: 'Staff & roles', perms: ['users.view'] },
];

export const visibleRoutes = (permissions: readonly string[]) => ROUTE_META.filter((r) => r.perms.every((p) => permissions.includes(p)));
