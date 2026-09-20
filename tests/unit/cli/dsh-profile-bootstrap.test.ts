import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBootstrapDshConfig, ensureAcpProfile } from '../../../src/cli/profile-bootstrap.js';

describe('ensureAcpProfile', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-profile-'));
    cleanup.push(dir);
    return dir;
  }

  it('writes the automation-only ACP profile layout', async () => {
    const home = await tempHome();
    await ensureAcpProfile(home, 'dsh-acp');

    const dir = join(home, 'profiles', 'dsh-acp');
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-acp-app',
    ]);
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe('[]\n');
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n');
  });

  it('never overwrites an existing profile', async () => {
    const home = await tempHome();
    await ensureAcpProfile(home, 'dsh-acp');
    const patchPath = join(home, 'profiles', 'dsh-acp', 'cordis.patch.yml');
    await writeFile(patchPath, '# hand-tuned\n', 'utf8');

    await ensureAcpProfile(home, 'dsh-acp');

    expect(await readFile(patchPath, 'utf8')).toBe('# hand-tuned\n');
  });

  it('requires an explicit harness home', async () => {
    const previous = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    try {
      await expect(
        createBootstrapDshConfig({ binaryPath: process.execPath }),
      ).rejects.toThrow(/DSH_HOME/);
    } finally {
      if (previous !== undefined) process.env.DSH_HOME = previous;
    }
  });
});