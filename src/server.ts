import * as Sentry from '@sentry/node';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { parseHTML } from 'linkedom';
import { createRequire } from 'module';
import { Socket } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { BrandConfig } from './modules/Config';
import { settings } from './server/config.js';
import './server/instrument.js';
import { getClientIp, getLocation } from './server/locationService.js';
import {
  distillPage,
  getDistilledHtml,
  getDistilledJson,
  navigatePage,
  prepareNewBrowser,
} from './server/remotebrowser.js';
import { Logger } from './utils/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    sessionID: string;
  }
}

dotenv.config();

const require = createRequire(import.meta.url);
const goodreads = require('./config/goodreads.json');
const goodreadsConfig = goodreads as BrandConfig;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

function formatDistilledPage(
  html: string,
  sessionId: string,
  pageId: string
): string {
  const { document } = parseHTML(html);

  document.querySelectorAll('h1').forEach((h1) => h1.remove());

  const link = document.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', '/style.css');
  document.head.appendChild(link);

  const script = document.createElement('script');
  script.setAttribute('src', '/signin.js');
  script.setAttribute('defer', '');
  document.head.appendChild(script);

  const form = document.createElement('form');
  form.setAttribute('method', 'POST');
  form.setAttribute('action', '/api/get-book-list');

  const idInput = document.createElement('input');
  idInput.setAttribute('type', 'hidden');
  idInput.setAttribute('name', 'id');
  idInput.setAttribute('value', sessionId);
  form.appendChild(idInput);

  const pageIdInput = document.createElement('input');
  pageIdInput.setAttribute('type', 'hidden');
  pageIdInput.setAttribute('name', 'pageId');
  pageIdInput.setAttribute('value', pageId);
  form.appendChild(pageIdInput);

  const body = document.body;
  while (body.firstChild) {
    form.appendChild(body.firstChild);
  }

  const card = document.createElement('div');
  card.setAttribute('class', 'card');
  card.appendChild(form);
  body.appendChild(card);

  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function normalizeHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

async function getImportantHeaders(req: express.Request) {
  return {
    'x-origin-ip': getClientIp(req),
    'user-agent': normalizeHeaderValue(req.headers['user-agent']),
  };
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function readSessionIdFromCookie(req: express.Request): string | undefined {
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|; )mcp-session-id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function requireSession(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const headerValue = req.headers['x-mcp-session-id'];
  const headerSessionId = Array.isArray(headerValue)
    ? headerValue[0]
    : headerValue;
  const sessionId = headerSessionId || readSessionIdFromCookie(req);
  if (!sessionId) {
    res.status(400).json({ error: 'mcp-session-id is required' });
    return;
  }
  req.sessionID = sessionId;
  Sentry.getIsolationScope().setTag('mcp_session_id', sessionId);
  next();
}

app.use('/api', requireSession);

app.get('/internal/sentry/config', (_, res) => {
  res.json({
    dsn: settings.SENTRY_DSN,
    environment: settings.ENVIRONMENT,
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes

const GOODREADS_REVIEW_LIST_URL = 'https://www.goodreads.com/review/list';

async function initiateDistill(
  sessionId: string,
  pageId: string,
  fields: Record<string, string> = {}
): Promise<{ json?: unknown[]; html?: string }> {
  const browserId = sessionId;

  await distillPage(browserId, pageId, fields);

  try {
    const distilled = await getDistilledJson<unknown[]>(browserId, pageId);
    if (Array.isArray(distilled) && distilled.length > 0) {
      return { json: distilled };
    }
  } catch (jsonError) {
    Logger.info(
      'Failed to obtain distilled JSON, falling back to distilled HTML',
      {
        error:
          jsonError instanceof Error ? jsonError.message : String(jsonError),
      }
    );
  }

  const html = await getDistilledHtml(browserId, pageId);
  return { html };
}

app.post('/api/get-book-list', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  let sessionId: string | undefined;
  let pageId: string | undefined;
  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    const stringValue = typeof value === 'string' ? value : String(value);
    if (key === 'id' || key === 'sessionId') {
      sessionId = stringValue;
    } else if (key === 'pageId') {
      pageId = stringValue;
    } else {
      fields[key] = stringValue;
    }
  }

  if (!sessionId) {
    sessionId = req.sessionID;
  }

  if (!sessionId) {
    return res.status(503).send();
  }

  Logger.info('get-book-list resolved ids', { sessionId, pageId });

  try {
    let browserId = sessionId;
    let resolvedPageId: string;

    if (!pageId) {
      const headers = await getImportantHeaders(req);
      const prepared = await prepareNewBrowser(sessionId, headers);
      browserId = prepared.browserId;
      resolvedPageId = prepared.pageId;
      await navigatePage(browserId, resolvedPageId, GOODREADS_REVIEW_LIST_URL);
    } else {
      resolvedPageId = pageId;
    }

    const { json, html } = await initiateDistill(
      browserId,
      resolvedPageId,
      fields
    );

    const responseData: Record<string, unknown> = {
      browserId,
      pageId: resolvedPageId,
    };
    if (json !== undefined) {
      responseData.json = json;
    }
    if (html) {
      responseData.html = formatDistilledPage(
        html,
        req.sessionID,
        resolvedPageId
      );
    }

    return res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    Logger.error('get-book-list handler failed', error as Error, { sessionId, pageId });
    return res.status(500).send();
  }
});

app.post('/api/poll-browser', async (req, res) => {
  try {
    const { browser_id, page_id } = req.body;

    if (!browser_id || !page_id) {
      return res.status(400).json({
        success: false,
        error: 'browser_id and page_id are required',
      });
    }

    let bookListContent: unknown[] = [];
    let status = 'PENDING';
    try {
      const distilled = await getDistilledJson<unknown[]>(browser_id, page_id);
      if (Array.isArray(distilled) && distilled.length > 0) {
        const transformed = distilled;
        if (transformed.length > 0) {
          bookListContent = transformed;
          status = 'SUCCESS';
        }
      }
    } catch (pollError) {
      Logger.debug('Browser poll did not yield JSON, returning PENDING', {
        browser_id,
        page_id,
        error:
          pollError instanceof Error ? pollError.message : String(pollError),
      });
    }

    res.json({
      success: true,
      data: {
        status,
        [goodreadsConfig.dataTransform.dataPath]: bookListContent,
      },
    });
  } catch (error) {
    Logger.error('Poll browser error:', error as Error, {
      req: req.toString(),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/finalize-browser', async (req, res) => {
  try {
    const { browser_id, page_id } = req.body;

    if (!browser_id || !page_id) {
      return res.status(400).json({
        success: false,
        error: 'browser_id and page_id are required',
      });
    }

    Logger.info('Browser finalized', { browser_id, page_id });

    res.json({
      success: true,
    });
  } catch (error) {
    Logger.error('Finalize browser error:', error as Error, {
      req: req.toString(),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

const createProxy = (path: string) =>
  createProxyMiddleware({
    target: `${settings.GETGATHER_URL}${path}`,
    changeOrigin: true,
    on: {
      proxyReq: fixRequestBody,
      error: (
        err: Error,
        req: express.Request,
        res: express.Response | Socket
      ) => {
        Logger.error('Proxy error:', err, { req: req.toString() });
        if ('status' in res) {
          res.status(500).send('Proxy error occurred');
        }
      },
    },
  });

const proxyPaths = [
  '/auth',
  '/link',
  '/dpage',
  '/assets',
  '/static',
  '/__assets',
  '/__static',
];

proxyPaths.forEach((path) => {
  app.use(path, createProxy(path));
});
app.use('/api', async (req, res, next) => {
  bodyParser.json()(req, res, async (err) => {
    if (err) return next(err);

    if (req.method === 'POST') {
      if (!req.body) {
        req.body = {};
      }
      const ipAddress = getClientIp(req);
      req.body.location = await getLocation(ipAddress);
    }

    createProxy('/api')(req, res, next);
  });
});

// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: express.NextFunction
  ) => {
    Logger.error('Unhandled server error', err, {
      component: 'server',
      operation: 'fallback-error-handler',
      url: req.url,
      method: req.method,
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// Serve static files only in production
if (settings.NODE_ENV === 'production') {
  // Serve static files from dist directory (after API routes)
  app.use(express.static(path.join(__dirname, '..', 'dist')));

  // Catch-all handler: send back React app for any non-API, non-static routes
  app.use((req, res, next) => {
    // If it's an API route, let other handlers deal with it
    if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
      return next();
    }
    // For all other routes, serve the React app
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
  });
}

async function startServer() {
  try {
    app.listen(PORT, () => {
      Logger.info(`Server running on port ${PORT}`);
      if (settings.NODE_ENV === 'production') {
        app.set('trust proxy', 1);
        Logger.info('Serving static files from dist/');
      } else {
        Logger.info('API only mode - use Vite dev server for frontend');
      }
    });
  } catch (error) {
    Logger.error('Failed to start server:', error as Error);
    process.exit(1);
  }
}

startServer();
