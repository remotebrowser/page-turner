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
import { trace } from '@opentelemetry/api';
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

const SPINNER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Loading</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div>
      <span class="spinner" aria-label="Loading" style="border-top-color: #333"></span>
      <span>Loading...</span>
    </div>
  </body>
</html>`;

function formatDistilledPage(
  html: string,
  browserId: string,
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
  form.setAttribute('action', `/api/dpage/${browserId}/${pageId}`);

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
  const match = cookieHeader.match(/(?:^|; )session-id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function requireSession(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const headerValue = req.headers['x-session-id'];
  const headerSessionId = Array.isArray(headerValue)
    ? headerValue[0]
    : headerValue;
  const sessionId = headerSessionId || readSessionIdFromCookie(req);
  if (!sessionId) {
    res.status(400).json({ error: 'session-id is required' });
    return;
  }
  req.sessionID = sessionId;
  Sentry.getIsolationScope().setTag('session_id', sessionId);
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
  browserId: string,
  pageId: string,
  fields: Record<string, string> = {}
): Promise<{ json?: unknown[]; html?: string }> {
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
  const sessionId = req.sessionID!;

  const span = trace.getActiveSpan();
  span?.updateName('POST /api/get-book-list');

  try {
    const headers = await getImportantHeaders(req);
    const { browserId, pageId } = await prepareNewBrowser(headers);
    span?.setAttribute('pageturner.browser_id', browserId);
    span?.setAttribute('pageturner.page_id', pageId);
    await navigatePage(browserId, pageId, GOODREADS_REVIEW_LIST_URL);

    const { html } = await initiateDistill(browserId, pageId);
    if (!html) {
      return res.status(500).send();
    }
    const responseData = {
      browserId,
      pageId,
      html: formatDistilledPage(html, browserId, pageId),
    };
    return res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    Logger.error('get-book-list handler failed', error as Error, { sessionId });
    return res.status(500).send();
  }
});

// Since the browser can't redirect from GET to POST,
// use an auto-submit form to do that.
function redirect(action: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <form id="redirect" action="${action}" method="post">
      </form>
      <div>
        <span class="spinner" aria-label="Loading" style="border-top-color: #333"></span>
        <span>Loading...</span>
      </div>
      <script>setTimeout(() => document.getElementById('redirect').submit(), 5000);</script>
    </body>
    </html>`;
}

app.get('/api/dpage/:browserId/:pageId', (req, res) => {
  const { browserId, pageId } = req.params;
  if (!browserId || !pageId) {
    return res.status(503).send();
  }

  const span = trace.getActiveSpan();
  span?.updateName('GET /api/dpage (will redirect)');
  span?.setAttribute('pageturner.browser_id', browserId);
  span?.setAttribute('pageturner.page_id', pageId);

  return res
    .type('text/html')
    .send(redirect(`/api/dpage/${browserId}/${pageId}`));
});

app.post('/api/dpage/:browserId/:pageId', async (req, res) => {
  const browserId = req.params.browserId;
  const pageId = req.params.pageId;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    fields[key] = typeof value === 'string' ? value : String(value);
  }

  if (!browserId || !pageId) {
    return res.status(503).send();
  }

  const span = trace.getActiveSpan();
  span?.updateName('POST /api/dpage');
  span?.setAttribute('pageturner.browser_id', browserId);
  span?.setAttribute('pageturner.page_id', pageId);
  span?.setAttribute('pageturner.fields_length', Object.keys(fields).length);

  try {
    const { json, html } = await initiateDistill(browserId, pageId, fields);

    if (html) {
      const formattedHtml = formatDistilledPage(html, browserId, pageId);
      return res.type('text/html').send(formattedHtml);
    }

    if (json) {
      // The data is ready, show the loading spinner until
      // poll-browser grabs it
      Logger.info('Distillation completed. Data is available!', { json });
      return res.type('text/html').send(SPINNER_HTML);
    }

    return res.status(500).send();
  } catch (error) {
    Logger.error('dpage handler failed', error as Error, { browserId, pageId });
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

    const span = trace.getActiveSpan();
    span?.updateName('POST /api/poll-browser');
    span?.setAttribute('pageturner.browser_id', browser_id);
    span?.setAttribute('pageturner.page_id', page_id);

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
  const span = trace.getActiveSpan();
  span?.updateName('POST /api/finalize-browser');
  try {
    const { browser_id, page_id } = req.body;

    if (!browser_id || !page_id) {
      return res.status(400).json({
        success: false,
        error: 'browser_id and page_id are required',
      });
    }

    span?.setAttribute('pageturner.browser_id', browser_id);
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
