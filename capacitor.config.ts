import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.opennote.app',
  appName: 'OpenNote',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // The Qwen3-VL server is usually plain http on the LAN / Tailscale.
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    // Native HTTP is called explicitly (src/platform.ts); fetch/XHR are not patched globally.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
