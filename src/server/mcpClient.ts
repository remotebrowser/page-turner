import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { settings } from './config.js';
import { getLocation } from './locationService.js';

const mcpClient: Record<string, Client | null> = {};
const goodreadsUiResourceBySession: Record<string, string | null> = {};
let initPromise: Promise<Client> | null = null;

const mcpUrl = `${settings.GETGATHER_URL}/mcp-books/`;
Logger.info('mcpUrl', { mcpUrl });
async function initializeMcpClient(
  sessionId: string,
  ipAddress: string
): Promise<Client> {
  if (mcpClient[sessionId]) return mcpClient[sessionId];
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const client = new Client(
      { name: 'page-turner-server', version: '1.0.0' },
      // Loosen type for capabilities to avoid SDK type drift issues.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      } as any
    );

    const location = await getLocation(ipAddress);

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${settings.GETGATHER_APP_KEY}_${sessionId}`,
          'x-getgather-custom-app': 'page-turner',
          'x-location': location ? JSON.stringify(location) : '',
          'x-incognito': '1',
        },
      },
    });

    await client.connect(transport);
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
  ipAddress: string
): Promise<Client> {
  try {
    if (mcpClient[sessionId]) {
      await mcpClient[sessionId].close().catch(() => {});
    }
  } finally {
    mcpClient[sessionId] = null;
  }
  return initializeMcpClient(sessionId, ipAddress);
}

export async function callToolWithReconnect(
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    sessionId: string;
    ipAddress: string;
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
  try {
    const client = getMcpClient(params.sessionId);
    return await client.callTool(params, resultSchema, options);
  } catch (err) {
    Logger.warn('callTool failed, attempting MCP client reconnect...', {
      name: params.name,
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await resetAndReinitializeMcpClient(params.sessionId, params.ipAddress);
    const client = getMcpClient(params.sessionId);
    return await client.callTool(params, resultSchema, options);
  }
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

export async function getGoodreadsUiResourceUri(
  sessionId: string,
  ipAddress: string
): Promise<string | null> {
  const cached = goodreadsUiResourceBySession[sessionId];
  if (cached !== undefined) {
    return cached;
  }

  let resourceUri: string | null = null;

  try {
    let client: Client;
    try {
      client = getMcpClient(sessionId);
    } catch {
      client = await initializeMcpClient(sessionId, ipAddress);
    }
    const toolsResponse =
      (await (client as unknown as { listTools?: () => Promise<{ tools: McpTool[] }> }).listTools?.()) ??
      (await (client as unknown as { request: (payload: { method: string; params?: unknown }) => Promise<{ tools: McpTool[] }> }).request(
        {
          method: 'tools/list',
          params: {},
        }
      ));

    const tools = toolsResponse?.tools ?? [];
    const goodreadsTool = tools.find(
      (tool) => tool.name === 'goodreads_remote_get_book_list'
    );

    resourceUri = goodreadsTool?._meta?.ui?.resourceUri ?? null;
  } catch (error) {
    Logger.warn('Failed to get Goodreads UI resource URI', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  goodreadsUiResourceBySession[sessionId] = resourceUri;
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
