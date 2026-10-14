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
skier code and calculated DIN before copying those three fields. Final binding
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

For support ticket 4100890, the two unsigned test buttons use the same fixed
fictional payload; only `kiosk` differs. The API accepts `syntheticKiosk` only as
a boolean on the authenticated `synthetic-preview` stage. Customer stages ignore
it and retain normal kiosk behavior. Both tests keep fresh template metadata and
the exact reviewed technician option contract; neither reads signed records.
The result panel exposes the seven outgoing technical fields' GUID, scope, value,
`fieldType` and `type`, plus the UTC request/response window and 3600-second
expiration. These times bound creation; they are not provider-created timestamps.
An accepted API response does not establish that dropdown selections rendered.

The Tyrolia Equipment Rental Form, page 1, verifies eight BSL columns in mm:
≤230, 231–250, 251–270, 271–290, 291–310, 311–330, 331–350, ≥351.
Source: https://drive.google.com/file/d/1oECQ_T7zsMsa8J_gYRdfKrJx-IB2Ki-W/view
These are inclusive ranges. The calculator display labels reflect all eight
existing indexes; the DIN matrix and arithmetic are unchanged. The serializer
accepts these inclusive labels only through a verified template/version contract
and preserves their exact option strings. A damaged `=351` is not a range.

After the template editor publishes corrected options, independently capture its
actual API `publishedVersion` and all three technician fields' exact option
values before updating `lib/technician-enum-contracts.json`. A public HTML
`wizardversionid` is not proof of the API publication version. Publication1616022
was independently verified by API on2026-10-14. Verify a fictional unsigned draft's
rendered selections before claiming that the live integration is repaired.

Live verification on2026-10-14 found that Smartwaiver rejects the published BSL
value `311–330` (en dash) with HTTP402: its custom-field validator permits a
narrower character set than the editor. A fictional diagnostic using `311-330`
was accepted, but this differs from the live option and is not a production
serialization rule. The same draft was inspected in connected Mac Chrome after
`document.readyState` became `complete`. The fictional name/email and four
distinct final-setting values rendered exactly. All three technician selects
remained at `Please Select...`, index0, value `-9999998723`. Skier Code `M` and
Initial Indicator `7,00` exist as exact option values, so the confirmed selection
failure is broader than the BSL character mismatch. No fields were manually
selected, signed or submitted. Template metadata exposes GUID/type/label only;
the documented prefill schema is GUID-to-string and provides no alternate
optionlist encoding. Obtain a provider-confirmed representation or fix before
changing the dropdown schema or assuming an ASCII-only edit resolves this.
Do not release this contract change as a confirmed prefill fix until the provider
validation and dropdown rendering problems are resolved and verified end to end.

Compare the opened forms without editing, signing, or submitting them. Preserve
the fictional participant, exact option strings and template version. Do not
infer behavior for untested dropdowns or templates. A prefill UUID is also part
of an access URL: never publish it or a live prefill URL in repository logs.
If needed, give only the fictional test's UUID and UTC window privately to the
original Smartwaiver support ticket, preferably after its expiration; never
include API keys, staff tokens, signed-customer identifiers or private URLs.

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
