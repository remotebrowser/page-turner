import {
  Context,
  ROOT_CONTEXT,
  ProxyTracerProvider,
  SpanKind,
  TextMapGetter,
  TextMapPropagator,
  TextMapSetter,
  TraceFlags,
  propagation,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
// SpanImpl isn't re-exported from the package root, but it's the only way to
// construct a span with a custom trace_id AND span_id (Tracer.startSpan
// generates the span_id itself). Mirrors mcp-getgather's reach into Python's
// SDK._Span.
import { SpanImpl } from '@opentelemetry/sdk-trace-base/build/src/Span.js';
import { createHash } from 'crypto';
import type { IncomingMessage } from 'http';

import * as logfire from '@pydantic/logfire-node';
import * as Sentry from '@sentry/node';
import { Logger } from '../utils/logger.js';
import { settings } from './config.js';

function readSessionId(
  carrier: unknown,
  getter: TextMapGetter
): string | undefined {
  const raw = getter.get(carrier, 'x-mcp-session-id');
  const headerVal = Array.isArray(raw) ? raw[0] : raw;
  if (typeof headerVal === 'string' && headerVal.length > 0) return headerVal;
  const cookieRaw = getter.get(carrier, 'cookie');
  const cookieHeader = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  if (typeof cookieHeader !== 'string') return undefined;
  const match = cookieHeader.match(/(?:^|; )mcp-session-id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function deriveSessionContext(sessionId: string): {
  traceId: string;
  spanId: string;
} {
  const hash = createHash('sha256').update(sessionId).digest();
  return {
    traceId: hash.subarray(0, 16).toString('hex'),
    spanId: hash.subarray(16, 24).toString('hex'),
  };
}

const emittedRootSpans = new Set<string>();
const SESSION_INSTRUMENTATION_SCOPE = {
  name: 'page-turner.session',
  version: '1.0.0',
};

function emitSessionRootSpanOnce(sessionId: string): void {
  if (emittedRootSpans.has(sessionId)) return;

  // Tracer.startSpan generates its own random span_id, so we can't use it to
  // produce a span whose span_id matches what our propagator hands out as the
  // parent. Reach into the SDK and construct SpanImpl directly with both
  // trace_id and span_id under our control. Mirrors mcp-getgather's
  // _emit_mcp_session_root_span_once in getgather/tracing.py.
  let provider = trace.getTracerProvider();
  if (provider instanceof ProxyTracerProvider) {
    provider = provider.getDelegate();
  }
  const internal = provider as unknown as {
    _activeSpanProcessor?: unknown;
    _resource?: unknown;
    _config?: { spanLimits?: unknown };
  };
  const spanProcessor = internal._activeSpanProcessor;
  const resource = internal._resource;
  const spanLimits = internal._config?.spanLimits;
  if (!spanProcessor || !resource || !spanLimits) return;

  emittedRootSpans.add(sessionId);

  const { traceId, spanId } = deriveSessionContext(sessionId);
  const span = new SpanImpl({
    resource: resource as never,
    scope: SESSION_INSTRUMENTATION_SCOPE as never,
    context: ROOT_CONTEXT,
    spanContext: {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    },
    name: `page-turner session ${sessionId}`,
    kind: SpanKind.INTERNAL,
    spanLimits: spanLimits as never,
    spanProcessor: spanProcessor as never,
    attributes: { 'mcp.mcp_session_id': sessionId },
  });
  span.end();
}

class SessionTraceContextPropagator implements TextMapPropagator {
  private readonly base = new W3CTraceContextPropagator();

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    this.base.inject(context, carrier, setter);
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const extracted = this.base.extract(context, carrier, getter);
    if (trace.getSpanContext(extracted)) return extracted;
    const sid = readSessionId(carrier, getter);
    if (!sid) return extracted;
    emitSessionRootSpanOnce(sid);
    const { traceId, spanId } = deriveSessionContext(sid);
    return trace.setSpanContext(extracted, {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  }

  fields(): string[] {
    return this.base.fields();
  }
}

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

if (settings.LOGFIRE_TOKEN) {
  // setGlobalPropagator silently no-ops if a propagator is already registered
  // (registerGlobal defaults to allowOverride=false). Logfire's NodeSDK
  // installs W3CTraceContextPropagator first, so we must disable before
  // re-registering or our extract() never runs.
  propagation.disable();
  propagation.setGlobalPropagator(new SessionTraceContextPropagator());
}
