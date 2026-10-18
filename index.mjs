// Mağaza fiyat robotu — gerçek Chromium (Playwright) ile çalışır.
// GitHub Actions zamanlayıcısı her 3 saatte bir çağırır.
// Yerel test: TEST_URLS="https://www.trendyol.com/..." node index.mjs

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const HEADLESS = process.env.HEADLESS !== '0';

const PRICE_SELECTORS = [
  '.prc-dsc',
  '.prc-slg',
  '[data-testid="product-price"]',
  '.product-price',
];

const SEARCH_URLS = {
  Trendyol: (query) => `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`,
  n11: (query) => `https://www.n11.com/arama?q=${encodeURIComponent(query)}`,
  Hepsiburada: (query) =>
    `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`,
  Amazon: (query) =>
    `https://www.amazon.com.tr/s?k=${encodeURIComponent(query)}`,
  ÇiçekSepeti: (query) =>
    `https://www.ciceksepeti.com/arama?query=${encodeURIComponent(query)}`,
  Pazarama: (query) =>
    `https://www.pazarama.com/arama?q=${encodeURIComponent(query)}`,
};

const SEARCH_SELECTORS = [
  '[data-testid="product-card"]',
  '[data-testid="product-card-wrapper"]',
  'article',
  '[class*="productCard"]',
  '[class*="product-card"]',
  '[class*="productListContent"]',
];

const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button:has-text("Kabul Et")',
  'button:has-text("Tümünü Kabul Et")',
  'button:has-text("Onayla")',
  'button:has-text("Accept")',
];

function parsePrice(raw) {
  if (raw == null) return null;
  let t = String(raw).replace(/[^\d.,]/g, '').trim();
  if (!t) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    t = lastComma > lastDot
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (lastComma > -1) {
    t = t.replace(',', '.');
  }
  const v = parseFloat(t);
  return Number.isNaN(v) ? null : v;
}

function findPrice(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const p = findPrice(item);
      if (p != null) return p;
    }
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const type = data['@type'];
  const isType = (t) => type === t || (Array.isArray(type) && type.includes(t));
  if (isType('Offer')) {
    const p = parsePrice(data.price ?? data.lowPrice ?? data.highPrice);
    if (p != null) return p;
  }
  if (isType('Product')) {
    const p = findPrice(data.offers);
    if (p != null) return p;
  }
  if ('@graph' in data) return findPrice(data['@graph']);
  return null;
}

async function dismissConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // sıradakini dene
    }
  }
}

async function searchStore(page, platform, query) {
  const buildUrl = SEARCH_URLS[platform];
  if (!buildUrl) return [];
  const searchUrl = buildUrl(query);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await dismissConsent(page);
  await page.waitForTimeout(2500);

  return page.evaluate(({ platform: site, searchUrl: base, selectors }) => {
    const parsePrice = (raw) => {
      const text = String(raw ?? '').replace(/[^\d.,]/g, '').trim();
      if (!text) return null;
      const comma = text.lastIndexOf(',');
      const dot = text.lastIndexOf('.');
      const normalized = comma > dot
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
      const value = Number.parseFloat(normalized);
      return Number.isFinite(value) ? value : null;
    };
    const output = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const card of document.querySelectorAll(selector)) {
        const link = card.querySelector('a[href]');
        const href = link?.href || '';
        const name = (card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"]')
          ?.textContent || link?.textContent || '').replace(/\s+/g, ' ').trim();
        const rawPrice = card.querySelector(
          '[data-testid*="price"], [class*="price"], [class*="fiyat"]',
        )?.textContent;
        const image = card.querySelector('img')?.src || null;
        if (!href || !name || seen.has(href)) continue;
        seen.add(href);
        output.push({
          platform: site,
          name,
          url: new URL(href, base).toString(),
          price: parsePrice(rawPrice),
          image_url: image,
        });
        if (output.length >= 12) return output;
      }
      if (output.length >= 12) break;
    }
    return output;
  }, { platform, searchUrl, selectors: SEARCH_SELECTORS });
}

async function scrapePrice(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await dismissConsent(page);

  let price = null;
  for (const sel of PRICE_SELECTORS) {
    const el = page.locator(sel).first();
    try {
      await el.waitFor({ state: 'visible', timeout: 12000 });
      price = parsePrice(await el.textContent());
      if (price != null) break;
    } catch {
      // sıradakini dene
    }
  }

  if (price == null) {
    const lds = await page.locator('script[type="application/ld+json"]').allTextContents();
    for (const t of lds) {
      try {
        price = findPrice(JSON.parse(t));
        if (price != null) break;
      } catch {
        // bozuk JSON-LD
      }
    }
  }

  let name = null;
  try {
    name = (await page.title())?.replace(/\s*-\s*Fiyatı.*$/i, '').trim() || null;
  } catch {
    // yoksay
  }
  return { price, name };
}

async function newPage(context) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return page;
}

const dryUrls = (process.env.TEST_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  locale: 'tr-TR',
  timezoneId: 'Europe/Istanbul',
  viewport: { width: 1366, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

if (dryUrls.length) {
  for (const url of dryUrls) {
    const page = await newPage(context);
    try {
      const r = await scrapePrice(page, url);
      console.log(`[DRY] ${url} => price: ${r.price} | name: ${r.name}`);
    } catch (e) {
      console.log(`[DRY] ${url} => HATA: ${e.message}`);
    }
    await page.close();
  }
  await browser.close();
  process.exit(0);
}

const searchQuery = (process.env.SEARCH_QUERY || '').trim();
if (searchQuery) {
  const searchSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const requestedPlatforms = (process.env.SEARCH_PLATFORMS || Object.keys(SEARCH_URLS).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => SEARCH_URLS[value]);
  const results = [];
  for (const platform of requestedPlatforms) {
    const page = await newPage(context);
    try {
      const found = await searchStore(page, platform, searchQuery);
      results.push(...found);
      console.log(`${platform}: ${found.length} sonuç`);
    } catch (e) {
      console.log(`${platform}: HATA: ${e.message}`);
    }
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1500));
  }
  const searchId = process.env.SEARCH_REQUEST_ID;
  if (searchId) {
    await searchSupabase.from('product_search_results').delete().eq('search_id', searchId);
    if (results.length) {
      await searchSupabase.from('product_search_results').insert(
        results.map((result) => ({ search_id: searchId, ...result })),
      );
    }
    await searchSupabase
      .from('product_searches')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', searchId);
  }
  console.log(JSON.stringify({ query: searchQuery, results }));
  await browser.close();
  process.exit(0);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const { data: products, error } = await supabase
  .from('tracked_products')
  .select('*')
  .eq('is_active', true)
  .like('url', '%trendyol.com%')
  .limit(60);

if (error) {
  console.error('Urun listesi alinamadi:', error.message);
  process.exit(1);
}

console.log(`Trendyol urun sayisi: ${products?.length ?? 0}`);

let checked = 0;
let alerts = 0;
let failed = 0;

for (const p of products ?? []) {
  const page = await newPage(context);
  try {
    const r = await scrapePrice(page, p.url);
    if (r.price == null) {
      console.log(`Fiyat bulunamadi: ${p.url}`);
      failed++;
    } else {
      await supabase
        .from('price_history')
        .insert({ product_id: p.id, price: r.price });
      await supabase
        .from('tracked_products')
        .update({
          current_price: r.price,
          updated_at: new Date().toISOString(),
        })
        .eq('id', p.id);

      if (
        p.target_price != null &&
        r.price <= p.target_price &&
        p.notify_on_drop
      ) {
        await supabase.from('notifications').insert({
          user_id: p.user_id,
          type: 'price_alert',
          title: 'Fiyat hedefe ulaştı!',
          body: `${p.name} · ₺${r.price}`,
        });
        alerts++;
      }
      checked++;
      console.log(`OK ${p.name}: ${r.price} TL`);
    }
  } catch (e) {
    failed++;
    console.log(`Hata ${p.url}: ${e.message}`);
  }
  await page.close();
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
}

await browser.close();
console.log(JSON.stringify({ checked, alerts, failed }));
