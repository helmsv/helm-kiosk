// Verify the existing SnowOS staff session server-side. No new credentials,
// privileges, client-supplied destinations, or session persistence are introduced.
const STAFF_ORIGIN = 'https://helm-snowos.vercel.app';
function authError(status, message) { return Object.assign(new Error(message), { status }); }
async function requireStaff(req) {
  const authorization = req?.headers?.authorization;
  if (typeof authorization !== 'string' || authorization.length > 12000 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) {
    throw authError(401, 'Open Rentals from SnowOS and sign in with your staff account.');
  }
  let response;
  try {
    response = await fetch(`${STAFF_ORIGIN}/api/rentals/authorize`, {
      method: 'POST', headers: { Authorization: authorization, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
  } catch { throw authError(503, 'Staff sign-in could not be verified. Please try again.'); }
  if (!response.ok) throw authError(response.status === 401 ? 401 : response.status === 403 ? 403 : 503, response.status === 401 || response.status === 403 ? 'Your SnowOS staff session is unavailable. Sign in again.' : 'Staff sign-in could not be verified. Please try again.');
  let data;
  try { data = await response.json(); } catch { throw authError(503, 'Staff sign-in could not be verified.'); }
  if (data?.authorized !== true) throw authError(403, 'An active SnowOS staff account is required.');
  return true;
}
module.exports = { requireStaff, STAFF_ORIGIN };
