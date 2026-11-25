import type { CapacitorConfig } from '@capacitor/cli';

// Loads the real student-portal origin in the WebView (not a bundled copy) so the existing
// httpOnly/SameSite session cookies keep working unmodified.
const config: CapacitorConfig = {
  appId: 'com.kiu.wallet',
  appName: 'KIU Wallet',
  server: {
    url: process.env.KIU_WALLET_URL ?? 'http://192.168.100.179:3001',
    cleartext: true,
  },
};

export default config;
