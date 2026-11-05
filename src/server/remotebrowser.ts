import { chromium } from 'playwright';
import { consola } from 'consola';
import type { Browser, Page } from 'playwright';
import { settings } from './config.js';

const NAV_RETRY_ATTEMPTS = 30;
const NAV_RETRY_INTERVAL_MS = 1000;

const READY_TIMEOUT_MS = 45_000;
const READY_POLL_INTERVAL_MS = 500;
const STARTING_STATUSES = new Set(['launched', 'starting']);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const authHeaders = (): Record<string, string> =>
  settings.REMOTEBROWSER_API_KEY
    ? { Authorization: `Bearer ${settings.REMOTEBROWSER_API_KEY}` }
    : {};

export async function createRemoteBrowser(
  headers?: Record<string, string>
): Promise<string> {
  const url = `${settings.REMOTEBROWSER_URL}/api/v1/browsers`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...authHeaders(),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create remote browser: ${response.status} ${response.statusText}`
    );
  }
  const { browser_id, status } = (await response.json()) as {
    browser_id: string;
    status?: string;
  };
  if (STARTING_STATUSES.has(status?.toLowerCase() ?? '')) {
    await waitForBrowserReady(browser_id);
  }
  return browser_id;
}

async function waitForBrowserReady(browserId: string): Promise<void> {
  const url = `${settings.REMOTEBROWSER_URL}/api/v1/browsers/${browserId}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (true) {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) {
      throw new Error(
        `Failed to get remote browser status: ${response.status} ${response.statusText}`
      );
    }
    const { status, description } = (await response.json()) as {
      status?: string;
      description?: string;
    };
    const normalized = status?.toLowerCase() ?? '';
    if (!normalized || normalized === 'running') {
      return;
    }
    if (!STARTING_STATUSES.has(normalized)) {
      throw new Error(
        `Remote browser ${browserId} is ${normalized}${description ? `: ${description}` : ''}`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Remote browser ${browserId} not ready after ${READY_TIMEOUT_MS / 1000}s`
      );
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
}

export async function destroyRemoteBrowser(browserId: string): Promise<void> {
  const url = `${settings.REMOTEBROWSER_URL}/api/v1/browsers/${browserId}`;
  await fetch(url, { method: 'DELETE', headers: authHeaders() });
}

export const getCdpUrl = (browserId: string): string => {
  const baseUrl = settings.REMOTEBROWSER_URL.replace(/\/+$/, '');
  const protocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  return (
    baseUrl.replace(/^https?:\/\//, `${protocol}://`) +
    `/api/v1/browsers/${browserId}/cdp`
  );
};

export const connectRemoteBrowser = async (
  browserId: string
): Promise<Browser> => {
  return await chromium.connectOverCDP(getCdpUrl(browserId), {
    headers: authHeaders(),
  });
};

export const getPage = async (
  browser: Browser,
  pageId?: string
): Promise<{ page: Page; targetId: string }> => {
  if (pageId) {
    const page = await findPageByTargetId(browser, pageId);
    return { page, targetId: pageId };
  }
  const [context] = browser.contexts();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    if (!targetInfo) {
      throw new Error('Target.getTargetInfo returned no target info');
    }
    return { page, targetId: targetInfo.targetId };
  } finally {
    await session.detach();
  }
};

export const navigatePage = async (page: Page, url: string): Promise<void> => {
  for (let attempt = 0; attempt < NAV_RETRY_ATTEMPTS; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (err) {
      consola.warn('Navigation attempt failed, retrying...', {
        attempt,
        err: (err as Error).message,
      });
    }
    await sleep(NAV_RETRY_INTERVAL_MS);
  }
  throw new Error(`Failed to navigate to ${url}`);
};

export const findPageByTargetId = async (
  browser: Browser,
  targetId: string
): Promise<Page> => {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const session = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (!targetInfo) {
          continue;
        }
        if (targetInfo.targetId === targetId) {
          return page;
        }
      } finally {
        await session.detach();
      }
    }
  }
  throw new Error(`Page with target ID ${targetId} not found`);
};
