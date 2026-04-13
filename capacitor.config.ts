import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.petanalysis.app',
  appName: 'Pet Analysis',
  webDir: 'dist',
  plugins: {
    AdMob: {
      // Google's official test App ID for Android
      appId: 'ca-app-pub-3940256099942544~3347511713',
    }
  }
};

export default config;
