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
indicator settings are not inferred or filled from calculated DIN.

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
