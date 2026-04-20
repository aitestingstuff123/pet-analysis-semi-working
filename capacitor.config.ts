import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.petanalysis.app',
  appName: 'PawBehavior',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
