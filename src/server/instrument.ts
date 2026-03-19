import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import type { IncomingMessage } from 'http';

import * as logfire from '@pydantic/logfire-node';
import * as Sentry from '@sentry/node';
import { Logger } from '../utils/logger.js';
import { settings } from './config.js';

// Initialize Logfire first to avoid conflict with Sentry
if (settings.LOGFIRE_TOKEN) {
  Logger.info('Initializing Logfire');
  logfire.configure({
    token: settings.LOGFIRE_TOKEN,
    serviceName: 'page-turner',
    environment: settings.ENVIRONMENT,
    distributedTracing: true,
    otelScope: 'logfire', // Set the OpenTelemetry scope name
    scrubbing: false,
  });

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request: IncomingMessage) => {
          const ignoredPaths = ['/health'];
          return ignoredPaths.some((path) => request.url?.includes(path));
        },
      }),
      new ExpressInstrumentation(),
    ],
  });
} else {
  console.log('⚠️  LOGFIRE_TOKEN not set - Logfire disabled');
}

if (settings.SENTRY_DSN) {
  console.log('Initializing Sentry');
  Sentry.init({
    dsn: settings.SENTRY_DSN,
    integrations: [
      Sentry.httpIntegration({
        ignoreIncomingRequests: (url) => {
          return (
            url.includes('/health') ||
            url.includes('/_next') ||
            url.includes('/assets')
          );
        },
      }),
      Sentry.expressIntegration(),
    ],
    tracesSampleRate: settings.NODE_ENV === 'production' ? 1 : 0.5,
    environment: settings.ENVIRONMENT,
    debug: false,
    beforeSend(event, hint) {
      if (settings.NODE_ENV !== 'production') {
        if (
          event.exception?.values?.[0]?.value?.includes('ECONNREFUSED') ||
          event.exception?.values?.[0]?.value?.includes('fetch failed')
        ) {
          return null;
        }
      }

      if (
        typeof hint.originalException === 'object' &&
        hint.originalException != null
      ) {
        event.extra = {
          ...event.extra,
          ...(hint.originalException as Record<string, unknown>),
        };
      }

      const scope = Sentry.getIsolationScope();
      const tags = scope.getScopeData().tags;
      if (tags?.browser_session_id) {
        event.tags = {
          ...event.tags,
          browser_session_id: tags.browser_session_id as string,
        };
      }
      if (tags?.signin_id) {
        event.tags = { ...event.tags, signin_id: tags.signin_id as string };
      }
      if (tags?.mcp_session_id) {
        event.tags = {
          ...event.tags,
          mcp_session_id: tags.mcp_session_id as string,
        };
      }

      return event;
    },
    beforeSendTransaction(event) {
      const ignoredPaths = ['/health', '/assets', '/_next', '/favicon'];
      if (ignoredPaths.some((path) => event.transaction?.includes(path))) {
        return null;
      }

      // Add centralized IDs from context if available
      const scope = Sentry.getIsolationScope();
      const tags = scope.getScopeData().tags;
      if (tags?.browser_session_id) {
        event.tags = {
          ...event.tags,
          browser_session_id: tags.browser_session_id as string,
        };
      }
      if (tags?.signin_id) {
        event.tags = { ...event.tags, signin_id: tags.signin_id as string };
      }
      if (tags?.mcp_session_id) {
        event.tags = {
          ...event.tags,
          mcp_session_id: tags.mcp_session_id as string,
        };
      }

      return event;
    },
  });
}
