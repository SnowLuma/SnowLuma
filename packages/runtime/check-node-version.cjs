'use strict';

const SUPPORTED_NODE_RANGE = '>=24';

function parseNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
}

function isSupportedNodeVersion(version) {
  const actual = parseNodeVersion(version);
  if (!actual) return false;

  const [major] = actual;
  return major >= 24;
}

if (require.main === module && !isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `error: SnowLuma requires Node.js ${SUPPORTED_NODE_RANGE}; found ${process.versions.node}.`,
  );
  process.exitCode = 1;
}

module.exports = { SUPPORTED_NODE_RANGE, isSupportedNodeVersion };
