import { consola } from 'consola';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { settings } from './config.js';

const REMOTEBROWSER_RETRY_TIMEOUT_MS = 30_000;
const REMOTEBROWSER_RETRY_INTERVAL_MS = 1_000;

const PATTERNS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'patterns'
);

const SUPPORTED_PATTERN_EXTS = new Map<string, string>([
  ['.html', 'html'],
  ['.json', 'json'],
]);

function baseUrl(): string {
  return settings.REMOTEBROWSER_URL.replace(/\/+$/, '');
}

function buildUrl(path: string): string {
  return `${baseUrl()}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFetchHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}

export async function prepareNewBrowser(
  headers: Record<string, string | undefined> = {}
): Promise<{ browserId: string; pageId: string }> {
  const fetchHeaders = toFetchHeaders(headers);

  const createRes = await fetch(buildUrl(`/api/v1/browsers`), {
    method: 'POST',
    headers: fetchHeaders,
  });
  if (createRes.status !== 200) {
    const errorBody = await createRes.text().catch(() => '');
    const detail = errorBody ? `: ${errorBody}` : '';
    throw new Error(
      `Failed to create browser: HTTP ${createRes.status}${detail}`
    );
  }
  const { browser_id: browserId } = (await createRes.json()) as {
    browser_id: string;
  };

  const deadline = Date.now() + REMOTEBROWSER_RETRY_TIMEOUT_MS;
  let pageId: string | undefined;
  while (Date.now() < deadline) {
    try {
      const pagesRes = await fetch(
        buildUrl(`/api/v1/browsers/${browserId}/pages`)
      );
      if (pagesRes.ok) {
        const pageIds = (await pagesRes.json()) as unknown[];
        if (Array.isArray(pageIds) && pageIds.length > 0) {
          pageId = String(pageIds[0]);
          break;
        }
      }
    } catch (error) {
      consola.debug('Fetching pages failed, retrying', {
        browserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(REMOTEBROWSER_RETRY_INTERVAL_MS);
  }

  if (!pageId) {
    await deleteBrowser(browserId);
    throw new Error(`Browser ${browserId} never exposed any pages`);
  }

  return { browserId, pageId };
}

export async function navigatePage(
  browserId: string,
  pageId: string,
  url: string
): Promise<void> {
  const endpoint = `/api/v1/browsers/${browserId}/pages/${pageId}/navigate`;
  const deadline = Date.now() + REMOTEBROWSER_RETRY_TIMEOUT_MS;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${buildUrl(endpoint)}?url=${encodeURIComponent(url)}`,
      { method: 'POST' }
    );
    if (res.status === 200) return;
    lastStatus = res.status;
    await sleep(REMOTEBROWSER_RETRY_INTERVAL_MS);
  }

  throw new Error(
    `Navigate to ${url} never returned 200 (last status: ${
      lastStatus ?? 'unknown'
    })`
  );
}

async function uploadPatterns(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(PATTERNS_DIR);
  } catch (error) {
    consola.warn('Failed to read local patterns directory', {
      dir: PATTERNS_DIR,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const uploads = entries
    .map((entry) => {
      const ext = path.extname(entry);
      const patternExt = SUPPORTED_PATTERN_EXTS.get(ext);
      if (!patternExt) return null;
      const name = path.basename(entry, ext);
      return { name, ext: patternExt, file: path.join(PATTERNS_DIR, entry) };
    })
    .filter((u): u is { name: string; ext: string; file: string } => u !== null);

  const results = await Promise.allSettled(
    uploads.map(async ({ name, ext, file }) => {
      const content = await fs.readFile(file, 'utf8');
      const res = await fetch(
        buildUrl(`/api/v1/patterns/${name}?ext=${ext}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `Upload pattern ${name}.${ext} failed: HTTP ${res.status}${detail ? `: ${detail}` : ''}`
        );
      }
    })
  );

  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      failed++;
      consola.warn('Pattern upload failed', {
        pattern: uploads[i].name,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  const summary = `Patterns uploaded: ${results.length - failed}/${results.length} ok`;
  if (failed === 0) {
    consola.success(summary);
  } else {
    consola.error(summary);
  }
}

export async function distillPage(
  browserId: string,
  pageId: string,
  fields?: Record<string, string>
): Promise<void> {
  await uploadPatterns();
  const endpoint = `/api/v1/browsers/${browserId}/pages/${pageId}/distill`;
  const body = new URLSearchParams(fields ?? {}).toString();
  const deadline = Date.now() + REMOTEBROWSER_RETRY_TIMEOUT_MS;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    const res = await fetch(buildUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status === 200) return;
    lastStatus = res.status;
    await sleep(REMOTEBROWSER_RETRY_INTERVAL_MS);
  }

  throw new Error(
    `Distill never returned 200 for ${browserId}/${pageId} (last status: ${
      lastStatus ?? 'unknown'
    })`
  );
}

export async function getDistilledJson<T = unknown>(
  browserId: string,
  pageId: string
): Promise<T> {
  const endpoint = `/api/v1/browsers/${browserId}/pages/${pageId}/distilled`;
  const deadline = Date.now() + REMOTEBROWSER_RETRY_TIMEOUT_MS;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    const res = await fetch(buildUrl(endpoint));
    if (res.status === 200) {
      return (await res.json()) as T;
    }
    lastStatus = res.status;
    await sleep(REMOTEBROWSER_RETRY_INTERVAL_MS);
  }

  throw new Error(
    `Distilled endpoint never returned 200 for ${browserId}/${pageId} (last status: ${
      lastStatus ?? 'unknown'
    })`
  );
}

export async function getDistilledHtml(
  browserId: string,
  pageId: string
): Promise<string> {
  const endpoint = `/api/v1/browsers/${browserId}/pages/${pageId}/distilled`;
  const deadline = Date.now() + REMOTEBROWSER_RETRY_TIMEOUT_MS;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    const res = await fetch(buildUrl(endpoint));
    if (res.status === 200) {
      return await res.text();
    }
    lastStatus = res.status;
    await sleep(REMOTEBROWSER_RETRY_INTERVAL_MS);
  }

  throw new Error(
    `Distilled endpoint never returned 200 for ${browserId}/${pageId} (last status: ${
      lastStatus ?? 'unknown'
    })`
  );
}

export async function deleteBrowser(browserId: string): Promise<void> {
  try {
    const res = await fetch(buildUrl(`/api/v1/browsers/${browserId}`), {
      method: 'DELETE',
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      consola.warn('Failed to delete browser', {
        browserId,
        status: res.status,
        body: errorBody,
      });
    }
  } catch (error) {
    consola.warn('Failed to delete browser', {
      browserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
