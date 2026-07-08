import * as logfire from '@pydantic/logfire-node';
import * as Sentry from '@sentry/node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { consola, type ConsolaReporter, type LogObject } from 'consola';
import { settings } from './config.js';

// Initialize Logfire first to avoid conflict with Sentry
if (settings.LOGFIRE_TOKEN) {
  consola.start('Initializing Logfire');
  logfire.configure({
    token: settings.LOGFIRE_TOKEN,
    serviceName: 'page-turner',
    environment: settings.ENVIRONMENT,
    distributedTracing: true,
    otelScope: 'logfire', // Set the OpenTelemetry scope name
    scrubbing: false,
    nodeAutoInstrumentations: {
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (request) => request.url === '/health',
      },
      '@opentelemetry/instrumentation-net': {
        enabled: false,
      },
      '@opentelemetry/instrumentation-express': {
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
      },
    },
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
      if (tags?.session_id) {
        event.tags = {
          ...event.tags,
          session_id: tags.session_id as string,
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
      if (tags?.session_id) {
        event.tags = {
          ...event.tags,
          session_id: tags.session_id as string,
        };
      }

      return event;
    },
  });

  const sentryReporter: ConsolaReporter = {
    log(logObj: LogObject) {
      // consola error level is 0
      if (logObj.level !== 0) return;
      const args = logObj.args;
      const message =
        args.find((a): a is string => typeof a === 'string') ?? '';
      const error = args.find((a): a is Error => a instanceof Error);
      const context = args.find(
        (a): a is Record<string, unknown> =>
          typeof a === 'object' && a !== null && !(a instanceof Error)
      );

      if (error) {
        Sentry.captureException(error, {
          tags: {
            component: context?.component as string | undefined,
            operation: context?.operation as string | undefined,
            brand_id: context?.brandId as string | undefined,
          },
          extra: {
            ...context,
            originalMessage: message,
          },
        });
      } else {
        Sentry.captureMessage(message, 'error');
      }
    },
  };

  consola.addReporter(sentryReporter);
}
