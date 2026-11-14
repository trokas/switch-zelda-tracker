// Checks the Nintendo Store product page in a real browser and sends a push
// notification through ntfy.sh when the stock status changes.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const URL =
  process.env.PRODUCT_URL ||
  'https://store.nintendo.com/de-de/nintendo-switch-2-the-legend-of-zelda-edition-zum-40-jubilum-P00211';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const STATE_FILE = 'state/status.json';
const QUEUE_WAIT_MS = 90_000;

// Returns { status, detail } where status is one of:
// in_stock | out_of_stock | queue | unknown
async function check() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: 'de-DE' });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // The store sits behind a waiting room. Normally it passes visitors
    // straight through; give it some time, as a normal visitor would.
    try {
      await page.waitForURL((u) => u.hostname === 'store.nintendo.com', {
        timeout: QUEUE_WAIT_MS,
      });
    } catch {
      return { status: 'queue', detail: `still at ${new globalThis.URL(page.url()).hostname}` };
    }

    await page
      .waitForSelector('script[type="application/ld+json"]', { state: 'attached', timeout: 30_000 })
      .catch(() => {});

    return await page.evaluate(() => {
      let availability = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent);
          if (d['@type'] === 'Product' && d.offers) {
            availability = String(d.offers.availability || '');
          }
        } catch {}
      }
      const soldOutText = /nicht vorrätig/i.test(document.querySelector('main')?.innerText || '');

      if (availability && !/OutOfStock|SoldOut|Discontinued/i.test(availability)) {
        return { status: 'in_stock', detail: availability };
      }
      if (availability && soldOutText) {
        return { status: 'out_of_stock', detail: availability };
      }
      if (availability && !soldOutText) {
        // Structured data says sold out but the page no longer does.
        return { status: 'in_stock', detail: 'sold-out text disappeared' };
      }
      return {
        status: 'unknown',
        detail: `no product data found (title: ${document.title.slice(0, 80)})`,
      };
    });
  } finally {
    await browser.close();
  }
}

async function notify(title, message, { priority = 'default', tags = '' } = {}) {
  if (!NTFY_TOPIC) {
    console.log(`[dry run, NTFY_TOPIC not set] ${title}: ${message}`);
    return;
  }
  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Priority: priority, Tags: tags, Click: URL },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}

let result;
try {
  result = await check();
} catch (err) {
  result = { status: 'unknown', detail: String(err.message || err).slice(0, 200) };
}

let prev = {};
try {
  prev = JSON.parse(await readFile(STATE_FILE, 'utf8'));
} catch {}

const fails = result.status === 'unknown' ? (prev.fails || 0) + 1 : 0;
// "unknown" keeps the last real status so one flaky run does not re-trigger alerts.
const status = result.status === 'unknown' ? prev.status || 'unknown' : result.status;
console.log(`${new Date().toISOString()} ${result.status} (${result.detail}) previous=${prev.status}`);

if (result.status === 'in_stock' && prev.status !== 'in_stock') {
  await notify('Zelda Switch 2 is IN STOCK', 'Tap to open the Nintendo Store page.', {
    priority: 'urgent',
    tags: 'rotating_light',
  });
} else if (result.status === 'queue' && prev.status !== 'queue') {
  await notify(
    'Nintendo Store waiting room is active',
    'The tracker is being held in the queue. This often means a drop is happening. Check manually.',
    { priority: 'high', tags: 'hourglass' }
  );
} else if (result.status === 'out_of_stock' && prev.status !== 'out_of_stock') {
  const first = !prev.status;
  await notify(
    first ? 'Zelda Switch 2 tracker is running' : 'Zelda Switch 2 is out of stock again',
    first ? 'Currently out of stock. You will get a push when that changes.' : 'Back to waiting.',
    { priority: 'low' }
  );
} else if (fails === 6) {
  await notify('Zelda tracker cannot read the page', `6 failed checks in a row: ${result.detail}`, {
    tags: 'warning',
  });
}

await mkdir('state', { recursive: true });
await writeFile(STATE_FILE, JSON.stringify({ status, fails, checkedAt: new Date().toISOString() }));
