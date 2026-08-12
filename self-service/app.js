/* ============================================================
   Shared Supabase client + small helpers used by every self-service page.
   Loaded after config.js and the Supabase UMD script, before each page's
   own inline script. Not a module — plain global, same low-tooling style
   as the rest of this repo (no bundler, no build step).
   ============================================================ */

const { SUPABASE_URL, SUPABASE_ANON_KEY, BACKEND_URL } = window.STRIDE_SS_CONFIG || {};

if (!SUPABASE_URL || SUPABASE_URL.includes('xxxxxxxxxxxx')) {
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.className = 'setup-banner';
    banner.textContent =
      "This app isn't configured yet — config.js still has placeholder values. See self-service/README.md.";
    document.body.prepend(banner);
  });
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Registered from here rather than per-page, so every page in the app gets it.
// The path is relative to the page, which keeps the worker's scope to
// /self-service/ — it must not extend over the personal app one level up.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

// Redirects to the sign-in page if there's no session; returns the session otherwise.
async function requireSession() {
  const session = await getSession();
  if (!session) {
    window.location.href = './index.html';
    return null;
  }
  return session;
}

async function signOut() {
  await sb.auth.signOut();
  window.location.href = './index.html';
}

// Calls the self-service backend with the current user's Supabase token attached.
// Throws an Error with .details (an array of plain-English messages) set when
// the backend responds with a validation error list.
async function apiFetch(path, options = {}) {
  const session = await getSession();
  if (!session) throw new Error('Not signed in.');

  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...(options.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // An expired/invalid token isn't something the user can act on from the
    // page they're on — clear it and send them to sign in, rather than showing
    // a raw "session has expired" error next to controls that now do nothing.
    if (res.status === 401) {
      await sb.auth.signOut().catch(() => {});
      const target = new URL('./index.html', window.location.href);
      target.searchParams.set('expired', '1');
      window.location.href = target.toString();
      throw new Error('Your session expired — sending you back to sign in.');
    }
    const err = new Error(body.error || `Request failed (${res.status}).`);
    err.details = body.details;
    throw err;
  }
  return body;
}
