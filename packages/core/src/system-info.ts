import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';

/**
 * Strip kernel version and GNU/Linux suffix from a distro string.
 * "Debian GNU/Linux 13 (kernel 6.12.74)" → "Debian 13"
 * "Ubuntu 22.04 (kernel 6.8.12)"         → "Ubuntu 22.04"
 */
export function simplifyDistro(distro: string): string {
  return distro
    .replace(/\s*\(kernel [^)]+\)/gi, '')
    .replace(/\s*GNU\/Linux\s*/i, ' ')
    .replace(/\s*Linux\s*/i, ' ')
    .trim();
}

export interface SystemInfo {
  platform: string;
  arch: string;
  archLabel: string;
  release: string;
  distro: string;
}

function detectDistro(): string {
  const parseKernel = (v: string): string | null => { const m = v.match(/(\d+\.\d+\.\d+)/); return m?.[1] ?? null; };

  if (os.platform() === 'linux') {
    const kernelRelease = os.release();
    const kernelVer = parseKernel(kernelRelease);

    const isRhelFamily = (name: string): boolean =>
      /^(red hat|centos|rocky|alma|oracle|scientific|anolis|tencentos|bclinux|opencloudos)/.test(name);

    const kernelDistroVer = (distro: string | null): string | null => {
      if (!distro) return null;
      const lr = kernelRelease.toLowerCase();
      const ld = distro.toLowerCase();
      if (ld === 'debian') { const m = lr.match(/deb(\d+)/); if (m) return m[1]; }
      if (isRhelFamily(ld)) { const m = lr.match(/el(\d+)/); if (m) return m[1]; }
      if (ld === 'fedora') { const m = lr.match(/fc(\d+)/); if (m) return m[1]; }
      if (ld === 'amazon' || ld.includes('amazon')) { const m = lr.match(/amzn(\d+)/); if (m) return m[1]; }
      if (ld === 'mageia') { const m = lr.match(/mga(\d+)/); if (m) return m[1]; }
      if (ld === 'armbian') { const m = lr.match(/armbian(\d+)/); if (m) return m[1]; }
      if (ld === 'dietpi') { const m = lr.match(/dietpi(\d+)/); if (m) return m[1]; }
      if (ld.includes('libreelec')) { const m = lr.match(/libreelec(\d+)/); if (m) return m[1]; }
      if (ld.includes('coreelec')) { const m = lr.match(/coreelec(\d+)/); if (m) return m[1]; }
      return null;
    };

    let hostName: string | null = null;
    try {
      const raw = readFileSync('/proc/version', 'utf8').trim();
      const vm = raw.match(/^Linux version\s+(\S+)/);
      if (vm) {
        const releaseStr = vm[1].toLowerCase();
        const releaseNameMatch = releaseStr.match(/(armbian|dietpi|libreelec|coreelec)/);
        if (releaseNameMatch) {
          const nameMap: Record<string, string> = {
            armbian: 'Armbian',
            dietpi: 'DietPi',
            libreelec: 'LibreELEC',
            coreelec: 'CoreELEC',
          };
          hostName = nameMap[releaseNameMatch[1]] ?? releaseNameMatch[1];
        } else {
          const dm = raw.match(/\b(Debian|Ubuntu|Red Hat|CentOS|Fedora|Alpine|Arch|Gentoo|SUSE|Proxmox|OpenWrt|Deepin|Kylin|openEuler|Anolis|UOS|Linux Mint|Slackware|Manjaro|NixOS|Void|Mageia|Kali|Amazon|Solus|Alibaba|Armbian|DietPi|Raspbian)\b/i);
          hostName = dm ? dm[1] : null;
        }
      }
    } catch { /* source A unavailable */ }

    let osReleaseName: string | null = null;
    let osReleaseVer: string | null = null;
    try {
      for (const f of ['/etc/os-release', '/usr/lib/os-release']) {
        if (!existsSync(f)) continue;
        const raw = readFileSync(f, 'utf8');
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const get = (k: string) => { const m = raw.match(new RegExp(`^${esc(k)}=("?)(.+?)\\1$`, 'm')); return m?.[2] ?? null; };
        const pretty = get('PRETTY_NAME') || get('NAME');
        const ver = get('VERSION_ID');
        if (pretty) {
          const nm = pretty.match(/^([^0-9]+)/);
          osReleaseName = nm ? nm[1].trim() : pretty;
          osReleaseVer = ver;
          break;
        }
      }
    } catch { /* source B unavailable */ }

    let finalName: string;
    let finalVer: string | null;

    if (hostName && osReleaseName) {
      const a = hostName.toLowerCase();
      const b = osReleaseName.toLowerCase();
      if (a.includes(b) || b.includes(a) || (isRhelFamily(a) && isRhelFamily(b))) {
        finalName = osReleaseName;
        finalVer = kernelDistroVer(hostName) ?? osReleaseVer;
      } else {
        finalName = hostName;
        finalVer = kernelDistroVer(hostName);
      }
    } else if (hostName) {
      finalName = hostName;
      finalVer = kernelDistroVer(hostName);
    } else if (osReleaseName) {
      finalName = osReleaseName;
      finalVer = kernelDistroVer(osReleaseName) ?? osReleaseVer;
    } else {
      for (const [path, prefix] of [
        ['/etc/alpine-release', 'Alpine Linux '],
        ['/etc/redhat-release', ''],
        ['/etc/debian_version', 'Debian '],
      ] as [string, string][]) {
        try {
          if (existsSync(path)) {
            const raw = prefix + readFileSync(path, 'utf8').trim();
            return kernelVer ? `${raw} (kernel ${kernelVer})` : raw;
          }
        } catch { /* try next */ }
      }
      return kernelVer ? `Linux (kernel ${kernelVer})` : 'Linux';
    }

    const base = finalVer ? `${finalName} ${finalVer}` : finalName;
    return kernelVer ? `${base} (kernel ${kernelVer})` : base;
  }

  if (os.platform() === 'win32') {
    try {
      const productName = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName',
        { encoding: 'utf8', timeout: 3000, stdio: 'pipe' },
      );
      const m = productName.match(/ProductName\s+REG_SZ\s+(.+)/);
      let name = m ? m[1].trim() : `Windows ${os.release()}`;
      try {
        const buildOut = execSync(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuildNumber',
          { encoding: 'utf8', timeout: 3000, stdio: 'pipe' },
        );
        const bm = buildOut.match(/CurrentBuildNumber\s+REG_SZ\s+(\d+)/);
        if (bm && parseInt(bm[1], 10) >= 22000) {
          name = name.replace(/^Windows 10/, 'Windows 11');
        }
      } catch { /* keep name as-is */ }
      return name;
    } catch { /* fall through */ }
    return `Windows ${os.release()}`;
  }

  return os.platform();
}

export function normalizeArch(arch: string): string {
  const map: Record<string, string> = {
    loong64: 'LoongArch',
    riscv64: 'RISC-V',
    mips: 'MIPS',
    mipsel: 'MIPS (LE)',
    arm: 'ARM',
    arm64: 'ARM64',
    x64: 'x86_64',
    ia32: 'x86',
    s390: 'S/390',
    s390x: 'S/390x',
    ppc: 'PowerPC',
    ppc64: 'PowerPC64',
    ppc64le: 'PowerPC64 (LE)',
  };
  return map[arch] ?? arch;
}

export function isDockerEnvironment(): boolean {
  if (os.platform() !== 'linux') return false;
  try { if (existsSync('/.dockerenv')) return true; } catch { /* ignore */ }
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker/i.test(cgroup)) return true;
  } catch { /* ignore */ }
  return false;
}

const CACHED_IS_DOCKER = (() => { try { return isDockerEnvironment(); } catch { return false; } })();

const CACHED_DISTRO = (() => {
  try {
    const distro = detectDistro();
    return CACHED_IS_DOCKER ? `${distro} [docker]` : distro;
  } catch { return os.platform(); }
})();
const CACHED_ARCH_LABEL = normalizeArch(os.arch());

export function getSystemDistro(): string {
  return CACHED_DISTRO;
}

export function getNormalizedArch(): string {
  return CACHED_ARCH_LABEL;
}

// ─── Mock systems for fuzzy/privacy mode ─────────────────────────────────
// Built once from the project's known distro + arch identifiers
// so there is zero runtime allocation or complex logic per call.

const MOCK_SYSTEMS: readonly string[] = (() => {
  const DISTROS = [
    'Windows 11', 'Windows 10', 'Windows Server 2025',
    'macOS 15 Sequoia', 'macOS 14 Sonoma', 'macOS 13 Ventura',
    'Ubuntu 24.04', 'Ubuntu 22.04', 'Ubuntu 20.04',
    'Debian 13', 'Debian 12', 'Debian 11',
    'Fedora 41', 'Fedora 40',
    'CentOS Stream 9', 'Red Hat Enterprise Linux 9',
    'Alpine Linux 3.21', 'Arch Linux', 'openSUSE Tumbleweed',
    'Gentoo Linux', 'Slackware 15.0', 'Manjaro 24',
    'NixOS 25.05', 'Void Linux', 'Kali 2024.1',
    'Armbian 24.11', 'Raspbian 12', 'DietPi',
    'Deepin 23', 'Kylin V10', 'UOS 20',
    'Linux Mint 22', 'Proxmox VE 8', 'OpenWrt 23.05',
    'Alibaba Cloud Linux 3', 'Anolis OS 8',
    'Android 15', 'Android 14',
    'FreeBSD 14.1', 'OpenBSD 7.5',
  ];

  const ARCHES: Record<string, string[]> = {
    'Windows': ['x86_64', 'x86'],
    'macOS': ['arm64', 'x86_64'],
    'Android': ['aarch64', 'ARM64'],
    'FreeBSD': ['amd64', 'x86'],
    'OpenBSD': ['amd64', 'arm64'],
    '*': ['x86_64', 'aarch64', 'ARM64', 'ARM', 'RISC-V', 'LoongArch'],
  };

  const out: string[] = [];
  for (const d of DISTROS) {
    let prefix: string;
    if (d.startsWith('Windows')) prefix = 'Windows';
    else if (d.startsWith('macOS')) prefix = 'macOS';
    else if (d.startsWith('Android')) prefix = 'Android';
    else if (d.startsWith('FreeBSD')) prefix = 'FreeBSD';
    else if (d.startsWith('OpenBSD')) prefix = 'OpenBSD';
    else prefix = '*';
    for (const arch of (ARCHES[prefix] ?? ARCHES['*'])) {
      out.push(`${d} ${arch}`);
    }
  }
  return out;
})();

/** Return a randomly-selected mock system string (fuzzy/privacy mode). ~10% chance of [docker] suffix. */
export function getMockSystem(): string {
  const base = MOCK_SYSTEMS[Math.floor(Math.random() * MOCK_SYSTEMS.length)];
  return Math.random() < 0.1 ? `${base} [docker]` : base;
}

export function getSystemInfo(): SystemInfo {
  return {
    platform: os.platform(),
    arch: os.arch(),
    archLabel: CACHED_ARCH_LABEL,
    release: os.release(),
    distro: CACHED_DISTRO,
  };
}
