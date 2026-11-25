export interface Me {
  id: string; email: string; displayName: string; userType: string; roles: string[]; permissions: string[];
  mfaEnabled: boolean; mfaSetupRequired: boolean;
}
export const can = (me: Me, ...perms: string[]) => perms.every((p) => me.permissions.includes(p));
