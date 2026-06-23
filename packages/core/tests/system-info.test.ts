import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'os';
import * as fs from 'fs';
import { extractTags, isDockerEnvironment, simplifyDistro, getMockSystem } from '@snowluma/core/system-info';

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

const mockExists = vi.mocked(fs.existsSync);
const mockReadFile = vi.mocked(fs.readFileSync);

afterEach(() => {
  vi.restoreAllMocks();
  mockExists.mockReset();
  mockReadFile.mockReset();
});

describe('isDockerEnvironment', () => {
  it('returns false on non-Linux even if files exist', () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    expect(isDockerEnvironment()).toBe(false);
  });

  it('returns true when /.dockerenv exists', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    mockExists.mockImplementation(p => p === '/.dockerenv');
    expect(isDockerEnvironment()).toBe(true);
  });

  it('returns true when /proc/1/cgroup contains "docker"', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    mockExists.mockImplementation(p => p === '/proc/1/cgroup');
    mockReadFile.mockReturnValue('0::/system.slice/docker-abc123.scope');
    expect(isDockerEnvironment()).toBe(true);
  });

  it('returns false when neither indicator is present', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    mockExists.mockReturnValue(false);
    expect(isDockerEnvironment()).toBe(false);
  });

  it('gracefully handles read errors on /proc/1/cgroup', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    mockExists.mockImplementation(p => p === '/.dockerenv' ? false : true);
    mockReadFile.mockImplementation(() => { throw new Error('EACCES'); });
    expect(isDockerEnvironment()).toBe(false);
  });
});

describe('simplifyDistro with [docker] tag', () => {
  it('preserves [docker] after stripping kernel version', () => {
    expect(simplifyDistro('Debian 13 (kernel 6.12.74) [docker]')).toBe('Debian 13 [docker]');
  });

  it('preserves [docker] after stripping GNU/Linux', () => {
    expect(simplifyDistro('Debian GNU/Linux 13 [docker]')).toBe('Debian 13 [docker]');
  });

  it('preserves [docker] after stripping standalone Linux word', () => {
    expect(simplifyDistro('Alpine Linux 3.21 [docker]')).toBe('Alpine 3.21 [docker]');
  });
});

describe('extractTags', () => {
  it('extracts [docker] tag from distro string', () => {
    const { cleanName, tags } = extractTags('Debian 13 (kernel 6.12.74) [docker]');
    expect(cleanName).toBe('Debian 13 (kernel 6.12.74)');
    expect(tags).toEqual(['docker']);
  });

  it('returns empty tags when no brackets present', () => {
    const { cleanName, tags } = extractTags('Debian GNU/Linux 13');
    expect(cleanName).toBe('Debian GNU/Linux 13');
    expect(tags).toEqual([]);
  });

  it('handles multiple tags', () => {
    const { cleanName, tags } = extractTags('Debian 13 [docker] [wsl]');
    expect(cleanName).toBe('Debian 13');
    expect(tags).toEqual(['docker', 'wsl']);
  });

  it('preserves trailing tag in mock format', () => {
    const { cleanName, tags } = extractTags('Debian 13 x86_64 [docker]');
    expect(cleanName).toBe('Debian 13 x86_64');
    expect(tags).toEqual(['docker']);
  });

  it('handles empty string', () => {
    const { cleanName, tags } = extractTags('');
    expect(cleanName).toBe('');
    expect(tags).toEqual([]);
  });

  it('handles string with only a tag', () => {
    const { cleanName, tags } = extractTags('[docker]');
    expect(cleanName).toBe('');
    expect(tags).toEqual(['docker']);
  });
});

describe('getMockSystem docker probability', () => {
  it('produces some [docker] entries over many invocations', () => {
    let dockerCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (getMockSystem().endsWith(' [docker]')) dockerCount++;
    }
    expect(dockerCount).toBeGreaterThan(50);
    expect(dockerCount).toBeLessThan(200);
  });

  it('never returns a blank mock', () => {
    for (let i = 0; i < 50; i++) {
      expect(getMockSystem().length).toBeGreaterThan(0);
    }
  });
});
