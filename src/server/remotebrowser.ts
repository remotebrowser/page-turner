import { chromium } from 'playwright';
import { consola } from 'consola';
import { RemoteBrowser } from '@remotebrowser/sdk';
import type { Browser, Page } from 'playwright';
import { settings } from './config.js';

const NAV_RETRY_ATTEMPTS = 30;
const NAV_RETRY_INTERVAL_MS = 1000;

const READY_TIMEOUT_MS = 45_000;
const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_TIMEOUT_MS = 10_000;
const DELETE_TIMEOUT_MS = 10_000;
const STARTING_STATUSES = new Set(['launched', 'starting']);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const normalizeStatus = (status?: string): string =>
  status?.toLowerCase() ?? '';

const remoteBrowser = new RemoteBrowser({
  apiKey: settings.REMOTEBROWSER_API_KEY || 'unset',
  baseURL: settings.REMOTEBROWSER_URL,
  fetch: (input, init) => {
    if (settings.REMOTEBROWSER_API_KEY) {
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.delete('Authorization');
    return fetch(input, { ...init, headers });
  },
});

export const authHeaders = (): Record<string, string> =>
  settings.REMOTEBROWSER_API_KEY ? remoteBrowser.authHeaders : {};

export async function createRemoteBrowser(
  headers?: Record<string, string>
): Promise<string> {
  // No retries: a retry after a lost response would leak a running browser.
  const { browser_id, status } = await remoteBrowser.browsers.create(
    {},
    { headers, maxRetries: 0 }
  );
  if (STARTING_STATUSES.has(normalizeStatus(status))) {
    try {
      await waitForBrowserReady(browser_id);
    } catch (err) {
      await destroyRemoteBrowser(browser_id).catch(() => undefined);
      throw err;
    }
  }
  return browser_id;
}

async function waitForBrowserReady(browserId: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { status, description } = await remoteBrowser.browsers.retrieve(
      browserId,
      { timeout: READY_POLL_TIMEOUT_MS }
    );
    const normalized = normalizeStatus(status);
    if (!normalized || normalized === 'running') {
      return;
    }
    if (!STARTING_STATUSES.has(normalized)) {
      throw new Error(
        `Remote browser ${browserId} is ${normalized}${description ? `: ${description}` : ''}`
      );
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Remote browser ${browserId} not ready after ${READY_TIMEOUT_MS / 1000}s`
  );
}

export async function destroyRemoteBrowser(browserId: string): Promise<void> {
  try {
    await remoteBrowser.browsers.delete(browserId, {
      timeout: DELETE_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof RemoteBrowser.NotFoundError)) {
      throw err;
    }
  }
}

export const connectRemoteBrowser = async (
  browserId: string
): Promise<Browser> => {
  return await chromium.connectOverCDP(
    remoteBrowser.browsers.connectUrl(browserId),
    { headers: authHeaders() }
  );
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
