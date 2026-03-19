import dotenv from 'dotenv';

dotenv.config();

export const settings = {
  GETGATHER_URL: process.env.GETGATHER_URL || 'http://127.0.0.1:23456',
  GETGATHER_APP_KEY: process.env.GETGATHER_APP_KEY || '',
  MAXMIND_ACCOUNT_ID: process.env.MAXMIND_ACCOUNT_ID || '',
  MAXMIND_LICENSE_KEY: process.env.MAXMIND_LICENSE_KEY || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  SENTRY_DSN: process.env.SENTRY_DSN || '',
  ENVIRONMENT: process.env.ENVIRONMENT || 'local',
  LOGFIRE_TOKEN: process.env.LOGFIRE_TOKEN || '',
};
