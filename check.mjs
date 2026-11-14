// Checks product pages in a real browser and sends a push notification
// through ntfy.sh when a product's stock status changes.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// To track another shop, add an entry here. The page must carry schema.org
// Product data (most shops do). soldOutText is optional: the page's visible
// sold-out label, lower case; if it vanishes the product counts as in stock.
const PRODUCTS = [
  {
    id: 'nintendo-de',
    name: 'Nintendo Store DE',
    url: 'https://store.nintendo.com/de-de/nintendo-switch-2-the-legend-of-zelda-edition-zum-40-jubilum-P00211',
    soldOutText: 'nicht vorrätig',
  },
  {
    id: 'pressstart-pt',
    name: 'Press Start PT',
    url: 'https://www.pressstart.pt/en/nintendo-switch-2-consoles/nintendo-switch-2-console-the-legend-of-zelda-40th-anniversary-edition.html',
  },
];

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const STATE_FILE = 'state/status.json';
const QUEUE_WAIT_MS = 90_000;

// Returns { status, detail } where status is one of:
// in_stock | out_of_stock | queue | unknown
async function check(browser, product) {
  const context = await browser.newContext({ locale: 'en-GB' });
  try {
    const page = await context.newPage();
    const host = new URL(product.url).hostname;
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // A shop may sit behind a waiting room. Normally it passes visitors
    // straight through; give it some time, as a normal visitor would.
    try {
      await page.waitForURL((u) => u.hostname === host, { timeout: QUEUE_WAIT_MS });
    } catch {
      return { status: 'queue', detail: `still at ${new URL(page.url()).hostname}` };
    }

    await page
      .waitForSelector('script[type="application/ld+json"]', { state: 'attached', timeout: 30_000 })
      .catch(() => {});

    return await page.evaluate((soldOutText) => {
      let availability = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent);
          if (d['@type'] !== 'Product' || !d.offers) continue;
          const offer = Array.isArray(d.offers) ? d.offers[0] : d.offers;
          if (offer?.availability) availability = String(offer.availability);
        } catch {}
      }
      if (!availability) {
        return {
          status: 'unknown',
          detail: `no product data found (title: ${document.title.slice(0, 80)})`,
        };
      }
      if (!/OutOfStock|SoldOut|Discontinued/i.test(availability)) {
        return { status: 'in_stock', detail: availability };
      }
      const text = (document.querySelector('main') || document.body).innerText.toLowerCase();
      if (soldOutText && !text.includes(soldOutText)) {
        // Structured data says sold out but the page no longer does.
        return { status: 'in_stock', detail: 'sold-out text disappeared' };
      }
      return { status: 'out_of_stock', detail: availability };
    }, product.soldOutText || '');
  } finally {
    await context.close();
  }
}

async function notify(title, message, url, { priority = 'default', tags = '' } = {}) {
  if (!NTFY_TOPIC) {
    console.log(`[dry run, NTFY_TOPIC not set] ${title}: ${message}`);
    return;
  }
  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Priority: priority, Tags: tags, Click: url },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}

let saved = {};
try {
  saved = JSON.parse(await readFile(STATE_FILE, 'utf8'));
} catch {}
// Earlier versions stored a single status for the Nintendo Store only.
const state = saved.products || (saved.status ? { 'nintendo-de': saved } : {});

const browser = await chromium.launch();
for (const product of PRODUCTS) {
  let result;
  try {
    result = await check(browser, product);
  } catch (err) {
    result = { status: 'unknown', detail: String(err.message || err).slice(0, 200) };
  }

  const prev = state[product.id] || {};
  const fails = result.status === 'unknown' ? (prev.fails || 0) + 1 : 0;
  // "unknown" keeps the last real status so one flaky run does not re-trigger alerts.
  const status = result.status === 'unknown' ? prev.status || 'unknown' : result.status;
  console.log(
    `${new Date().toISOString()} ${product.id}: ${result.status} (${result.detail}) previous=${prev.status}`
  );

  try {
    if (result.status === 'in_stock' && prev.status !== 'in_stock') {
      await notify(`Zelda Switch 2 IN STOCK at ${product.name}`, 'Tap to open the product page.', product.url, {
        priority: 'urgent',
        tags: 'rotating_light',
      });
    } else if (result.status === 'queue' && prev.status !== 'queue') {
      await notify(
        `${product.name}: waiting room is active`,
        'The tracker is being held in the queue. This often means a drop is happening. Check manually.',
        product.url,
        { priority: 'high', tags: 'hourglass' }
      );
    } else if (result.status === 'out_of_stock' && prev.status !== 'out_of_stock') {
      const first = !prev.status;
      await notify(
        first ? `Now tracking ${product.name}` : `${product.name}: out of stock again`,
        first ? 'Currently out of stock. You will get a push when that changes.' : 'Back to waiting.',
        product.url,
        { priority: 'low' }
      );
    } else if (fails === 6) {
      await notify(
        `Tracker cannot read ${product.name}`,
        `6 failed checks in a row: ${result.detail}`,
        product.url,
        { tags: 'warning' }
      );
    }
    state[product.id] = { status, fails, checkedAt: new Date().toISOString() };
  } catch (err) {
    // Keep the previous state so the notification is retried on the next run.
    console.error(`${product.id}: notification failed: ${err.message}`);
  }
}
await browser.close();

await mkdir('state', { recursive: true });
await writeFile(STATE_FILE, JSON.stringify({ products: state }));
