# Staff-only pending-intake row hydration

Status: integrated through api/open-intakes.js, which requires server-side
`await requireStaff(req)` before configuration, range processing, cache reads, or
Smartwaiver calls. Authentication failures return sanitized 401/403/503 errors
with private/no-store. Never bypass this gate or expose the builder from another
public route. A browser flag, query-string secret, CORS, or an unlinked URL is not
a staff authorization boundary. Deployment and staff authentication verification
remain the integrating task's responsibility.

## Official upstream contract

https://api.smartwaiver.com/api/docs documents:

- GET /v4/waivers returns signed-waiver summaries; it has no full-detail flag
- GET /v4/waivers/{waiverId}?pdf=false returns the signed participant detail
- List limit is 1–300; offset counts pages, not individual records
- The account-wide quota is 100 requests per minute, shared across API keys
- After HTTP 429, stop requests until the Retry-After interval expires

The reader uses only these GET paths. Its injected request function must be a
server-only, fixed-account client using Bearer auth, no-store, bounded timeouts,
and sanitized errors. On a 429, the client must expose the response's Retry-After
as numeric `retryAfterSeconds` (the reader conservatively waits 60 seconds when
missing). Do not reuse a reader after changing its account/client credentials.

## Authenticated response contract

Call `reader.read({ templateId, fromDts, toDts, page: 0 })` only after staff access
is verified. templateId comes from server configuration, not a browser-selected
template. The caller supplies ISO inclusive-start/exclusive-end range boundaries.
HTTP responses use `Cache-Control: private, no-store`, including errors.

`rows` is an array of existing table-row shapes:

- waiver_id and participant_index jointly identify a participant, without p0 fallback
- signed_on, intake_pdf_url (always blank), lightspeed_id
- email (the signed waiver's contact email), first_name, last_name
- age, height_in, weight_lb, skier_type

The shared normalizer is the single source of measurement/age parsing. Rows are
allowed only after signed detail matches BOTH summary waiver ID and configured
template ID. All participants become separate rows; no summary/signer is
fabricated as a participant. Missing participant measurements stay null/blank.
The response and cache omit raw DOB, addresses, guardian records, PDFs, signatures,
and raw answers. Upstream bodies and secrets never appear in errors.

Metadata:

- count: returned participant rows, not signed waiver count
- waiver_count and loaded_waivers: current page's distinct valid waiver counts
- pending_waivers: details not loaded yet; another authorized read can progress them
- failed_waivers: details temporarily unavailable or failing identity/schema validation
- rejected_waivers: list entries rejected for invalid ID or wrong/missing template
- partial: pending/failed/rejected data or possible additional pages
- retry_after_seconds: minimum suggested wait before another attempt
- pagination: page, page_size, has_more, next_page

A full 300-summary page implies more results MAY exist; fetch next_page until an
underfull/empty page. The UI must visibly state partial/loading/errors/pagination,
never equate rows=[] plus partial=true with no pending customers, and never
silently drop earlier loaded pages. Use (waiver_id, participant_index) for merge
keys. Preserve loaded rows on transient retrieval failures and ignore obsolete
responses after date-range changes. Reconciliation with liability data also needs
participant-aware review; a family's shared email/tag must not hide every sibling
based on a single participant's completed liability.

## Bounds and operational limits

Defaults: 6 detail GETs per read, 40 total GETs per rolling minute per reader,
10-second summary TTL, 30-minute normalized-detail TTL, 30-second negative TTL,
8 cached summary pages/ranges, and 600 detail entries. Details expire at UTC
midnight to recompute age without retaining DOBs. Duplicate/concurrent requests
join in-flight reads. HTTP 429 stops further requests until the retry interval.
Errors are retried after expiry; no external datastore or credentials are added.

This is an ephemeral process-local cache and limiter, NOT a distributed quota.
Serverless cold starts, concurrent instances, and the app's other Smartwaiver
routes can exceed the account quota even when this reader stays below 40/minute.
Before deployment, define the number of staff polling clients, coordinate polling
and the other endpoints, and implement an account-wide budget in an already
approved store or choose an explicitly bounded on-demand UI. The old 3-second
poll must not be assumed safe. A cold start may lose hydration progress; no claim
of persistent completeness is made. These limits are a defense, not an account-wide quota guarantee.
The new route never permits unauthenticated participant access.

Synthetic checks:
`node --test tests/pending-intake-reader.test.js tests/open-intakes.test.js tests/smartwaiver-client.test.js`
