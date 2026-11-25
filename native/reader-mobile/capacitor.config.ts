import type { CapacitorConfig } from '@capacitor/cli';

// Loads the real reader-app origin in the WebView (not a bundled copy) so the existing
// httpOnly/SameSite session cookies and the device's non-extractable signing key keep working.
const config: CapacitorConfig = {
  appId: 'com.kiu.reader',
  appName: 'KIU Reader',
  server: {
    url: process.env.KIU_READER_URL ?? 'http://192.168.100.179:3002',
    cleartext: true,
  },
};

export default config;
