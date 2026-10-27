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
    // Immersive fullscreen (MainActivity hides the bars too, and again whenever the app regains focus).
    // Insets: MainActivity gives them to the page (--sa-* in index.css). Capacitor's own handling
    // padded the whole app by the cutout and the bars on WebViews without safe-area support,
    // leaving bands of the window's colour around it (20:9 phones).
    SystemBars: { hidden: true, initialViewportFitValueHint: 'cover', insetsHandling: 'disable' },
  },
};

export default config;
