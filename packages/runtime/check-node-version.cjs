'use strict';

const SUPPORTED_NODE_RANGE = '^24.22.1 || >=26.12.1';

function parseNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
}

function isSupportedNodeVersion(version) {
  const actual = parseNodeVersion(version);
  if (!actual) return false;

  const [major, minor, patch] = actual;
  if (major === 24) return minor > 22 || (minor === 22 && patch >= 1);
  if (major === 26) return minor > 12 || (minor === 12 && patch >= 1);
  return major > 26;
}

if (require.main === module && !isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `error: SnowLuma requires Node.js ${SUPPORTED_NODE_RANGE}; found ${process.versions.node}.`,
  );
  process.exitCode = 1;
}

module.exports = { SUPPORTED_NODE_RANGE, isSupportedNodeVersion };
