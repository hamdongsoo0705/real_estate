const PYEONG_PER_SQM = 0.3025;

function first(obj, keys, fallback = null) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replaceAll(',', '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractArticles(payload) {
  const candidates = [
    payload?.articleList,
    payload?.articles,
    payload?.data?.articleList,
    payload?.data?.articles,
    payload?.result?.articleList,
    payload?.result?.articles,
  ];
  return candidates.find(Array.isArray) ?? [];
}

function representative(raw) {
  return raw?.representativeArticleInfo ?? raw?.representativeArticle ?? raw;
}

function supplySqm(raw, rep) {
  return numberValue(first(rep, ['supplySpace', 'supplyArea', 'spc1'],
    first(raw, ['supplySpace', 'supplyArea', 'spc1'])));
}

export function normalizeArticle(raw, complex) {
  const rep = representative(raw);
  const sqm = supplySqm(raw, rep);
  const price = numberValue(first(rep, ['dealPrice', 'dealOrWarrantPrice', 'dealPriceMin', 'price'],
    first(raw, ['dealPrice', 'dealOrWarrantPrice', 'dealPriceMin', 'price'])));
  const articleNumber = String(first(rep, ['articleNumber', 'articleNo'],
    first(raw, ['articleNumber', 'articleNo'], '')));

  return {
    complexName: first(raw, ['complexName'], first(rep, ['complexName'], complex.complexName ?? '')),
    complexNumber: Number(complex.complexNumber),
    supplySpace: sqm,
    supplySpaceName: first(rep, ['supplySpaceName', 'pyeongName', 'areaName'],
      first(raw, ['supplySpaceName', 'pyeongName', 'areaName'], sqm == null ? '' : `${sqm}㎡`)),
    articleNumber,
    dealPrice: price,
    dongName: first(rep, ['dongName', 'buildingName'], first(raw, ['dongName', 'buildingName'], '')),
    floorInfo: first(rep, ['floorInfo', 'floor'], first(raw, ['floorInfo', 'floor'], '')),
    articleConfirmDate: first(rep, ['articleConfirmDate', 'confirmDate'], first(raw, ['articleConfirmDate', 'confirmDate'], '')),
    exposureStartDate: first(rep, ['exposureStartDate'], first(raw, ['exposureStartDate'], '')),
    articleFeatureDescription: first(rep, ['articleFeatureDescription', 'featureDescription'], first(raw, ['articleFeatureDescription', 'featureDescription'], '')),
    realtorCount: numberValue(first(raw, ['realtorCount', 'brokerCount'], first(rep, ['realtorCount', 'brokerCount'], 1))) ?? 1,
    _groupKey: String(first(raw, ['representativeArticleNumber', 'representativeArticleNo', 'groupArticleNumber'], articleNumber)),
  };
}

export function selectListings(payload, complex, { minPyeong = 30, maxPyeong = 39, limit = 3 } = {}) {
  const rows = extractArticles(payload)
    .map((raw) => normalizeArticle(raw, complex))
    .filter((row) => row.supplySpace != null && row.dealPrice != null)
    .filter((row) => {
      const pyeong = row.supplySpace * PYEONG_PER_SQM;
      return pyeong >= minPyeong && pyeong < maxPyeong + 1;
    });

  const unique = new Map();
  for (const row of rows) {
    const key = row._groupKey || row.articleNumber;
    const previous = unique.get(key);
    if (!previous || row.dealPrice < previous.dealPrice) unique.set(key, row);
  }

  const byArea = new Map();
  for (const row of unique.values()) {
    const key = String(row.supplySpace);
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(row);
  }

  return [...byArea.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([, group]) => group
      .sort((a, b) => a.dealPrice - b.dealPrice)
      .slice(0, limit))
    .map(({ _groupKey, ...row }) => row);
}
