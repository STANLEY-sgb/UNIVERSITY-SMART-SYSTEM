import type { CapacitorConfig } from '@capacitor/cli';

// Loads the real admin console origin in the WebView (not a bundled copy) so the
// existing httpOnly/SameSite session cookies keep working unmodified.
const config: CapacitorConfig = {
  appId: 'com.kiu.admin',
  appName: 'KIU Admin',
  server: {
    url: process.env.KIU_ADMIN_URL ?? 'http://192.168.100.179:3000',
    cleartext: true,
  },
};

export default config;
