#!/usr/bin/env node
/**
 * Daily watcher: look up the published water bill, and if it has changed since
 * the last run, email a plain-text notification.
 *
 * Polling daily rather than quarterly is deliberate. A quarterly schedule has
 * no margin -- one missed window and you wait three months -- and it assumes a
 * billing cadence rather than observing one. The source refreshes nightly, so a
 * daily check notices a new bill within a day of it landing, and a run that is
 * skipped or fails costs nothing because the next one sees the same change.
 *
 * ES6 modules, promises only, no dependencies.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { getWaterBill } from './water-bill.js';
import { sendMail } from './lib/smtp.js';

const DEFAULT_STATE = join(
  homedir(), 'Library', 'Application Support', 'rochester-water-bill', 'state.json');

const KEYCHAIN_SERVICE = 'rochester-water-bill';

const log = message =>
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);

// ------------------------------------------------------------------- config

/** Read the app password out of the login keychain. */
const keychainPassword = account => new Promise((resolve, reject) => {
  execFile('/usr/bin/security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    (error, stdout) => {
      if (error) {
        reject(new Error(
          `No keychain item for "${KEYCHAIN_SERVICE}" / "${account}". Add one with:\n` +
          `  security add-generic-password -s ${KEYCHAIN_SERVICE} ` +
          `-a ${account} -w '<gmail app password>'`));
        return;
      }
      resolve(stdout.trim());
    });
});

const resolveConfig = () => {
  const env = process.env;
  const user = env.SMTP_USER;
  if (!user) {
    return Promise.reject(new Error('SMTP_USER is not set (your Gmail address).'));
  }
  if (!env.WATER_BILL_ADDRESS) {
    return Promise.reject(new Error('WATER_BILL_ADDRESS is not set.'));
  }
  const config = {
    address: env.WATER_BILL_ADDRESS,
    to: env.MAIL_TO || user,
    statePath: env.WATER_BILL_STATE || DEFAULT_STATE,
    alertAfter: Math.max(1, Number(env.ALERT_AFTER_FAILURES || 3)),
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 465),
    user
  };
  return (env.SMTP_PASS
    ? Promise.resolve(env.SMTP_PASS)
    : keychainPassword(user)).then(pass => ({ ...config, pass }));
};

// -------------------------------------------------------------------- state

/** What counts as "the same bill". A new bill changes at least one of these. */
const signature = bill =>
  [bill.lastBill, bill.dueDate, bill.balance, bill.lastPayment, bill.lastPaymentDate]
    .join('|');

const readState = path => readFile(path, 'utf8')
  .then(JSON.parse)
  .catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

/**
 * Merge a patch into the stored state, leaving untouched fields alone. A key
 * set to null is removed, which is how an outage gets cleared on recovery.
 */
const saveState = (path, previous, patch) => {
  const next = { ...(previous || {}), ...patch };
  Object.keys(next).forEach(key => {
    if (next[key] === null) delete next[key];
  });
  return mkdir(dirname(path), { recursive: true })
    .then(() => writeFile(path, `${JSON.stringify(next, null, 2)}\n`));
};

// --------------------------------------------------------------- the notice

/** Label left, value right, so the decimal points line up in a fixed column. */
const row = (label, value) => `  ${label.padEnd(14)}${String(value).padStart(16)}`;

/** "2026-09-21T09:15:00.000Z" -> "2026-09-21 09:15 UTC" */
const shortTime = iso => `${String(iso).slice(0, 10)} ${String(iso).slice(11, 16)} UTC`;

const summarize = (bill, previous, fetchedAt) => {
  const money = value =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const lines = [
    `Water bill for ${bill.address}, Rochester NY ${bill.zip}`,
    '',
    row('Amount due', money(bill.lastBill)),
    row('Balance', money(bill.balance))
  ];
  if (bill.penalties !== 0) lines.push(row('Penalties', money(bill.penalties)));
  if (bill.adjustments !== 0) lines.push(row('Adjustments', money(bill.adjustments)));
  lines.push(
    row('Due date', bill.dueDate || 'not published'),
    '',
    row('Last payment', money(bill.lastPayment)),
    row('Paid on', bill.lastPaymentDate || 'unknown'));

  if (previous && previous.bill) {
    lines.push('', `Previously, seen ${shortTime(previous.seenAt)}:`, '',
      row('Amount due', money(previous.bill.lastBill)),
      row('Due date', previous.bill.dueDate || 'not published'));
  } else {
    lines.push('', 'This is the first reading, so there is nothing to compare it to.');
  }

  lines.push('',
    `Service line: ${bill.serviceLine.outside} outside the house, ` +
    `${bill.serviceLine.inside} inside.`,
    `Parcel ${bill.parcelId} | SBL ${bill.sbl} | water account ${bill.waterAccount}`,
    '',
    '--',
    'Amount due is the PAY THIS AMOUNT figure from the bill, so it can include',
    'a balance carried forward from earlier quarters plus a late penalty. The',
    'published data does not break that split out; only the mailed bill does.',
    '',
    'Read from the City of Rochester public property information services',
    '(Address_Parcels_Lookup and ParcelWaterBill), which refresh nightly. These',
    'are the published figures, not the City\'s invoice -- there is no official',
    'PDF to download. Pay from the mailed bill or at',
    'https://www.cityofrochester.gov/pay . Sanitary sewer is billed separately',
    'by Monroe County Pure Waters on the county property tax bill.',
    '',
    `Retrieved ${fetchedAt}`);
  return lines.join('\n');
};

const escapeHtml = text => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * The HTML alternative exists only so the columns line up: a text/plain part is
 * rendered in whatever font the client prefers, usually proportional, which
 * pulls the numbers out of alignment. It is derived from the same string as the
 * plain part, so the two can never drift. <pre> is monospace by default, so
 * this still reads correctly in a client that strips the inline style.
 */
const toHtml = text =>
  '<!doctype html><html><body style="margin:0;padding:16px">' +
  '<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
  'font-size:13px;line-height:1.45;white-space:pre-wrap;margin:0">' +
  escapeHtml(text) +
  '</pre></body></html>';

// ----------------------------------------------------------------- the job

/** Send one message, or print it under --dry-run. Resolves true if it went. */
const deliver = (config, options, subject, body, label) => {
  if (options.dryRun) {
    log(`dry run: the ${label} below would have been sent`);
    process.stdout.write(`\n${body}\n`);
    return Promise.resolve(false);
  }
  return sendMail({
    host: config.host,
    port: config.port,
    user: config.user,
    pass: config.pass,
    from: config.user,
    to: config.to,
    subject,
    text: body,
    html: toHtml(body)
  }).then(reply => {
    log(`${label} sent to ${config.to}: ${reply.replace(/\s+/g, ' ')}`);
    return true;
  });
};

const lastKnown = previous => {
  if (!previous || !previous.bill) return ['No previous reading is on record.'];
  const money = value =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return [
    `Last good reading, from ${shortTime(previous.seenAt)}:`,
    '',
    row('Amount due', money(previous.bill.lastBill)),
    row('Due date', previous.bill.dueDate || 'not published')
  ];
};

const failureNotice = (config, previous, outage) => [
  `The water bill lookup for ${config.address} is failing.`,
  '',
  row('Failures', `${outage.count} in a row`),
  row('Since', shortTime(outage.since)),
  '',
  'Last error:',
  `  ${outage.message}`,
  '',
  ...lastKnown(previous),
  '',
  'Likely causes: the City ArcGIS services are down or have changed shape, the',
  'address no longer resolves, or this machine had no network access.',
  '',
  'This is the only alert you will get for this outage. The next message will',
  'be a recovery notice once the lookup succeeds again.',
  '',
  'To check by hand:',
  `  node water-bill.js "${config.address}"`,
  '  tail ~/Library/Logs/com.lincware.rochester-water-bill.log'
].join('\n');

const recoveryNotice = (config, outage, bill) => {
  const money = value =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return [
    `The water bill lookup for ${config.address} is working again.`,
    '',
    row('Failures', `${outage.count} in a row`),
    row('Outage began', shortTime(outage.since)),
    '',
    'Current reading:',
    '',
    row('Amount due', money(bill.lastBill)),
    row('Due date', bill.dueDate || 'not published')
  ].join('\n');
};

/**
 * A lookup failure. Alerting is deliberately once per outage rather than once
 * per run: the check is daily, so a multi-day outage would otherwise mail every
 * morning. A single failure is not worth an email either, since a transient
 * network blip is self-healing, so the alert waits for ALERT_AFTER_FAILURES
 * consecutive failures.
 */
const onFailure = (config, options, previous, error) => {
  const prior = (previous && previous.failures) || null;
  const outage = {
    count: (prior ? prior.count : 0) + 1,
    since: prior ? prior.since : new Date().toISOString(),
    message: error.message
  };

  log(`lookup FAILED (${outage.count} in a row since ${shortTime(outage.since)}): ` +
      error.message);

  const record = alertedAt => (options.dryRun
    ? Promise.resolve(log('dry run: state not written'))
    : saveState(config.statePath, previous, {
        failures: { ...outage, alertedAt: alertedAt || null }
      })
  ).then(() => {
    process.exitCode = 1;
  });

  if (prior && prior.alertedAt) {
    log('already alerted for this outage; staying quiet until it recovers');
    return record(prior.alertedAt);
  }
  if (outage.count < config.alertAfter) {
    log(`below the alert threshold of ${config.alertAfter}; not mailing yet`);
    return record(null);
  }

  return deliver(config, options,
    `Water bill watcher FAILING -- cannot read ${config.address}`,
    failureNotice(config, previous, outage), 'failure alert')
    .then(sent => record(sent ? new Date().toISOString() : null))
    .catch(mailError => {
      // Leave alertedAt unset so the next run tries to alert again.
      log(`could not send the failure alert: ${mailError.message}`);
      return record(null);
    });
};

/** A successful lookup: clear any outage, then do the usual change check. */
const onSuccess = (config, options, previous, bill) => {
  const outage = (previous && previous.failures) || null;

  const announce = outage && outage.alertedAt
    ? deliver(config, options,
        `Water bill watcher recovered -- ${config.address}`,
        recoveryNotice(config, outage, bill), 'recovery notice')
        .catch(error => log(`could not send the recovery notice: ${error.message}`))
    : Promise.resolve();

  return announce
    .then(() => {
      if (!outage) return null;
      if (options.dryRun) return log('dry run: outage not cleared');
      return saveState(config.statePath, previous, { failures: null })
        .then(() => log('outage cleared'));
    })
    .then(() => {
      const current = signature(bill);
      const unchanged = previous !== null && previous.signature === current;

      if (unchanged && !options.force) {
        log(`no change since ${previous.seenAt} (balance ${bill.balance}); ` +
            'nothing to send');
        return null;
      }

      log(unchanged
        ? 'unchanged, but --force was given'
        : `change detected: ${previous ? previous.signature : '(first run)'} ` +
          `-> ${current}`);

      const body = summarize(bill, previous, new Date().toISOString());

      return deliver(config, options,
        `Water bill ${bill.address} -- ` +
        `$${bill.balance.toFixed(2)} due ${bill.dueDate || 'TBD'}`,
        body, 'notification')
        .then(sent => (sent
          ? saveState(config.statePath, previous, {
              signature: current,
              bill,
              seenAt: new Date().toISOString(),
              failures: null
            }).then(() => log('state updated'))
          : null));
    });
};

const run = options => resolveConfig().then(config =>
  readState(config.statePath).then(previous => {
    log(`checking ${config.address}`);
    return getWaterBill(config.address).then(
      bill => onSuccess(config, options, previous, bill),
      error => onFailure(config, options, previous, error));
  }));

const USAGE = `
Usage: node bill-watch.js [--force] [--dry-run]

  Checks the published water bill and emails a notification when it changes.
  Meant to be run daily by launchd; safe to run by hand any time.

  --force     send even if the bill has not changed
  --dry-run   print the message instead of sending it
  --help      show this message

Configuration (environment):
  SMTP_USER             your Gmail address (required)
  SMTP_PASS             app password; if unset, read from the login keychain
                        under service "${KEYCHAIN_SERVICE}"
  MAIL_TO               recipient (defaults to SMTP_USER, i.e. yourself)
  WATER_BILL_ADDRESS    city address to watch, e.g. "10 Felix St" (required)
  WATER_BILL_STATE      state file (default ${DEFAULT_STATE})
  ALERT_AFTER_FAILURES  consecutive lookup failures before mailing an alert
                        (default 3; one alert per outage, then a recovery
                        notice when it works again)
`;

const main = () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return Promise.resolve();
  }
  const unknown = argv.find(arg =>
    !['--force', '--dry-run'].includes(arg));
  if (unknown) {
    process.stderr.write(`Unknown option ${unknown}.\n${USAGE}`);
    process.exitCode = 2;
    return Promise.resolve();
  }

  return run({ force: argv.includes('--force'), dryRun: argv.includes('--dry-run') })
    .catch(error => {
      process.stderr.write(`[${new Date().toISOString()}] error: ${error.message}\n`);
      process.exitCode = 1;
    });
};

export { signature, summarize, failureNotice, recoveryNotice, run };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
