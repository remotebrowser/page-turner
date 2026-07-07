import dotenv from 'dotenv';

dotenv.config();

export const settings = {
  REMOTEBROWSER_URL: process.env.REMOTEBROWSER_URL || 'http://127.0.0.1:23456',
  GETGATHER_APP_KEY: process.env.GETGATHER_APP_KEY || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  SENTRY_DSN: process.env.SENTRY_DSN || '',
  ENVIRONMENT: process.env.ENVIRONMENT || 'local',
  LOGFIRE_TOKEN: process.env.LOGFIRE_TOKEN || '',
};
