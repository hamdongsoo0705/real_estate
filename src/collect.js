import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { selectListings } from './normalize.js';
import { toCsv } from './csv.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const API_URL = 'https://fin.land.naver.com/front-api/v1/complex/article/list';
const MAP_URL = 'https://fin.land.naver.com/map';
const outDir = path.join(ROOT, 'output');

async function fetchPage(page, complexNumber, lastInfo = []) {
  const payload = {
    size: 30,
    complexNumber,
    tradeTypes: ['A1'],
    pyeongTypes: [],
    dongNumbers: [],
    userChannelType: 'PC',
    articleSortType: 'RANKING_DESC',
    lastInfo,
  };

  return page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* logged by caller */ }
    return { ok: response.ok, status: response.status, data, preview: text.slice(0, 500) };
  }, { url: API_URL, body: payload });
}

function responseValue(data, key) {
  return data?.[key] ?? data?.data?.[key] ?? data?.result?.[key];
}

async function fetchAllArticles(page, complexNumber) {
  const articleList = [];
  let lastInfo = [];
  let previousCursor = '';

  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const response = await fetchPage(page, complexNumber, lastInfo);
    if (!response.ok || !response.data) {
      throw new Error(`HTTP ${response.status}; response=${response.preview}`);
    }
    const batch = responseValue(response.data, 'articleList')
      ?? responseValue(response.data, 'articles') ?? [];
    if (!Array.isArray(batch)) throw new Error('API response has no article array');
    articleList.push(...batch);

    const more = responseValue(response.data, 'isMoreData')
      ?? responseValue(response.data, 'hasMore');
    const next = responseValue(response.data, 'lastInfo');
    if (!batch.length || more === false || !Array.isArray(next) || !next.length) break;

    const cursor = JSON.stringify(next);
    if (cursor === previousCursor) throw new Error('Pagination cursor repeated; collection stopped safely');
    previousCursor = cursor;
    lastInfo = next;
    if (pageNumber === 100) throw new Error('Pagination exceeded the 100-page safety limit');
  }
  return { articleList };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const complexes = JSON.parse(await fs.readFile(path.join(ROOT, 'complexes.json'), 'utf8'))
    .filter((item) => item.enabled !== false);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await context.newPage();
  const failures = [];
  const rows = [];

  try {
    await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);

    for (const complex of complexes) {
      try {
        const data = await fetchAllArticles(page, Number(complex.complexNumber));
        const selected = selectListings(data, complex);
        rows.push(...selected);
        console.log(`[OK] ${complex.complexNumber}: selected ${selected.length} listings`);
      } catch (error) {
        const failure = { complexNumber: complex.complexNumber, error: String(error.message ?? error) };
        failures.push(failure);
        console.error(`[FAILED] ${complex.complexNumber}: ${failure.error}`);
      }
    }
  } finally {
    await browser.close();
  }

  const generatedAt = new Date().toISOString();
  await fs.writeFile(path.join(outDir, 'latest.json'), `${JSON.stringify({ generatedAt, rows, failures }, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'latest.csv'), toCsv(rows));
  if (failures.length) {
    await fs.writeFile(path.join(outDir, 'failures.json'), `${JSON.stringify({ generatedAt, failures }, null, 2)}\n`);
    throw new Error(`${failures.length} complex(es) failed; see output/failures.json`);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
