import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopLoopbackUrls } from '../src/desktop-hub.mjs';
import { createHubResolver } from '../src/hub-client.mjs';

test('Windows discovery only considers DSH-owned loopback listeners', () => {
  const processes = '"DeepSeek Harness.exe","123","Console","1","1,200 K"\r\n'
    + '"other.exe","456","Console","1","1,000 K"\r\n';
  const sockets = [
    '  TCP    127.0.0.1:33001    0.0.0.0:0         LISTENING      123',
    '  TCP    127.0.0.1:33002    0.0.0.0:0         LISTENING      456',
    '  TCP    127.0.0.1:33003    127.0.0.1:33002   ESTABLISHED    123',
    '  TCP    0.0.0.0:33004      0.0.0.0:0         LISTENING      123',
    '  TCP    [::1]:33005        [::]:0            LISTENING      123',
  ].join('\r\n');
  assert.deepEqual(desktopLoopbackUrls(processes, sockets), [
    'http://127.0.0.1:33001',
    'http://[::1]:33005',
  ]);
});

test('a long-lived client checks the health marker and rediscovers a changed desktop port', async () => {
  const configured = 'http://127.0.0.1:3080';
  const unrelated = 'http://127.0.0.1:49999';
  const firstPort = 'http://127.0.0.1:50000';
  const secondPort = 'http://127.0.0.1:50001';
  let now = 0;
  let activePort = firstPort;
  let scans = 0;
  const resolver = createHubResolver({
    preferredUrl: configured,
    desktopUrls: async () => { scans++; return [unrelated, activePort]; },
    request: async (url, options) => {
      assert.equal(options.redirect, 'error');
      const origin = new URL(url).origin;
      return {
        ok: origin !== configured,
        async json() { return { service: origin === activePort ? 'dsh-crew-hub' : 'unrelated' }; },
      };
    },
    now: () => now,
  });
  assert.deepEqual(await Promise.all([resolver.resolve(), resolver.resolve()]), [firstPort, firstPort]);
  assert.equal(scans, 1);
  now += 2000;
  assert.equal(await resolver.resolve(), firstPort);
  assert.equal(scans, 1);
  activePort = secondPort;
  resolver.invalidate(firstPort);
  assert.equal(await resolver.resolve(), secondPort);
  assert.equal(scans, 2);
});

test('a reachable configured Hub avoids a desktop scan', async () => {
  const configured = 'http://127.0.0.1:3080';
  const resolver = createHubResolver({
    preferredUrl: configured + '/',
    desktopUrls: async () => { assert.fail('configured Hub is healthy'); },
    request: async (url) => {
      assert.equal(url, configured + '/_dsh/dsh-crew/ping');
      return { ok: true, async json() { return { service: 'dsh-crew-hub' }; } };
    },
  });
  assert.equal(await resolver.resolve(), configured);
});
