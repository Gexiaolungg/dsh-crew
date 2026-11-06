// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';
import { pluginEnv } from './plugin-env.mjs';
import { findDesktopHubUrls } from './desktop-hub.mjs';

const ROUTE = '/_dsh/dsh-crew';
const HUB_CACHE_MS = 1000;

export function createHubResolver({ preferredUrl, desktopUrls, request = fetch, now = Date.now }) {
  const preferred = preferredUrl.replace(/\/+$/, '');
  let current = null;
  let checkedAt = -Infinity;
  let pending;

  async function responds(url) {
    if (!url) return false;
    try {
      const res = await request(url + ROUTE + '/ping', {
        signal: AbortSignal.timeout(800),
        redirect: 'error',
      });
      return res.ok && (await res.json()).service === 'dsh-crew-hub';
    } catch {
      return false;
    }
  }

  async function discover() {
    // Keep using a healthy Hub if another local instance comes online.
    if (await responds(current)) return current;
    if (preferred !== current && await responds(preferred)) return preferred;
    for (const candidate of await desktopUrls()) {
      if (candidate !== current && candidate !== preferred && await responds(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  return {
    async resolve() {
      if (pending) return pending;
      if (now() - checkedAt < HUB_CACHE_MS) return current;
      pending = discover().then((url) => {
        current = url;
        checkedAt = now();
        return url;
      }).finally(() => { pending = undefined; });
      return pending;
    },
    invalidate(url) {
      if (current === url) checkedAt = -Infinity;
    },
  };
}

const override = pluginEnv('CREW_HUB');
const resolver = createHubResolver({
  preferredUrl: override ?? readGlobalConfig().hub_url,
  desktopUrls: override === undefined ? findDesktopHubUrls : async () => [],
});
export const resolveHubUrl = resolver.resolve;
export async function hubAvailable() {
  return Boolean(await resolveHubUrl());
}

async function call(path, init) {
  const url = await resolveHubUrl();
  if (!url) throw new Error('DSH workers hub is not reachable');
  let res, body;
  try {
    res = await fetch(url + ROUTE + path, { ...init, redirect: 'error' });
    body = await res.json();
  } catch (err) {
    // Rediscover on a subsequent call. A POST may already have been accepted.
    resolver.invalidate(url);
    throw err;
  }
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `hub request failed (${res.status})`);
  return body;
}

/**
 * One long-poll may never outlive the runtime's request timeouts. Node's
 * fetch (undici) aborts a request whose response headers have not arrived
 * within 300 s, and the hub sends nothing until the job settles — so a
 * `?wait=2700` poll dies at five minutes with a bare "fetch failed" while the
 * job keeps running server-side. Measured on 2026-08-19: dispatches of 2 s and
 * 4 m 03 s returned normally; 14 m, 22 m, 35 m and 41 m all failed that way.
 * Slicing the wait keeps every individual request short enough that no
 * runtime, proxy or load balancer can cut it.
 */
const MAX_POLL_SLICE_SECONDS = 60;

export const hub = {
  probe: (binding) => call('/worker-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(binding) }).then(b => b.result),
  spawn: (spec) => call('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then((b) => b.job),
  list: () => call('/jobs').then((b) => b.jobs),
  // The LLM routes the HOST has configured. Only the hub can answer this: the
  // MCP server is a separate process with no ctx.llm. Returns [] rather than
  // throwing when the hub is too old to serve the route, so a stale hub
  // degrades to "cannot enumerate" instead of breaking the config tool.
  providers: () => call('/providers').then((b) => ({
    providers: b.providers ?? [],
    bindings: b.bindings ?? null,
  })).catch(() => ({ providers: [], bindings: null })),
  // `waitSeconds = 0` keeps the plain "read it now" semantics; anything longer
  // is served by repeated short waits until the job settles or the budget ends.
  get: async (id, waitSeconds = 0) => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const slice = waitSeconds <= 0 ? 0 : Math.max(1, Math.min(MAX_POLL_SLICE_SECONDS, remaining));
      const job = await call(`/jobs/${id}?wait=${slice}`).then((b) => b.job);
      if (job.status !== 'running' || waitSeconds <= 0 || Date.now() >= deadline) return job;
    }
  },
  cancel: (id) => call(`/jobs/${id}/cancel`, { method: 'POST' }).then((b) => b.job),
};
