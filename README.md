# Rochester water bill watcher

Looks up the **actual** water bill the City of Rochester, NY publishes for a city
address, and emails you a notification whenever it changes.

The message is multipart/alternative: a plain-text part, plus an HTML part that
wraps the same text in `<pre>` so the figures stay in a monospace column. A
`text/plain` message is rendered in whatever font the client picks, usually
proportional, which pulls the numbers out of alignment.

ES6 modules, promises throughout, no `async`/`await`, no dependencies.

## One-off lookup

```bash
node water-bill.js "10 Felix St"       # add --json for the raw record
```

```
City of Rochester water bill -- 10 Felix St, Rochester NY 14608
================================================
  Parcel 10550000020030010000  (SBL 1055020301)
  Water account 7640000605
------------------------------------------------
  Amount due                           $3,781.30
  Penalties                              $113.44
------------------------------------------------
  OUTSTANDING BALANCE                  $3,894.74
```

## Automatic quarterly email

```bash
node bill-watch.js --dry-run     # prints the message, sends nothing
node bill-watch.js               # emails only if the bill changed
```

It checks **daily** and mails only on a change. That is deliberate, and it is
why this is not a quarterly cron job:

- A quarterly schedule has no margin. Miss the window — asleep, powered off,
  a failed run — and the next attempt is three months away.
- It assumes a cadence instead of observing one. This account's known dates were
  six months apart, so quarterly may not even be right for it. Daily polling
  finds out.
- The source refreshes nightly, so a new bill is caught within a day of landing.
- Runs are idempotent. An unchanged bill is a no-op, so a missed or repeated run
  costs nothing.

State lives in `~/Library/Application Support/rochester-water-bill/state.json`.
Delete it to force the next run to treat the current bill as new.

### Install the daily job

```bash
# 1. store the Gmail app password in the login keychain, not in a file
security add-generic-password -s rochester-water-bill \
  -a you@gmail.com -w '<16-char app password>'

# 2. install the LaunchAgent
SMTP_USER=you@gmail.com WATER_BILL_ADDRESS='10 Felix St' ./launchd/install.sh
```

`launchd` rather than `cron`: a LaunchAgent with `StartCalendarInterval` runs a
missed job when the Mac next wakes, and it avoids the Full Disk Access grant
that `cron` quietly needs on modern macOS. The job still only fires while the
Mac is on, so a long trip delays the notice.

```bash
launchctl kickstart -p gui/$UID/com.lincware.rochester-water-bill   # run now
tail -f ~/Library/Logs/com.lincware.rochester-water-bill.log        # watch it
launchctl bootout gui/$UID/com.lincware.rochester-water-bill        # uninstall
```

The Gmail app password needs 2FA on the account. Only `SMTP_USER` and `MAIL_TO`
go in the plist; the password is read from the keychain at run time.

### Configuration

| Variable | Default |
| --- | --- |
| `SMTP_USER` | required — your Gmail address |
| `SMTP_PASS` | unset — falls back to the keychain |
| `MAIL_TO` | defaults to `SMTP_USER`, i.e. yourself |
| `WATER_BILL_ADDRESS` | required — the city address to watch |
| `WATER_BILL_STATE` | `~/Library/Application Support/rochester-water-bill/state.json` |

## Where the data comes from

The public services behind the City's
[Property Information map](https://www.cityofrochester.gov/property-information):

1. **Address → parcel.** `App_PropertyInformation/Address_Parcels_Lookup` on
   `maps.cityofrochester.gov` turns a street address into its 20-digit parcel id
   (SBL20). Street suffixes are normalized, so "Highland Parkway" and
   "Highland Pkwy" both resolve.
2. **Parcel → bill.** Table 6, `ParcelWaterBill`, of
   `App_PropertyInformation/ROC_Parcel_Query_RPS` on `gis.cityofrochester.gov`
   holds the billed amount, due date, adjustments, penalties, balance and last
   payment, keyed by SBL20.

Two quirks of the source: money arrives as strings (blank means zero) and dates
arrive as `YYMMDD`, so `261002` becomes `2026-10-02`.

## Two things this is not

**Not the City's invoice.** No official PDF exists to fetch — the eCitizen
portal is payment-only, with no e-billing, no bill history and no downloads. The
email carries the published figures; pay from the mailed bill.

**Sewer is not on this bill.** Monroe County Pure Waters charges a capital fee
and a metered O&M fee on the county property tax bill instead.

## Files

- `water-bill.js` — address parsing, both lookups, rendering, CLI.
- `bill-watch.js` — daily change detection, notification, state.
- `lib/smtp.js` — SMTP over implicit TLS, `AUTH PLAIN`, multipart/alternative.
- `launchd/install.sh` — generates and bootstraps the LaunchAgent.
