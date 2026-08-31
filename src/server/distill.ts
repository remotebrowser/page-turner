import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { consola } from 'consola';
import type { Page } from 'playwright';

export const patternsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'patterns'
);

export const parse = (html: string): Document => {
  return new JSDOM(html).window.document;
};

export interface PatternEntry {
  name: string;
  pattern: Document;
}

export interface DistillationResult {
  name: string;
  priority: number;
  distilled: string;
}

const click = async (
  page: Page,
  selector: string,
  timeout = 3 * 1000
): Promise<void> => {
  const LOCATOR_ALL_TIMEOUT = 100; // ms
  const locator = page.locator(selector);
  try {
    const elements = await locator.all();
    for (const element of elements) {
      if (!(await element.isVisible())) continue;
      try {
        await element.click();
        return;
      } catch (err) {
        consola.warn('Failed to click on', selector, element, err);
      }
    }
  } catch (e) {
    const error = e as Error;
    if (timeout > 0 && error.constructor.name === 'TimeoutError') {
      return await click(page, selector, timeout - LOCATOR_ALL_TIMEOUT);
    }
    throw e;
  }
};

export const autoclick = async (
  page: Page,
  distilled: string,
  expr: string
): Promise<void> => {
  const document = parse(distilled);
  const elements = document.querySelectorAll(expr);
  for (const el of elements) {
    const selector = el.getAttribute('rb-match');
    if (selector) {
      consola.info(`Clicking ${selector}`);
      await click(page, selector, 3 * 1000);
    }
  }
};

const isLocal = (hostname?: string): boolean =>
  hostname
    ? hostname.includes('localhost') || hostname.includes('127.0.0.1')
    : false;

const matchDomain = (hostname: string, domain?: string | null): boolean =>
  domain ? hostname.toLowerCase().includes(domain.toLowerCase()) : true;

export const distill = async (
  hostname: string,
  patterns: PatternEntry[],
  page: Page
): Promise<DistillationResult | undefined> => {
  const results: DistillationResult[] = [];

  for (const { name, pattern } of patterns) {
    const root = pattern.querySelector('html');
    const priorityAttr = root ? root.getAttribute('rb-priority') : null;
    const priority = priorityAttr ? parseInt(priorityAttr, 10) : -1;
    const domain = root?.getAttribute('rb-domain');

    if (!isLocal(hostname)) {
      if (!matchDomain(hostname, domain)) {
        continue;
      }
    }

    consola.debug(`Checking pattern ${name} (priority ${priority})`);

    const targets = pattern.querySelectorAll('[rb-match], [rb-match-html]');
    if (targets.length === 0) continue;

    let found = true;
    let matchCount = 0;
    for (const target of targets) {
      const isHtml = target.hasAttribute('rb-match-html');
      const attr = isHtml ? 'rb-match-html' : 'rb-match';
      const selector = target.getAttribute(attr);
      if (!selector) continue;

      // Evaluate one selector at a time
      const locator = page.locator(selector);
      const count = await locator.count();
      let el: ReturnType<typeof locator.nth> | null = null;
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const candidate = locator.nth(i);
          if (await candidate.isVisible()) {
            el = candidate;
            break;
          }
        }
      }

      if (el) {
        const [text, innerHtml, tagName, value] = await Promise.all([
          el.textContent().then((t) => (t ?? '').trim()),
          el.innerHTML(),
          el.evaluate((node: Element) => (node.tagName || '').toLowerCase()),
          el.inputValue().catch(() => null as string | null),
        ]);

        if (isHtml) {
          target.innerHTML = innerHtml;
        } else {
          // Form controls such as <input type="submit"> carry their visible
          // label in `value` rather than in text content, so fall back to it
          // to keep the distilled element readable.
          const label = text || value;
          if (label && label?.length > 0) {
            target.textContent = label;
          }
          if (['input', 'textarea', 'select'].includes(tagName)) {
            if (value !== null) {
              target.setAttribute('value', value);
              (target as HTMLInputElement).value = value;
            }
          }
        }
        matchCount++;
      } else {
        const optional = target.hasAttribute('rb-optional');
        if (!optional) {
          found = false;
        }
      }
    }

    if (found && matchCount > 0) {
      const distilled = pattern.documentElement.outerHTML;
      results.push({ name, priority, distilled });
    }
  }

  results.sort((a, b) => a.priority - b.priority);
  if (results.length === 0) {
    consola.warn('No matching pattern found');
    return undefined;
  }

  const best = results[0];
  consola.success(`Best match: ${best.name} (priority ${best.priority})`);
  return best;
};

const extractValue = (item: Element, attribute?: string): string => {
  if (attribute) {
    let value = item.getAttribute(attribute);
    if (Array.isArray(value)) {
      value = value.length > 0 ? value[0] : '';
    }
    return typeof value === 'string' ? value.trim() : '';
  }
  return item?.textContent?.trim() ?? '';
};

export const convert = async (
  distilled: string,
  patternsDir: string
): Promise<Record<string, string>[]> => {
  const document = parse(distilled);

  const stopEl = document.querySelector('[rb-stop][rb-convert]');
  if (!stopEl) {
    consola.warn('No rb-convert attribute found in distilled content');
    return [];
  }

  const convertFile = stopEl.getAttribute('rb-convert');
  if (!convertFile) return [];

  const jsonPath = path.join(patternsDir, convertFile);
  let converter: {
    rows?: string;
    columns?: {
      name: string;
      selector: string;
      attribute?: string;
      kind?: string;
    }[];
  };
  try {
    const content = readFileSync(jsonPath, 'utf-8');
    converter = JSON.parse(content);
  } catch (err) {
    consola.error(`Failed to load convert config ${convertFile}`, err as Error);
    return [];
  }

  if (!converter.rows || !converter.columns) {
    consola.warn(`Invalid convert config in ${convertFile}`);
    return [];
  }

  const rows = Array.from(document.querySelectorAll(converter.rows));
  consola.info(
    `Converting using selector "${converter.rows}": ${rows.length} rows`
  );

  const converted: Record<string, string>[] = [];
  for (const el of rows) {
    const kv: Record<string, string> = {};
    for (const col of converter.columns) {
      if (col.kind === 'list') {
        const items = el.querySelectorAll(col.selector);
        kv[col.name] = Array.from(items)
          .map((item) => extractValue(item, col.attribute))
          .join(', ');
      } else {
        const item = el.querySelector(col.selector);
        if (item) {
          kv[col.name] = extractValue(item, col.attribute);
        }
      }
    }
    if (Object.keys(kv).length > 0) {
      converted.push(kv);
    }
  }

  consola.success(`Converted ${converted.length} entries`);
  return converted;
};
