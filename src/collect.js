import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { selectRenderedListings } from './dom-parser.js';
import { toCsv } from './csv.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const outDir = path.join(ROOT, 'output');
const PYEONG_PER_SQM = 0.3025;
async function openComplex(page, complex) {
  if (!complex.pageUrl) throw new Error('complexes.json에 pageUrl이 없습니다');
  if (page.url() !== complex.pageUrl) {
    await page.goto(complex.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  const heading = page.getByRole('heading', {
    name: complex.naverComplexName ?? complex.complexName,
    exact: true,
  }).first();
  await heading.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('heading', { name: /매물\s*\d+\s*개/ })
    .waitFor({ state: 'visible', timeout: 30_000 });
}

async function renderedCards(page) {
  return page.locator('li[class*="ArticleCard-module"][class*="__item"]')
    .evaluateAll((items) => items.map((item) => ({
      href: item.querySelector('a[href*="/articles/"]')?.getAttribute('href') ?? '',
      text: item.innerText?.trim() ?? '',
    })));
}

async function openCheckboxFilter(page, buttonId, labelPrefix) {
  const button = page.locator(`button#${buttonId}`).first();
  if (!await button.isVisible().catch(() => false)) {
    throw new Error(`${buttonId} 필터 버튼을 찾지 못했습니다`);
  }
  // React mounts the checkbox layer only after the chip is opened.
  let options = page.locator(`label[for^="${labelPrefix}"]`);
  for (let attempt = 1; attempt <= 3
    && !await options.first().isVisible().catch(() => false); attempt += 1) {
    if (attempt > 1) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    }
    await button.click();
    await page.waitForTimeout(1_000);
    options = page.locator(`label[for^="${labelPrefix}"]`);
  }
  if (!await options.first().isVisible().catch(() => false)) {
    throw new Error(`${buttonId} 필터 항목을 열지 못했습니다`);
  }
  return { button, options };
}

async function selectSaleOnly(page) {
  const currentButton = page.locator('button#거래유형').first();
  if (await currentButton.isVisible().catch(() => false)
    && (await currentButton.innerText()).trim() === '매매') {
    return;
  }
  const { button } = await openCheckboxFilter(page, '거래유형', '거래유형-checkbox-');
  const sale = page.locator('label[for="거래유형-checkbox-A1"]');
  if (!String(await sale.getAttribute('class')).includes('is-checked')) await sale.click();

  for (const code of ['B1', 'B2', 'B3']) {
    const option = page.locator(`label[for="거래유형-checkbox-${code}"]`);
    if (await option.count()
      && String(await option.getAttribute('class')).includes('is-checked')) {
      await option.click();
      await page.waitForTimeout(200);
    }
  }
  await button.click();
  await page.waitForTimeout(800);
}

async function targetAreaGroups(page, { minPyeong = 30, maxPyeong = 39 } = {}) {
  const { button, options } = await openCheckboxFilter(page, '면적', '면적-checkbox-');
  const optionCount = await options.count();
  const groups = new Map();
  for (let index = 0; index < optionCount; index += 1) {
    const option = options.nth(index);
    const text = await option.innerText();
    const sqm = Number(text.match(/^([0-9]+(?:\.[0-9]+)?)[A-Za-z]*㎡/)?.[1]);
    if (!Number.isFinite(sqm)) continue;
    const pyeong = sqm * PYEONG_PER_SQM;
    if (pyeong >= minPyeong && pyeong < maxPyeong + 1) {
      const id = await option.getAttribute('for');
      const numericArea = Math.floor(sqm);
      if (id) {
        if (!groups.has(numericArea)) groups.set(numericArea, []);
        groups.get(numericArea).push(id);
      }
    }
  }
  await button.click();
  return [...groups.entries()].sort(([a], [b]) => a - b);
}

async function selectAreaGroup(page, targetIds) {
  const wanted = new Set(targetIds);
  const { button, options } = await openCheckboxFilter(page, '면적', '면적-checkbox-');
  const optionCount = await options.count();
  const states = [];
  for (let index = 0; index < optionCount; index += 1) {
    const option = options.nth(index);
    const id = await option.getAttribute('for');
    const text = await option.innerText();
    if (!/^([0-9]+(?:\.[0-9]+)?)[A-Za-z]*㎡/.test(text)) continue;
    const shouldCheck = wanted.has(id);
    const isChecked = String(await option.getAttribute('class')).includes('is-checked');
    states.push({ id, option, shouldCheck, isChecked });
  }

  const mismatches = states.filter(({ shouldCheck, isChecked }) => shouldCheck !== isChecked);
  if (mismatches.length > wanted.size + 1) {
    // Clearing dozens of options one by one is very slow because every click
    // refreshes the listing. Toggle 전체면적 to select all, then clear all,
    // and enable only the desired area types.
    const allAreas = page.locator('label[for="면적-checkbox-0"]');
    const allChecked = String(await allAreas.getAttribute('class')).includes('is-checked');
    if (!allChecked) {
      await allAreas.click();
      await page.waitForTimeout(150);
    }
    await allAreas.click();
    await page.waitForTimeout(150);
    for (const id of wanted) {
      await page.locator(`label[for="${id}"]`).click();
      await page.waitForTimeout(150);
    }
  } else {
    for (const { option } of mismatches) {
      await option.click();
      await page.waitForTimeout(150);
    }
  }
  await button.click();
  await page.waitForTimeout(800);
}

async function selectLowestPriceSort(page) {
  const priceSort = page.locator('label[for="filterOrder2"]').first();
  if (!await priceSort.isVisible().catch(() => false)) {
    const cards = await renderedCards(page);
    if (!cards.length) throw new Error('가격순 정렬 버튼과 매물 목록을 모두 찾지 못했습니다');
    const first = cards[0]?.href || cards[0]?.text || '';
    return { beforeFirst: first, afterFirst: first, unavailable: true };
  }

  const before = await renderedCards(page);
  const beforeFirst = before[0]?.href || before[0]?.text || '';
  const currentLabel = await priceSort.innerText();
  if (/낮은\s*가격순/.test(currentLabel)) {
    return { beforeFirst, afterFirst: beforeFirst, alreadySelected: true };
  }
  const priceInput = page.locator('#filterOrder2');
  const waitUntil = async (predicate, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  // Entering price sort from ranking selects the high-price direction first.
  // Wait for the radio state instead of assuming the UI finishes in one second.
  const isPriceSelected = () => priceInput.evaluate((input) => input.checked).catch(() => false);
  if (!await isPriceSelected()) {
    await priceSort.click();
    if (!await waitUntil(isPriceSelected)) {
      throw new Error('가격순 정렬 선택이 적용되지 않았습니다');
    }
  }
  if (!/낮은\s*가격순/.test(await priceSort.innerText())) {
    await priceSort.click();
    await waitUntil(async () => /낮은\s*가격순/.test(await priceSort.innerText()), 8_000);
  }
  const selectedLabel = await priceSort.innerText();
  if (!/낮은\s*가격순/.test(selectedLabel)) {
    throw new Error(`낮은 가격순 정렬을 확인하지 못했습니다: ${selectedLabel}`);
  }

  // A selected sort can keep the same first listing. Waiting for the article
  // list itself, followed by a short stabilization delay, is more reliable
  // than requiring the first card to change.
  await page.locator('li[class*="ArticleCard-module"][class*="__item"]')
    .first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_000);
  const after = await renderedCards(page);
  if (!after.length) throw new Error('가격순 정렬 후 매물 목록이 비었습니다');

  return { beforeFirst, afterFirst: after[0]?.href || after[0]?.text || '' };
}

async function scrollArticleList(page) {
  const cardSelector = 'li[class*="ArticleCard-module"][class*="__item"]';
  const collected = new Map();
  let previousCount = -1;
  let stagnantRounds = 0;
  let reachedBottomRounds = 0;

  // Start at the top because Naver preserves the list scroll position while
  // switching complexes in the same map page.
  await page.locator(cardSelector).first().evaluate((card) => {
    let node = card.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 20
        && /(auto|scroll)/.test(style.overflowY)) {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
  });
  await page.waitForTimeout(500);

  for (let round = 0; round < 60; round += 1) {
    const cards = await renderedCards(page);
    for (const card of cards) {
      const key = card.href || card.text;
      if (key) collected.set(key, card);
    }

    stagnantRounds = collected.size === previousCount ? stagnantRounds + 1 : 0;
    previousCount = collected.size;

    const scroll = await page.locator(cardSelector).first().evaluate((card) => {
      let node = card.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 20
          && /(auto|scroll)/.test(style.overflowY)) {
          const before = node.scrollTop;
          const distance = Math.max(Math.floor(node.clientHeight * 0.8), 600);
          node.scrollTop = Math.min(node.scrollTop + distance, node.scrollHeight);
          return {
            before,
            after: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            atBottom: node.scrollTop + node.clientHeight >= node.scrollHeight - 5,
          };
        }
        node = node.parentElement;
      }
      return null;
    });

    if (!scroll) {
      // Some list versions render every loaded card without an inner scrolling
      // element. Price sorting still makes the first cards the cheapest.
      break;
    }
    reachedBottomRounds = scroll.atBottom ? reachedBottomRounds + 1 : 0;
    if ((reachedBottomRounds >= 3 && stagnantRounds >= 3) || stagnantRounds >= 8) break;
    await page.waitForTimeout(scroll.atBottom ? 1_000 : 250);
  }

  return [...collected.values()];
}

async function collectComplex(page, complex) {
  await openComplex(page, complex);
  await page.locator('li[class*="ArticleCard-module"][class*="__item"]')
    .first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await selectSaleOnly(page);
  const areaGroups = await targetAreaGroups(page);
  if (!areaGroups.length) {
    console.log(`[OK] ${complex.complexNumber}: no 30-39 pyeong supply area, selected 0 listings`);
    return [];
  }
  const cardMap = new Map();
  let sortChanged = false;
  const addCards = (cards) => {
    for (const card of cards) {
      const key = card.href || card.text;
      if (key) cardMap.set(key, card);
    }
  };

  // First request all target areas together. When Naver returns fewer than
  // its usual 150-card cap, this is already the complete result set and no
  // per-area requests are needed.
  await selectAreaGroup(page, areaGroups.flatMap(([, ids]) => ids));
  const hasCombinedCards = await page.locator('li[class*="ArticleCard-module"][class*="__item"]')
    .first().waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasCombinedCards) {
    console.log(`[OK] ${complex.complexNumber}: target areas have no sale listings, selected 0 listings`);
    return [];
  }
  const combinedSort = await selectLowestPriceSort(page);
  sortChanged ||= combinedSort.beforeFirst !== combinedSort.afterFirst;
  const combinedCards = await renderedCards(page);
  addCards(combinedCards);
  const combinedRows = selectRenderedListings(combinedCards, complex);
  const combinedCounts = new Map();
  for (const row of combinedRows) {
    const area = Math.floor(row.supplySpace);
    combinedCounts.set(area, (combinedCounts.get(area) ?? 0) + 1);
  }
  const mayBeCapped = combinedCards.length >= 145;
  console.log(`[INFO] ${complex.complexNumber}: combined first-page ${combinedCards.length}, ${mayBeCapped ? 'capped' : 'complete'}`);

  if (mayBeCapped) {
    for (const [numericArea, areaIds] of areaGroups) {
      const existing = combinedCounts.get(numericArea) ?? 0;
      if (existing >= 3) continue;
      await selectAreaGroup(page, areaIds);
      const hasCards = await page.locator('li[class*="ArticleCard-module"][class*="__item"]')
        .first().waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!hasCards) {
        console.log(`[INFO] ${complex.complexNumber} ${numericArea}㎡: no sale listings`);
        continue;
      }
      const sortState = await selectLowestPriceSort(page);
      sortChanged ||= sortState.beforeFirst !== sortState.afterFirst;
      const firstPageCards = await renderedCards(page);
      const firstPageSelected = selectRenderedListings(firstPageCards, complex)
        .filter((row) => Math.floor(row.supplySpace) === numericArea).length;
      const areaCards = firstPageCards.length >= 145 && firstPageSelected < 3
        ? await scrollArticleList(page)
        : firstPageCards;
      addCards(areaCards);
      console.log(`[INFO] ${complex.complexNumber} ${numericArea}㎡: supplemental ${firstPageCards.length}, candidates ${firstPageSelected}`);
    }
  }
  const cards = [...cardMap.values()];
  if (!cards.length) throw new Error('화면에서 매물 카드를 찾지 못했습니다');
  const rows = selectRenderedListings(cards, complex);
  console.log(`[OK] ${complex.complexNumber}: areas ${areaGroups.length}, accumulated ${cards.length}, price-sort ${sortChanged ? 'changed' : 'stable'}, selected ${rows.length} listings`);
  return rows;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const allConfigured = JSON.parse(await fs.readFile(path.join(ROOT, 'complexes.json'), 'utf8'))
    .filter((item) => item.enabled !== false);
  const onlyComplexName = process.env.ONLY_COMPLEX_NAME?.trim();
  const configured = onlyComplexName
    ? allConfigured.filter((item) => item.complexName === onlyComplexName)
    : allConfigured;
  const complexes = configured.filter((item) => item.collectionReady === true && item.pageUrl);
  console.log(`[INFO] configured ${configured.length}, collection-ready ${complexes.length}, pending ${configured.length - complexes.length}`);
  if (!complexes.length) throw new Error('수집 준비가 완료된 단지가 없습니다');
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  } catch (error) {
    throw new Error('수집용 Chrome에 연결할 수 없습니다. 먼저 npm.cmd run browser를 실행하세요.', { cause: error });
  }
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().startsWith('https://fin.land.naver.com/map'));
  if (!page) throw new Error('수집용 Chrome에서 네이버 부동산 지도 탭을 찾지 못했습니다');
  const failures = [];
  const rows = [];

  for (const complex of complexes) {
    try {
      rows.push(...await collectComplex(page, complex));
    } catch (error) {
      const failure = { complexNumber: complex.complexNumber, error: String(error.message ?? error) };
      failures.push(failure);
      console.error(`[FAILED] ${complex.complexNumber}: ${failure.error}`);
      await page.screenshot({ path: path.join(outDir, `failure-${complex.complexNumber}.png`), fullPage: true })
        .catch(() => {});
      await fs.writeFile(path.join(outDir, `failure-${complex.complexNumber}.html`), await page.content())
        .catch(() => {});
    }
    await page.waitForTimeout(1_500);
  }
  let outputRows = rows;
  let outputFailures = failures;
  if (onlyComplexName) {
    try {
      const previous = JSON.parse(await fs.readFile(path.join(outDir, 'latest.json'), 'utf8'));
      const targetNumbers = new Set(complexes.map((item) => Number(item.complexNumber)));
      const validNumbers = new Set(allConfigured.map((item) => Number(item.complexNumber)));
      outputRows = [
        ...(previous.rows ?? []).filter((row) => !targetNumbers.has(Number(row.complexNumber))),
        ...rows,
      ];
      outputFailures = [
        ...(previous.failures ?? []).filter((failure) => validNumbers.has(Number(failure.complexNumber))
          && !targetNumbers.has(Number(failure.complexNumber))),
        ...failures,
      ];
    } catch {
      // A missing prior report simply makes this run the new baseline.
    }
  }

  const generatedAt = new Date().toISOString();
  await fs.writeFile(path.join(outDir, 'latest.json'), `${JSON.stringify({ generatedAt, rows: outputRows, failures: outputFailures }, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'latest.csv'), toCsv(outputRows));

  // This is a dedicated collector Chrome. Closing the CDP browser after the
  // files are written lets the scheduled PowerShell job continue to publish.
  await browser.close().catch((error) => {
    console.warn(`[WARN] collector Chrome did not close cleanly: ${error.message ?? error}`);
  });

  if (failures.length) {
    await fs.writeFile(path.join(outDir, 'failures.json'), `${JSON.stringify({ generatedAt, failures }, null, 2)}\n`);
    throw new Error(`${failures.length} complex(es) failed; see output/failures.json`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.stack ?? error);
    process.exit(1);
  });

