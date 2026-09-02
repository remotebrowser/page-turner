import './server/instrument.js';

import * as Sentry from '@sentry/node';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { getCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import dotenv from 'dotenv';
import { parseHTML } from 'linkedom';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { BrandConfig } from './modules/Config';
import { settings } from './server/config.js';
import { trace } from '@opentelemetry/api';
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

type Variables = {
  sessionID: string;
};

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

const app = new Hono<{ Variables: Variables }>();
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

function getClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    return xff.split(',')[0].trim();
  }
  return 'unknown';
}

async function getImportantHeaders(c: Context) {
  const headers: Record<string, string> = {
    'x-origin-ip': getClientIp(c),
  };
  const ua = c.req.header('user-agent');
  if (ua) {
    headers['user-agent'] = ua;
  }
  return headers;
}

// Middleware
app.use(cors());

// Session middleware
app.use('/api/*', async (c: Context<{ Variables: Variables }>, next: Next) => {
  const headerSessionId = c.req.header('x-session-id');
  let sessionId = headerSessionId;
  if (!sessionId) {
    sessionId = getCookie(c, 'session-id');
  }
  if (!sessionId) {
    return c.json({ error: 'session-id is required' }, 400);
  }
  c.set('sessionID', sessionId);
  Sentry.getIsolationScope().setTag('session_id', sessionId);
  await next();
});

// Sentry config
app.get('/internal/sentry/config', (c) => {
  return c.json({
    dsn: settings.SENTRY_DSN,
    environment: settings.ENVIRONMENT,
  });
});

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.post('/api/get-book-list', async (c) => {
  const sessionId = c.get('sessionID');

  const span = trace.getActiveSpan();
  span?.updateName('POST /api/get-book-list');

  let browserId: string | undefined;
  let browser: Browser | undefined;

  try {
    const headers = await getImportantHeaders(c);
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
      return c.body(null, 500);
    }
    const responseData = {
      browserId,
      pageId: targetId,
      html: formatDistilledPage(html, browserId, targetId),
    };
    return c.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    consola.error('get-book-list handler failed', error as Error, {
      sessionId,
    });
    return c.body(null, 500);
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

app.get('/api/dpage/:browserId/:pageId', (c) => {
  const browserId = c.req.param('browserId');
  const pageId = c.req.param('pageId');
  if (!browserId || !pageId) {
    return c.body(null, 503);
  }

  const span = trace.getActiveSpan();
  span?.updateName('GET /api/dpage (will redirect)');
  span?.setAttribute('pageturner.browser_id', browserId);
  span?.setAttribute('pageturner.page_id', pageId);

  return c.html(redirect(`/api/dpage/${browserId}/${pageId}`));
});

app.post('/api/dpage/:browserId/:pageId', async (c) => {
  const browserId = c.req.param('browserId');
  const pageId = c.req.param('pageId');

  // Parse body supporting both JSON (API clients) and URL-encoded (HTML forms)
  const contentType = c.req.header('content-type') || '';
  let body: Record<string, unknown> = {};
  if (contentType.includes('application/json')) {
    body = await c.req.json().catch(() => ({}));
  } else {
    body = await c.req.parseBody().catch(() => ({}));
  }

  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    fields[key] = typeof value === 'string' ? value : String(value);
  }

  if (!browserId || !pageId) {
    return c.body(null, 503);
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
            return c.html(
              formatDistilledPage(html, browserId, pageId)
            );
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
        return c.html(SPINNER_HTML);
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
        return c.html(
          formatDistilledPage(distilled, browserId, pageId)
        );
      }
    }

    return c.body(null, 503);
  } catch (error) {
    consola.error('dpage handler failed', error as Error, {
      browserId,
      pageId,
    });
    return c.body(null, 500);
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

app.post('/api/poll-browser', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { browser_id, page_id } = body;

    if (!browser_id || !page_id) {
      return c.json({
        success: false,
        error: 'browser_id and page_id are required',
      }, 400);
    }

    const span = trace.getActiveSpan();
    span?.updateName('POST /api/poll-browser');
    span?.setAttribute('pageturner.browser_id', browser_id);
    span?.setAttribute('pageturner.page_id', page_id);

    // Check the in-memory store for distillation results
    const stored = distillationStore.get(browser_id);
    const bookListContent = stored ?? [];
    const status = bookListContent.length > 0 ? 'SUCCESS' : 'PENDING';

    return c.json({
      success: true,
      data: {
        status,
        [goodreadsConfig.dataTransform.dataPath]: bookListContent,
      },
    });
  } catch (error) {
    consola.error('Poll browser error:', error as Error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

app.post('/api/finalize-browser', async (c) => {
  const span = trace.getActiveSpan();
  span?.updateName('POST /api/finalize-browser');
  try {
    const body = await c.req.json().catch(() => ({}));
    const { browser_id, page_id } = body;

    if (!browser_id || !page_id) {
      return c.json({
        success: false,
        error: 'browser_id and page_id are required',
      }, 400);
    }

    span?.setAttribute('pageturner.browser_id', browser_id);
    await destroyRemoteBrowser(browser_id);
    distillationStore.delete(browser_id);
    consola.info('Browser finalized', { browser_id, page_id });

    return c.json({
      success: true,
    });
  } catch (error) {
    consola.error('Finalize browser error:', error as Error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// Proxy handler for forwarding requests to the remote browser
const createProxyHandler = () => {
  return async (c: Context) => {
    const targetUrl = `${settings.REMOTEBROWSER_URL}${c.req.path}`;

    const headers = new Headers();
    c.req.raw.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        ['host', 'connection', 'transfer-encoding', 'keep-alive'].includes(
          lower
        )
      ) {
        return;
      }
      headers.set(key, value);
    });
    headers.set('host', new URL(targetUrl).host);

    const init: RequestInit = {
      method: c.req.method,
      headers,
      redirect: 'manual',
    };

    if (
      c.req.method !== 'GET' &&
      c.req.method !== 'HEAD' &&
      c.req.raw.body
    ) {
      init.body = await c.req.raw.clone().arrayBuffer();
    }

    try {
      const response = await fetch(targetUrl, init);

      const resHeaders = new Headers();
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (
          ['transfer-encoding', 'connection', 'keep-alive'].includes(lower)
        ) {
          return;
        }
        resHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      consola.error('Proxy error:', err as Error, { url: targetUrl });
      return c.json({ error: 'Proxy error occurred' }, 500);
    }
  };
};

const proxyPaths = [
  '/auth',
  '/link',
  '/dpage',
  '/assets',
  '/static',
  '/__assets',
  '/__static',
];

// Register proxy routes (after local routes so they take precedence)
proxyPaths.forEach((proxyPath) => {
  app.all(proxyPath, createProxyHandler());
  app.all(`${proxyPath}/*`, createProxyHandler());
});

// API proxy catch-all (for API routes not handled locally)
app.all('/api/*', createProxyHandler());

// Global error handler — Sentry captures exceptions with full Hono request context
Sentry.setupHonoErrorHandler(app);

// Serve static files only in production
if (settings.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, '..', 'dist');

  // Serve static assets (JS, CSS, images, etc.)
  app.use('/static-assets/*', serveStatic({ root: distDir }));
  app.use('/favicon.svg', serveStatic({ root: distDir }));
  app.use('/favicon.ico', serveStatic({ root: distDir }));
  app.use('/style.css', serveStatic({ root: distDir }));
  app.use('/signin.js', serveStatic({ root: distDir }));

  // SPA fallback: serve index.html for any non-API, non-static route
  app.get('*', (c) => {
    // Skip API and health routes (they're handled above)
    if (c.req.path.startsWith('/api/') || c.req.path === '/health') {
      return c.notFound();
    }
    try {
      const html = readFileSync(path.join(distDir, 'index.html'), 'utf-8');
      return c.html(html);
    } catch {
      return c.notFound();
    }
  });
}

serve(
  {
    fetch: app.fetch,
    port: Number(PORT),
  },
  (info) => {
    consola.success(`Server running on port ${info.port}`);
    if (settings.NODE_ENV === 'production') {
      consola.info('Serving static files from dist/');
    } else {
      consola.info('API only mode - use Vite dev server for frontend');
    }
  }
);
