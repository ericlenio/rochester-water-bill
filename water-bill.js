#!/usr/bin/env node
/**
 * Look up the actual latest City of Rochester, NY water bill for an address.
 *
 * Nothing here is computed from the rate schedule. Both figures come straight
 * from the City's public property-information services, which are the same
 * services behind the Property Information map at
 * https://www.cityofrochester.gov/property-information :
 *
 *   1. Address_Parcels_Lookup resolves a street address to its 20-digit
 *      parcel id (SBL20).
 *   2. ROC_Parcel_Query_RPS table 6, ParcelWaterBill, holds the billed
 *      amount, due date, balance, penalties and last payment for that parcel.
 *
 * The City notes this data refreshes nightly, so it reflects the previous day.
 *
 * ES6 module style, promises only -- no async/await, no dependencies.
 */

const ADDRESS_LOOKUP =
  'https://maps.cityofrochester.gov/server/rest/services' +
  '/App_PropertyInformation/Address_Parcels_Lookup/MapServer/0/query';

const WATER_BILL_TABLE =
  'https://gis.cityofrochester.gov/arcgis/rest/services' +
  '/App_PropertyInformation/ROC_Parcel_Query_RPS/MapServer/6/query';

const PARCEL_FIELDS = [
  'SITEADDRESS', 'PARCELID', 'PRINTKEY', 'CLASSDSCRP', 'NORESUNITS', 'ZIP5'
].join(',');

const STREET_SUFFIXES = new Map([
  ['parkway', 'pkwy'], ['street', 'st'], ['avenue', 'ave'], ['boulevard', 'blvd'],
  ['drive', 'dr'], ['road', 'rd'], ['place', 'pl'], ['terrace', 'ter'],
  ['circle', 'cir'], ['court', 'ct'], ['lane', 'ln'], ['square', 'sq'],
  ['crescent', 'cres'], ['highway', 'hwy'], ['expressway', 'expy'], ['trail', 'trl']
]);

const FETCH_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- utilities

const money = value =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const sqlQuote = value => `'${String(value).replace(/'/g, "''")}'`;

/** The service stores money as strings; blank and null both mean zero. */
const toAmount = value => {
  if (value === null || value === undefined || String(value).trim() === '') return 0;
  const parsed = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Dates arrive as YYMMDD strings, e.g. "261002" -> "2026-10-02". */
const toIsoDate = value => {
  const digits = String(value || '').trim();
  if (!/^\d{6}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 2));
  const century = year >= 70 ? 1900 : 2000;
  return `${century + year}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
};

// ------------------------------------------------------------ address parse

/** Split "10 Felix Street" into { streetNumber, streetName }. */
const parseAddress = address => {
  const cleaned = String(address)
    .replace(/,.*$/, '')            // drop ", Rochester, NY 14608"
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(cleaned);
  if (!match) {
    throw new Error(`Could not read a street number out of "${address}".`);
  }
  const words = match[2].split(' ').map(word => {
    const key = word.toLowerCase().replace(/\.$/, '');
    return STREET_SUFFIXES.get(key) || word;
  });
  return { streetNumber: match[1], streetName: words.join(' ') };
};

// ------------------------------------------------------------- ArcGIS glue

const fetchJson = url =>
  fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .then(response => {
      if (!response.ok) {
        throw new Error(`${url.hostname} returned HTTP ${response.status}.`);
      }
      return response.json();
    })
    .then(body => {
      if (body && body.error) {
        throw new Error(`${url.hostname}: ${body.error.message}`);
      }
      return body;
    });

const queryTable = (service, where, outFields) => {
  const url = new URL(service);
  url.searchParams.set('where', where);
  url.searchParams.set('outFields', outFields);
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');
  return fetchJson(url).then(body =>
    (body.features || []).map(feature => feature.attributes));
};

// ------------------------------------------------------------------ lookups

/** Resolve an address to its parcel record. */
const lookupParcel = address => {
  const { streetNumber, streetName } = parseAddress(address);
  const exact =
    `STREET_NUM = ${sqlQuote(streetNumber)} AND ` +
    `UPPER(STREET_NAME) LIKE ${sqlQuote(streetName.toUpperCase() + '%')}`;
  const loose =
    `STREET_NUM = ${sqlQuote(streetNumber)} AND ` +
    `UPPER(STREET_NAME) LIKE ${sqlQuote(streetName.split(' ')[0].toUpperCase() + '%')}`;

  return queryTable(ADDRESS_LOOKUP, exact, PARCEL_FIELDS)
    .then(rows => (rows.length > 0 ? rows : queryTable(ADDRESS_LOOKUP, loose, PARCEL_FIELDS)))
    .then(rows => {
      if (rows.length === 0) {
        throw new Error(
          `No City of Rochester parcel matches "${address}". ` +
          'The property information service only covers addresses inside city limits.');
      }
      if (rows.length > 1) {
        throw new Error(
          `"${address}" is ambiguous; candidates: ` +
          `${rows.map(row => row.SITEADDRESS).join(', ')}`);
      }
      return rows[0];
    });
};

/** Pull the water billing record the City publishes for that parcel. */
const lookupWaterBill = parcel =>
  queryTable(WATER_BILL_TABLE, `SBL20 = ${sqlQuote(parcel.PARCELID)}`, '*')
    .then(rows => {
      if (rows.length === 0) {
        throw new Error(
          `No water billing record is published for parcel ${parcel.PARCELID}.`);
      }
      return rows[0];
    });

/** Normalize the raw service record into a bill. */
const toBill = (parcel, record) => ({
  address: parcel.SITEADDRESS,
  zip: parcel.ZIP5,
  propertyClass: parcel.CLASSDSCRP,
  parcelId: parcel.PARCELID,
  sbl: record.SBL10,
  waterAccount: record.WSEID,
  lastBill: toAmount(record.LastBill),
  dueDate: toIsoDate(record.DueDate),
  adjustments: toAmount(record.Adjustments),
  penalties: toAmount(record.Penalties),
  balance: toAmount(record.Balance),
  lastPayment: toAmount(record.LastPayment),
  lastPaymentDate: toIsoDate(record.LastPayDate),
  serviceLine: {
    outside: record.OutsideConnection,
    inside: record.InsideConnection
  }
});

/** The whole job, as one promise. */
const getWaterBill = address => lookupParcel(address)
  .then(parcel => lookupWaterBill(parcel).then(record => toBill(parcel, record)));

// ---------------------------------------------------------------- rendering

const render = bill => {
  const width = 46;
  const row = (label, amount) => {
    const value = money(amount);
    const gap = Math.max(1, width - label.length - value.length);
    return `  ${label}${' '.repeat(gap)}${value}`;
  };

  const out = [''];
  out.push(`City of Rochester water bill -- ${bill.address}, Rochester NY ${bill.zip}`);
  out.push('='.repeat(width + 2));
  out.push(`  Parcel ${bill.parcelId}  (SBL ${bill.sbl})`);
  out.push(`  Water account ${bill.waterAccount}`);
  out.push('-'.repeat(width + 2));
  out.push(row('Amount due', bill.lastBill));
  if (bill.adjustments !== 0) out.push(row('Adjustments', bill.adjustments));
  if (bill.penalties !== 0) out.push(row('Penalties', bill.penalties));
  out.push('-'.repeat(width + 2));
  out.push(row('OUTSTANDING BALANCE', bill.balance));
  if (bill.dueDate) out.push(`  due ${bill.dueDate}`);
  out.push('');
  out.push(row('Last payment', bill.lastPayment));
  if (bill.lastPaymentDate) out.push(`  received ${bill.lastPaymentDate}`);
  out.push('');
  out.push(`  Service line: ${bill.serviceLine.outside} outside the house, ` +
           `${bill.serviceLine.inside} inside.`);
  out.push('');
  out.push('  Amount due is the PAY THIS AMOUNT figure from the bill and can');
  out.push('  include a balance carried forward plus a late penalty; the');
  out.push('  published data does not break that split out.');
  out.push('');
  out.push('  Source: City of Rochester property information services');
  out.push('  (Address_Parcels_Lookup + ParcelWaterBill). Refreshed nightly,');
  out.push('  so this reflects the City\'s data as of the previous day.');
  out.push('  Sanitary sewer is billed separately by Monroe County Pure Waters');
  out.push('  on the county property tax bill.');
  out.push('');
  return out.join('\n');
};

// ---------------------------------------------------------------- CLI glue

const USAGE = `
Usage: node water-bill.js <address> [--json]

  Looks up the latest water bill the City of Rochester publishes for a city
  address, e.g. "10 Felix St".

  --json   emit the bill as JSON
  --help   show this message
`;

const parseArgs = argv => {
  const options = { json: false };
  const positional = [];

  argv.forEach(arg => {
    switch (arg) {
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
        positional.push(arg);
    }
  });

  if (positional.length === 0) throw new Error('An address is required.');
  options.address = positional.join(' ');
  return options;
};

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return Promise.resolve();
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return Promise.resolve();
  }

  return getWaterBill(options.address)
    .then(bill => {
      process.stdout.write(options.json
        ? `${JSON.stringify(bill, null, 2)}\n`
        : render(bill));
    })
    .catch(error => {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 1;
    });
};

export { parseAddress, lookupParcel, lookupWaterBill, getWaterBill, toBill };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
