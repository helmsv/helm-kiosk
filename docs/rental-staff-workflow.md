# Rental staff workflow

The technician and return pages use the existing SnowOS staff sign-in at
https://helm-snowos.vercel.app/rentals. Direct Kiosk staff-page bookmarks direct
staff to that sign-in. Welcome/intake start remains public.

## Access and privacy

- SnowOS delivers its existing session only to the exact Kiosk iframe origin/source
- Kiosk retains it only in memory with a short lease and clears private rows on expiry/logout
- Every staff API request verifies the current active staff/session through SnowOS
- Authorization is rechecked before creating a final-waiver prefill
- No new credentials, accounts, roles, signature copying or signed-waiver edits
- Existing public Lightspeed welcome lookup behavior is unchanged; this work does not claim to secure that separate flow

## Pending liability and DIN

Rows come from verified signed-intake detail, one row per participant. Age comes
from that participant's DOB. Raw DOBs, addresses, signatures and PDFs are not
returned in list/calculator responses. Partial loading, retries and paging are
shown explicitly. An account-wide Smartwaiver 429 is honored; the warm-process
cache/request budget is not a distributed global quota.

The intake question “Skier Type: (Check One)” accepts one explicit selection.
Missing/conflicting data never defaults to Type II. The existing chart arithmetic
is unchanged. Technicians must review the current participant, measured boot,
skier code and calculated DIN before opening the editable prefilled waiver. Final binding
indicator settings are not inferred or filled from calculated DIN. Staff may
enter all four final toe/heel settings explicitly or leave all four blank. A
partial group blocks opening. Any edit resets review; reviewed numeric strings
(including trailing zeros) are preserved in their separate destination fields.

Both row actions, **Calculate DIN** and **Open Liability**, enter the same
participant review. The latter previously bypassed review and omitted technician
values from its request. Enter the measured BSL and explicitly review the current
calculation before opening. Changing inputs invalidates that review.

Opening status remains visible on the dashboard and review dialog. A blocked
popup sends no request; repeated clicks while preparing send one request. If the
loading tab is closed, the same prepared draft can be reopened from the page
without creating another. Its link exists only in memory and cannot be reused
after a staff-session change or its one-hour lifetime. A timeout does not retry
automatically because the provider may already have created an unsigned draft.

The final Smartwaiver is unsigned and editable, including default names/email.
No polling or subsequent Kiosk render overwrites corrections made in Smartwaiver.
Ambiguous participants, stale measurements, unsupported metadata and shared
multi-person technician fields fail closed with a review message.

## Phone layout

At widths up to 639px, rows become labeled cards, actions wrap and dialogs scroll
within the viewport. Tablet/iPad table layouts, including 744px iPad mini, remain
outside those overrides. Tests cover phone320/375/390/430 and tablet640/744/768/820/1024.

## Verification

Run `npm test`. An optional fully mocked Playwright suite is at
`tests/rental-mobile.browser.cjs`; it makes no production calls. Staff-only setup
checks read only configured template metadata. The unsigned synthetic preview
uses fixed fictional adult data and must never be signed.

### Text-based rental agreement

The configured production destination is **Helm of Sun Valley - Rental Agreement
(Text Based)**, template `rrqn8ray3vbl19h2reyxrf`. Its eight participant text fields
were API-prefilled and verified in connected Chrome; the renamed publication is
1620048. The former test copy is now explicitly approved as the production
agreement. The original `a2njtmnzxs7icea9mdxff6` remains unchanged for rollback.

Skier Code, the single calculated Initial Indicator Value, measured BSL in mm,
and the existing inclusive BSL range each have a separate participant textbox.
The mapper verifies their exact GUIDs, labels, types and participant scope from
fresh template metadata. It never copies stale technician answers from an intake.
The four final toe/heel settings remain independent, copied only when all four
are explicitly entered and reviewed. Blank finals stay blank. No DIN arithmetic
or classification changed. Other choice fields, including Boot Sole Type, still
require manual completion.

All custom text fields are editable; `lockdownPrefill` does not lock them. Staff
must compare calculated references with SnowOS and independently review the four
actual final settings immediately before signing. The visible review reminder
and returned manual/skipped-field details support this check.

Range text uses provider-compatible ASCII: `230 or less`, `231-250`, `251-270`,
`271-290`, `291-310`, `311-330`, `331-350`, `351 or more`. These describe the same
inclusive columns as the existing chart; they do not alter measurements or DIN.
The exact measured BSL is always sent separately. The former three dropdowns are
absent from this published template. Their provider selection issue is not
claimed fixed; legacy-template prefills continue to omit dropdown values.

The authenticated synthetic preview uses fixed fictional adult identity and
M / 7 / 315 / 311-330, plus distinct finals 6.25 / 6.50 / 5.75 / 6.00. It reads no
signed records and reports the eight outgoing field destinations and values,
manual references if any, request/response UTC times and 3600-second expiry.
`syntheticKiosk` remains a boolean comparison option only for this test stage.
Never sign or submit these fixtures. API acceptance alone is not rendering proof.

Signed-agreement reconciliation, latest-liability lookup and webhook ingestion
accept both verified rental templates, so original outstanding rentals and late
original-template events remain visible. New prefill and blank-waiver opening
use only the configured `LIABILITY_WAIVER_ID`. Existing database return records
are not migrated or rewritten. The admin backfill endpoint continues to target
the currently configured template; this release does not invoke it.

Compare the opened forms without editing, signing, or submitting them. Preserve
the fictional participant, exact option strings and template version. Do not
infer behavior for untested dropdowns or templates. A prefill UUID is also part
of an access URL: never publish it or a live prefill URL in repository logs.
If needed, give only the fictional test's UUID and UTC window privately to the
original Smartwaiver support ticket, preferably after its expiration; never
include API keys, staff tokens, signed-customer identifiers or private URLs.

### Rental dates on the final waiver

New unsigned prefills for either verified rental agreement populate **Date Out**
with the current date in `America/Los_Angeles` when the server creates the draft.
**Date Returning** is fixed to **March 16, 2027**. Dates are sent as `YYYY-MM-DD`
in waiver-level custom fields; the form displays its normal readable date format.
Reopening an existing draft preserves its dates; creating a new draft recomputes
Date Out. Neither date is copied from an older intake or taken from the browser.

The mapper verifies the preserved date field GUIDs, labels, types and waiver scope.
If a destination can no longer be verified, it remains unfilled and the staff
response flags that date for manual completion. The four final settings and
calculated text references remain independent. The separate **Open blank liability
waiver** fallback remains fully manual, including dates.

A seasonal return-date admin setting is recorded in [the backlog](backlog.md)
for future work. This change does not add that setting or update signed waivers.

### Returns read performance

`GET /api/rentals-outstanding` verifies the current staff session and performs a
fresh parameterized SELECT with `private, no-store`. Schema readiness uses one
catalog query on cold functions; complete databases skip DDL. Fresh and older
databases retain the existing additive initialization on a single transaction
connection. Concurrent requests in the same function share initialization; only
successful schema readiness is cached, never rental rows or staff permission.
Initialization/database failures return an error, never an empty successful list.

Authorized responses include `Server-Timing` durations for `staff`, `schema`, and
`database` read/connection time. Fixed labels contain no identities, filters,
tokens, or customer content. Failed staff verification exposes no timing header.
Use these phases to measure load latency without weakening authorization.

### Blank liability recovery

If Smartwaiver rejects prefill creation with HTTP400, the error tab offers
**Open blank liability waiver**. The dashboard also has this manual option so
staff can open the final form without reading a signed intake or attempting
prefill. Both paths freshly verify the existing SnowOS staff session and use
only the exact configured, browser-verified final template. Neither calls the
Smartwaiver API, copies customer answers, supplies DIN values, signs a form,
nor passes an intake tag. Staff must complete and verify every field; the
pending intake may remain listed because manual completion has no source link.
Successful prefill keeps its existing linkage and review behavior unchanged.

The preceding protected deployment769b494 already exhibited prefill-create400;
rolling back the synthetic kiosk comparison does not establish a recovery for
that upstream failure. The blank recovery is separate from support4100890's
accepted prefills with unselected technician dropdowns.

### Text-template rollout and rollback

The production Vercel project is `helm-kiosk` (repo root), embedded by SnowOS at
`https://helm-kiosk.vercel.app/tech.html`. Set production `LIABILITY_WAIVER_ID` to
`rrqn8ray3vbl19h2reyxrf` with this mapping release; leave intake configuration
unchanged. Refresh existing SnowOS rental tabs after rollout. Verify configured
metadata and a fresh unsigned synthetic preview through the authenticated iframe.

For rollback, restore production `LIABILITY_WAIVER_ID` to
`a2njtmnzxs7icea9mdxff6` and deploy the prior known-good release. Restoring the
setting is essential for subsequent deployments; reverting only the code would
leave an incompatible destination. A previous deployment carries its original
environment snapshot. Do not change signed documents, delete either template,
or reuse old draft links as proof of the current configuration.
