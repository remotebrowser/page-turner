import * as Sentry from '@sentry/node';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { createRequire } from 'module';
import { Socket } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { BrandConfig } from './modules/Config';
import { settings } from './server/config.js';
import { TOOL_NAMES } from './server/constants.js';
import './server/instrument.js';
import { getClientIp, getLocation } from './server/locationService.js';
import {
  callToolWithReconnect,
  getGoodreadsUiResourceUri,
  readUiResourceHtml,
} from './server/mcpClient.js';
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

function getAppHost(req: express.Request): string {
  // If APP_HOST is explicitly set, use it
  if (process.env.APP_HOST) {
    return process.env.APP_HOST;
  }

  // Get protocol (http/https)
  const protocol = req.protocol;

  // Get host (includes hostname and port if present)
  const host = req.get('host') || 'localhost:5173';

  return `${protocol}://${host}`;
}

function normalizeHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

async function getMcpRequestHeaders(req: express.Request) {
  const connection = (req.query['connection'] as string) || null;
  return {
    'x-origin-ip': getClientIp(req),
    'x-forwarded-for': getClientIp(req),
    'user-agent': normalizeHeaderValue(req.headers['user-agent']),
    'sec-ch-ua': normalizeHeaderValue(req.headers['sec-ch-ua']),
    'sec-ch-ua-mobile': normalizeHeaderValue(req.headers['sec-ch-ua-mobile']),
    'sec-ch-ua-platform': normalizeHeaderValue(
      req.headers['sec-ch-ua-platform']
    ),
    'x-proxy-type': connection || undefined,
  };
}

// Middleware
app.use(cors());
app.use(express.json());

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
app.get('/api/mcp-apps/ui', async (req, res) => {
  try {
    const resourceUri = req.query.resourceUri;

    if (typeof resourceUri !== 'string' || !resourceUri) {
      res.status(400).send('resourceUri query parameter is required');
      return;
    }

    const sessionId = req.sessionID;
    const ipAddress = getClientIp(req);

    const html = await readUiResourceHtml(sessionId, ipAddress, resourceUri);

    if (html) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    // Fallback: use signin URL from request query if present
    const signinUrl =
      typeof req.query.signin_url === 'string'
        ? req.query.signin_url
        : undefined;
    if (signinUrl) {
      return res.redirect(signinUrl);
    }

    // No further fallback; just return error
    res
      .status(404)
      .send('MCP Apps UI resource not found and no signin URL provided');
  } catch (error) {
    Logger.error(
      'MCP Apps UI proxy error:',
      error instanceof Error ? error : undefined,
      {
        req: req.toString(),
      }
    );
    res.status(500).send('Failed to load MCP Apps UI resource');
  }
});

app.post('/api/get-book-list', async (req, res) => {
  try {
    const sessionId = req.sessionID;
    const ipAddress = getClientIp(req);

    const headers = await getMcpRequestHeaders(req);
    const [result, uiResourceUri] = await Promise.all([
      callToolWithReconnect(
        {
          name: TOOL_NAMES.GOODREADS_GET_BOOK_LIST,
          sessionId,
          ipAddress,
          headers,
        },
        undefined,
        {
          timeout: 600_000,
          maxTotalTimeout: 600_000,
        }
      ),
      getGoodreadsUiResourceUri(sessionId, ipAddress),
    ]);

    const structuredContent = result.structuredContent as {
      url?: string;
      signin_id?: string;
      [goodreadsConfig.dataTransform.dataPath]: unknown;
    };

    if (structuredContent?.url?.includes(settings.GETGATHER_URL ?? '')) {
      Logger.info('signin URL found', {
        signin_id: structuredContent.signin_id,
      });
      const appHost = getAppHost(req);
      const proxyPath = structuredContent.url.replace(
        settings.GETGATHER_URL,
        `${appHost}`
      );

      return res.json({
        success: true,
        data: {
          url: proxyPath,
          signin_id: structuredContent.signin_id,
          ui_resource_uri: uiResourceUri ?? null,
          tool_result: {
            ...result,
            content:
              (result.content as Array<Record<string, string>>)?.map(
                (item: Record<string, string>) => ({
                  ...item,
                  text: item.text.replace(settings.GETGATHER_URL, appHost),
                })
              ) ?? [],
            structuredContent: {
              ...structuredContent,
              url: proxyPath,
            },
          },
        },
      });
    }

    Logger.error('No signin URL found');
    return res.json({
      success: false,
      error: 'No signin URL found',
    });
  } catch (error) {
    Logger.error('Get book list error:', error as Error, {
      req: req.toString(),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/poll-signin', async (req, res) => {
  try {
    const { signin_id } = req.body;

    if (!signin_id) {
      return res.status(400).json({
        success: false,
        error: 'signin_id is required',
      });
    }

    const headers = await getMcpRequestHeaders(req);
    const signInResult = await callToolWithReconnect(
      {
        name: 'check_signin',
        arguments: { signin_id },
        sessionId: req.sessionID,
        ipAddress: getClientIp(req),
        headers,
      },
      undefined,
      {
        timeout: 600_000,
        maxTotalTimeout: 600_000,
      }
    );

    const signInContent = signInResult.structuredContent as {
      status?: string;
      message?: string;
    };
    let bookListContent = null;
    if (signInContent.status === 'SUCCESS') {
      Logger.info('Signin success', { signin_id });
      const bookListResult = await callToolWithReconnect({
        name: TOOL_NAMES.GOODREADS_GET_BOOK_LIST,
        sessionId: req.sessionID,
        ipAddress: getClientIp(req),
        headers: { ...headers, 'x-signin-id': signin_id },
      });
      const structuredContent = bookListResult.structuredContent as {
        goodreads_book_list: Array<{
          title: string;
          author: string;
          rating: string;
          url: string;
          cover: string;
          shelf: string;
          added_date: string;
        }>;
      };
      bookListContent = structuredContent.goodreads_book_list;
      Logger.info('Book list received', { count: bookListContent.length });
    }

    res.json({
      success: true,
      data: {
        status: signInContent.status,
        message: signInContent.message,
        [goodreadsConfig.dataTransform.dataPath]: bookListContent ?? [],
      },
    });
  } catch (error) {
    Logger.error('Poll auth error:', error as Error, { req: req.toString() });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/finalize-signin', async (req, res) => {
  try {
    const { signin_id } = req.body;

    if (!signin_id) {
      return res.status(400).json({
        success: false,
        error: 'signin_id is required',
      });
    }

    const headers = await getMcpRequestHeaders(req);
    await callToolWithReconnect(
      {
        name: 'finalize_signin',
        arguments: { signin_id },
        sessionId: req.sessionID,
        ipAddress: getClientIp(req),
        headers,
      },
      undefined,
      {
        timeout: 600_000,
        maxTotalTimeout: 600_000,
      }
    );
    Logger.info('Signin finalized', { signin_id });

    res.json({
      success: true,
    });
  } catch (error) {
    Logger.error('Finalize signin error:', error as Error, {
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

// Initialize MCP client and start server
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
    Logger.error('Failed to initialize MCP client:', error as Error);
    process.exit(1);
  }
}

startServer();
