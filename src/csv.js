const COLUMNS = [
  'complexName', 'complexNumber', 'supplySpace', 'supplySpaceName', 'articleNumber',
  'dealPrice', 'dongName', 'floorInfo', 'articleConfirmDate', 'exposureStartDate',
  'articleFeatureDescription', 'realtorCount',
];

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows) {
  return `\uFEFF${[COLUMNS, ...rows.map((row) => COLUMNS.map((column) => row[column]))]
    .map((line) => line.map(escapeCsv).join(','))
    .join('\r\n')}\r\n`;
}
