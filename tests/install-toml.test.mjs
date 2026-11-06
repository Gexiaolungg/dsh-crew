// The installers must write valid TOML even when Windows paths need escaping.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

let home;
let install;
before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-crew-toml-'));
  // The installer migrates ~/.config at import time; use the fixture home.
  process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
  install = await import('../src/install/install.mjs');
});

test('a Windows path survives the round trip', () => {
  const path = 'C:\\Users\\kk\\node_modules\\dsh-crew\\server.mjs';
  assert.throws(() => parseToml('args = ["' + path + '"]\n'));
  assert.deepEqual(parseToml('args = [' + install.tomlString(path) + ']\n').args, [path]);
});

test('quotes and control characters survive the round trip', () => {
  for (const path of ["C:\\Users\\O'Brien\\x", '/home/a "b"/x', 'C:\\tab\\there', 'del\x7fchar']) {
    assert.equal(parseToml('v = ' + install.tomlString(path) + '\n').v, path);
  }
});

test('installGrok writes a config.toml that parses', () => {
  const result = install.installGrok({ home });
  assert.ok(result.ok);
  const config = parseToml(readFileSync(join(home, '.grok', 'config.toml'), 'utf8'));
  const server = config.mcp_servers['dsh-crew'];
  assert.equal(server.command, 'node');
  assert.match(server.args[0], /server\.mjs$/);
});

test('Codex install and uninstall manage the parent MCP and preserve unrelated config', () => {
  const codex = join(home, '.codex');
  const configPath = join(codex, 'config.toml');
  const existing = '# My settings\r\nmodel = "my-model"\r\n\r\n[mcp_servers.existing]\r\ncommand = "other"\r\n';
  mkdirSync(codex);
  writeFileSync(configPath, existing);

  install.installCodex({ home });
  const installed = readFileSync(configPath, 'utf8');
  assert.ok(installed.startsWith(existing));
  const server = parseToml(installed).mcp_servers['dsh-crew'];
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /server\.mjs$/);
  assert.equal(server.default_tools_approval_mode, 'approve');
  for (const name of ['ds-flash', 'ds-pro']) {
    const role = parseToml(readFileSync(join(codex, 'agents', name + '.toml'), 'utf8'));
    assert.equal(role.name, name);
    assert.equal(role.model, undefined);
    assert.equal(role.mcp_servers, undefined);
  }
  assert.equal(install.installStatus({ home }).codex.installed, true);

  const filesBeforeReinstall = readdirSync(codex);
  install.installCodex({ home });
  assert.equal(readFileSync(configPath, 'utf8'), installed);
  assert.deepEqual(readdirSync(codex), filesBeforeReinstall);

  install.uninstallCodex({ home });
  assert.equal(readFileSync(configPath, 'utf8'), existing);
  assert.equal(install.installStatus({ home }).codex.installed, false);
});

test('Codex install and uninstall preserve a user-owned server entry', () => {
  const configPath = join(home, '.codex', 'config.toml');
  const custom = [
    '[mcp_servers."dsh-crew"]',
    'command = "custom-launcher"',
    '[mcp_servers."dsh-crew".env]',
    'DSHPLUGIN_CREW_HUB = "http://127.0.0.1:3120"',
    '',
  ].join('\n');
  writeFileSync(configPath, custom);
  assert.match(install.installCodex({ home }).actions.join('\n'), /user-managed/);
  install.uninstallCodex({ home });
  assert.equal(readFileSync(configPath, 'utf8'), custom);
});

test('Codex installer leaves invalid configuration untouched', () => {
  const configPath = join(home, '.codex', 'config.toml');
  const invalid = '[mcp_servers.existing\n';
  writeFileSync(configPath, invalid);
  assert.throws(() => install.installCodex({ home }));
  assert.equal(readFileSync(configPath, 'utf8'), invalid);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
