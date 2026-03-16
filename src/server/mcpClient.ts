import {
  Client,
  ClientOptions,
} from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { settings } from './config.js';
import { TOOL_NAMES } from './constants.js';
import { getLocation } from './locationService.js';

const mcpClient: Record<string, Client | null> = {};

type GoodreadsUiCacheEntry = {
  uri: string | null;
  expiresAt: number;
};

const GOODREADS_UI_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const goodreadsUiResourceBySession: Record<
  string,
  GoodreadsUiCacheEntry | undefined
> = {};
const mcpClientHeaders: Record<string, string | null> = {};
let initPromise: Promise<Client> | null = null;

const mcpUrl = `${settings.GETGATHER_URL}/mcp-books/`;
Logger.info('mcpUrl', { mcpUrl });
async function initializeMcpClient(
  sessionId: string,
  ipAddress: string,
  requestHeaders?: Record<string, string | undefined>
): Promise<Client> {
  if (mcpClient[sessionId]) return mcpClient[sessionId];
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const client = new Client(
      { name: 'page-turner-server', version: '1.0.0' },
      {
        capabilities: {
          tools: { list: true, call: true },
          resources: { list: true, read: true },
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: ['text/html;profile=mcp-app'],
            },
          },
        },
      } as ClientOptions
    );

    const location = await getLocation(ipAddress);

    const dynamicHeaders = Object.fromEntries(
      Object.entries(requestHeaders ?? {}).filter(
        ([, value]) => typeof value === 'string'
      )
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${settings.GETGATHER_APP_KEY}_${sessionId}`,
          ...dynamicHeaders,
        },
      },
    });

    await client.connect(transport);

    // Warm up Goodreads UI resource URI cache once after MCP client init.
    // Fire-and-forget so we don't block initialization.
    void getGoodreadsUiResourceUri(sessionId, ipAddress).catch((error) => {
      Logger.warn('Failed to warm Goodreads UI resource URI cache', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    mcpClient[sessionId] = client;
    return client;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

function getMcpClient(sessionId: string): Client {
  if (!mcpClient[sessionId]) {
    Logger.warn(
      'MCP client not initialized. Call initializeMcpClient() first.',
      {
        sessionId,
        error: new Error(
          'MCP client not initialized. Call initializeMcpClient() first.'
        ),
      }
    );
    throw new Error(
      'MCP client not initialized. Call initializeMcpClient() first.'
    );
  }
  return mcpClient[sessionId];
}

async function resetAndReinitializeMcpClient(
  sessionId: string,
  ipAddress: string,
  requestHeaders?: Record<string, string | undefined>
): Promise<Client> {
  try {
    if (mcpClient[sessionId]) {
      await mcpClient[sessionId].close().catch(() => {});
    }
  } finally {
    mcpClient[sessionId] = null;
  }
  return initializeMcpClient(sessionId, ipAddress, requestHeaders);
}

export async function callToolWithReconnect(
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    sessionId: string;
    ipAddress: string;
    headers?: Record<string, string | undefined>;
  },
  resultSchema?:
    | typeof CallToolResultSchema
    | typeof CompatibilityCallToolResultSchema,
  options?: RequestOptions
) {
  Logger.info('Calling tool:', {
    name: params.name,
    sessionId: params.sessionId,
  });
  const { headers, ...toolParams } = params;
  const headerSignature = JSON.stringify(
    Object.fromEntries(
      Object.entries(headers ?? {})
        .filter(([, value]) => typeof value === 'string')
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
  try {
    if (mcpClientHeaders[params.sessionId] !== headerSignature) {
      await resetAndReinitializeMcpClient(
        params.sessionId,
        params.ipAddress,
        headers
      );
      mcpClientHeaders[params.sessionId] = headerSignature;
    }
    const client = getMcpClient(params.sessionId);
    return await client.callTool(toolParams, resultSchema, options);
  } catch (err) {
    Logger.warn('callTool failed, attempting MCP client reconnect...', {
      name: params.name,
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await resetAndReinitializeMcpClient(
      params.sessionId,
      params.ipAddress,
      headers
    );
    mcpClientHeaders[params.sessionId] = headerSignature;
    const client = getMcpClient(params.sessionId);
    return await client.callTool(toolParams, resultSchema, options);
  }
}

export async function getGoodreadsUiResourceUri(
  sessionId: string,
  ipAddress: string
): Promise<string | null> {
  const entry = goodreadsUiResourceBySession[sessionId];

  const now = Date.now();

  if (entry && entry.expiresAt > now) {
    // Refresh in the background to keep cache up to date.
    void fetchGoodreadsUiResourceUri(sessionId, ipAddress).catch((error) => {
      Logger.warn('Failed to refresh Goodreads UI resource URI cache', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return entry.uri;
  }

  // No cache yet; fetch and return (also populates the cache).
  return fetchGoodreadsUiResourceUri(sessionId, ipAddress);
}

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: {
    ui?: {
      resourceUri?: string;
    };
    [key: string]: unknown;
  };
};

export async function fetchGoodreadsUiResourceUri(
  sessionId: string,
  ipAddress: string
): Promise<string | null> {
  let resourceUri: string | null = null;

  try {
    let client: Client;
    try {
      client = getMcpClient(sessionId);
    } catch {
      client = await initializeMcpClient(sessionId, ipAddress);
    }
    const toolsResponse: { tools: McpTool[] } = await client.listTools();

    const tools = toolsResponse?.tools ?? [];
    const goodreadsTool = tools.find(
      (tool) => tool.name === TOOL_NAMES.GOODREADS_GET_BOOK_LIST
    );

    resourceUri = goodreadsTool?._meta?.ui?.resourceUri ?? null;
  } catch (error) {
    Logger.warn('Failed to get Goodreads UI resource URI', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  goodreadsUiResourceBySession[sessionId] = {
    uri: resourceUri,
    expiresAt: Date.now() + GOODREADS_UI_CACHE_TTL_MS,
  };
  return resourceUri;
}

export async function readUiResourceHtml(
  sessionId: string,
  ipAddress: string,
  resourceUri: string
): Promise<string | null> {
  try {
    let client: Client;
    try {
      client = getMcpClient(sessionId);
    } catch {
      client = await initializeMcpClient(sessionId, ipAddress);
    }
    const { contents = [] } = await client.readResource({ uri: resourceUri });
    const entry =
      contents.find(
        (c) =>
          c.uri === resourceUri ||
          c.mimeType === 'text/html;profile=mcp-app' ||
          c.mimeType === 'text/html' ||
          c.mimeType === 'application/xhtml+xml'
      ) ?? contents[0];

    return entry && 'text' in entry ? entry.text : null;
  } catch (error) {
    Logger.warn('Failed to read UI resource', {
      resourceUri,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
