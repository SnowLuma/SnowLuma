import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';

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
        const get = (k: string) => { const m = raw.match(new RegExp(`^${k}=("?)(.+?)\\1$`, 'm')); return m?.[2] ?? null; };
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

const CACHED_DISTRO = (() => { try { return detectDistro(); } catch { return os.platform(); } })();
const CACHED_ARCH_LABEL = normalizeArch(os.arch());

export function getSystemDistro(): string {
  return CACHED_DISTRO;
}

export function getNormalizedArch(): string {
  return CACHED_ARCH_LABEL;
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
