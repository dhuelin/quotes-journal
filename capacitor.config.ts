import type { CapacitorConfig } from '@capacitor/cli';

const mobileAppUrl = process.env.MOBILE_APP_URL ?? 'https://quotes-journal.example.workers.dev/app';

const config: CapacitorConfig = {
  appId: 'com.dhuelin.quotesjournal',
  appName: 'Quotes Journal',
  webDir: 'www',
  server: {
    url: mobileAppUrl,
    cleartext: false,
  },
};

export default config;
