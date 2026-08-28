/**
 * Apex Arena — Supabase Client
 * ---------------------------------
 * Single source of truth for Supabase connection details and the
 * common read/write operations other modules need. Anything that
 * talks to Supabase should import from here rather than redeclaring
 * SUPABASE_URL / SUPABASE_ANON_KEY locally — one place to update if
 * the project URL or key ever changes.
 *
 * Note: SUPABASE_ANON_KEY is the public/publishable key. It's safe
 * to ship in client code by design — actual access control lives in
 * your Postgres RLS policies, not in keeping this key secret.
 */

const SUPABASE_URL = 'https://qkjknokmlsflfndmduez.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFramtub2ttbHNmbGZuZG1kdWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MDY0MTMsImV4cCI6MjEwMjM4MjQxM30.p3qNlqy7Ht4yWTg0y6XJDfLOoq5Vvqo1qZTt8Ovi-v0';

function headers(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

/**
 * SELECT rows from a table via PostgREST.
 *
 *   await supabaseSelect('general-data', 'select=value&name=eq.game_version&limit=1')
 *
 * `queryString` is whatever you'd normally put after the `?` in a
 * PostgREST URL (select=, filters, limit, order, etc).
 */
export async function supabaseSelect(table, queryString = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${queryString ? `?${queryString}` : ''}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Supabase SELECT on "${table}" failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * INSERT a single row into a table via PostgREST.
 *
 *   await supabaseInsert('logs', { data: { event: 'foo', ... } })
 *
 * Uses Prefer: return=minimal — we don't need the inserted row back,
 * just confirmation it succeeded (throws otherwise).
 */
export async function supabaseInsert(table, row) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Supabase INSERT into "${table}" failed (HTTP ${res.status})`);
  }
}

/** Exposed for modules that need to build a custom fetch call not covered above. */
export { SUPABASE_URL, headers as supabaseHeaders };