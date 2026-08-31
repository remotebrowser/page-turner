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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { BrandConfig } from './modules/Config';
import { settings } from './server/config.js';
import { trace } from '@opentelemetry/api';
import './server/instrument.js';
import {
  createRemoteBrowser,
  destroyRemoteBrowser,
  getPage,
  navigatePage,
  connectRemoteBrowser,
} from './server/remotebrowser.js';
import type { Browser, Page } from 'playwright';
import {
  autoclick,
  convert,
  distill,
  parse,
  patternsDir,
} from './server/distill.js';
import type { PatternEntry } from './server/distill.js';
import { consola } from 'consola';

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

const patterns: PatternEntry[] = readdirSync(patternsDir)
  .map((file) => path.join(patternsDir, file))
  .filter((name) => {
    const st = statSync(name);
    return st && !st.isDirectory();
  })
  .filter((name) => name.endsWith('.html'))
  .map((name) => {
    const content = readFileSync(name, 'utf-8');
    const pattern = parse(content);
    return { name, pattern };
  });

consola.info(`Loaded ${patterns.length} distillation patterns`);

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

function getClientIp(request: express.Request): string {
  const xff = request.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }

  return request.ip || request.connection.remoteAddress || 'unknown';
}

async function getImportantHeaders(req: express.Request) {
  const headers: Record<string, string> = {
    'x-origin-ip': getClientIp(req),
  };
  const ua = normalizeHeaderValue(req.headers['user-agent']);
  if (ua) {
    headers['user-agent'] = ua;
  }
  return headers;
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

const distillationStore = new Map<string, Record<string, string>[]>();

async function initiateDistill(
  hostname: string,
  page: Page,
  fields: Record<string, string> = {}
): Promise<{ json?: Record<string, string>[]; html?: string }> {
  // If fields are provided, fill them into form inputs on the page before distilling
  if (Object.keys(fields).length > 0) {
    for (const [key, value] of Object.entries(fields)) {
      try {
        await page.fill(`[name="${key}"]`, value);
      } catch {
        consola.warn(`Could not fill field '${key}' on the page`);
      }
    }
  }

  const match = await distill(hostname, patterns, page);
  console.log('match is', { match });
  if (!match) {
    // Fallback: return the raw page HTML when no pattern matches
    const html = await page.content();
    return { html };
  }

  const converted = await convert(match.distilled, patternsDir);
  if (converted.length > 0) {
    return { json: converted };
  }

  // Return distilled HTML when conversion does not produce rows
  return { html: match.distilled };
}

app.post('/api/get-book-list', async (req, res) => {
  const sessionId = req.sessionID!;

  const span = trace.getActiveSpan();
  span?.updateName('POST /api/get-book-list');

  let browserId: string | undefined;
  let browser: Browser | undefined;

  try {
    const headers = await getImportantHeaders(req);
    const hostname = new URL(GOODREADS_REVIEW_LIST_URL).hostname;

    consola.start('Creating remote browser');
    browserId = await createRemoteBrowser(headers);
    span?.setAttribute('pageturner.browser_id', browserId);

    browser = await connectRemoteBrowser(browserId);
    const { page, targetId } = await getPage(browser);

    consola.start('Navigating to Goodreads', { browserId });
    await navigatePage(page, GOODREADS_REVIEW_LIST_URL);

    span?.setAttribute('pageturner.page_id', targetId);

    const hostnameToUse = hostname;
    const { html } = await initiateDistill(hostnameToUse, page);
    if (!html) {
      return res.status(500).send();
    }
    const responseData = {
      browserId,
      pageId: targetId,
      html: formatDistilledPage(html, browserId, targetId),
    };
    return res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    consola.error('get-book-list handler failed', error as Error, {
      sessionId,
    });
    return res.status(500).send();
  } finally {
    if (browser) {
      try {
        await browser.close();
        consola.info('Playwright browser disconnected', { browserId });
      } catch (e) {
        consola.error('Error closing Playwright browser:', e as Error);
      }
    }
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

  let browser: Browser | undefined;

  try {
    browser = await connectRemoteBrowser(browserId);
    const { page } = await getPage(browser, pageId);

    const hostname = new URL(GOODREADS_REVIEW_LIST_URL).hostname;

    const TICK = 1000; // ms
    const TIMEOUT = 15 * 1000; // ms
    const max = TIMEOUT / TICK;

    const current: { name: string | null; distilled: string | null } = {
      name: null,
      distilled: null,
    };

    for (let iteration = 0; iteration < max; iteration++) {
      consola.log(`Iteration ${iteration + 1} of ${max}`);
      await sleep(TICK);

      const match = await distill(hostname, patterns, page);
      if (!match) {
        if (iteration === 0) {
          const html = await page.content();
          if (html) {
            return res
              .type('text/html')
              .send(formatDistilledPage(html, browserId, pageId));
          }
        }
        consola.warn('No matched pattern found');
        continue;
      }

      const { distilled } = match;
      if (distilled === current.distilled) {
        consola.log('Still the same:', match.name);
        continue;
      }

      current.name = match.name;
      current.distilled = distilled;

      // If the distilled content terminates, convert it to the final result
      const converted = await convert(distilled, patternsDir);
      if (converted.length > 0) {
        // Store the result so poll-browser can pick it up
        distillationStore.set(browserId, converted);
        consola.success('Distillation completed. Data is available!', {
          json: converted,
        });
        return res.type('text/html').send(SPINNER_HTML);
      }

      // Fill the submitted form fields into the page using the distilled inputs
      const document = parse(distilled);
      const names: string[] = [];
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        const selector = input.getAttribute('rb-match');
        const name = input.getAttribute('name') ?? '';
        if (!selector) continue;

        const type = input.getAttribute('type');
        if (type === 'checkbox') {
          if (!name) {
            consola.warn('No name for the checkbox', selector);
            continue;
          }
          const value = fields[name];
          if (value && value.length > 0) {
            consola.info(`Checking checkbox ${name}`);
            await page.check(selector);
          }
          names.push(name);
        } else if (type === 'radio') {
          const value = fields[name];
          if (!value || value.length === 0) {
            consola.warn('No form data found for radio button group', name);
            continue;
          }
          const radio = document.querySelector(
            `input[type=radio][id="${value}"]`
          );
          if (!radio) {
            consola.warn('No radio button found with id', value);
            continue;
          }
          const radioSelector = radio.getAttribute('rb-match');
          if (!radioSelector) continue;
          consola.info(`Checking radio button ${name}=${value}`);
          await page.check(radioSelector);
          names.push(input.id || 'radio');
        } else if (name) {
          const value = fields[name];
          if (value && value.length > 0) {
            consola.info(`Using form data ${name}`);
            names.push(name);
            try {
              await page.fill(selector, value);
            } catch (err) {
              consola.warn(`Could not fill field '${name}'`, err as Error);
            }
            delete fields[name];
          } else {
            consola.warn(`No form data found for ${name}`);
          }
        }
      }

      await autoclick(page, distilled, '[rb-autoclick]:not(button)');

      const SUBMIT_BUTTON = 'button[rb-autoclick], button[type="submit"]';
      if (document.querySelector(SUBMIT_BUTTON)) {
        if (names.length > 0 && inputs.length === names.length) {
          consola.log('Submitting form, all fields are filled...');
          await autoclick(page, distilled, SUBMIT_BUTTON);
          continue;
        }
        consola.warn('Not all form fields are filled');
        return res
          .type('text/html')
          .send(formatDistilledPage(distilled, browserId, pageId));
      }
    }

    return res.status(503).send();
  } catch (error) {
    consola.error('dpage handler failed', error as Error, {
      browserId,
      pageId,
    });
    return res.status(500).send();
  } finally {
    if (browser) {
      try {
        await browser.close();
        consola.info('Playwright browser disconnected', { browserId });
      } catch (e) {
        consola.error('Error closing Playwright browser:', e as Error);
      }
    }
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

    // Check the in-memory store for distillation results
    const stored = distillationStore.get(browser_id);
    const bookListContent = stored ?? [];
    const status = bookListContent.length > 0 ? 'SUCCESS' : 'PENDING';

    res.json({
      success: true,
      data: {
        status,
        [goodreadsConfig.dataTransform.dataPath]: bookListContent,
      },
    });
  } catch (error) {
    consola.error('Poll browser error:', error as Error, {
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
    await destroyRemoteBrowser(browser_id);
    distillationStore.delete(browser_id);
    consola.info('Browser finalized', { browser_id, page_id });

    res.json({
      success: true,
    });
  } catch (error) {
    consola.error('Finalize browser error:', error as Error, {
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
    target: `${settings.REMOTEBROWSER_URL}${path}`,
    changeOrigin: true,
    on: {
      proxyReq: fixRequestBody,
      error: (
        err: Error,
        req: express.Request,
        res: express.Response | Socket
      ) => {
        consola.error('Proxy error:', err, { req: req.toString() });
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
    consola.error('Unhandled server error', err, {
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
      consola.success(`Server running on port ${PORT}`);
      if (settings.NODE_ENV === 'production') {
        app.set('trust proxy', 1);
        consola.info('Serving static files from dist/');
      } else {
        consola.info('API only mode - use Vite dev server for frontend');
      }
    });
  } catch (error) {
    consola.error('Failed to start server:', error as Error);
    process.exit(1);
  }
}

startServer();
