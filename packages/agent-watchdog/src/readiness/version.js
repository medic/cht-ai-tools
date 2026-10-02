'use strict';
// CHT version strings as reported by /api/v2/monitoring (research.md R-6): `4.11.0`, `3.17.0`, `4.19.0-beta.1`.

const VERSION = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

/** { major, minor, patch, pre } or null when the value is not a version. */
const parseVersion = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = VERSION.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    pre: match[4] === undefined ? null : match[4],
  };
};

/** -1, 0 or 1 on major.minor.patch; the pre-release tag never takes part: a release candidate counts as its release. */
const compareVersions = (a, b) => {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) {
    throw new TypeError('compareVersions needs two parseable versions');
  }
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) {
      return left[part] < right[part] ? -1 : 1;
    }
  }
  return 0;
};

/** True when `version` parses and is at or above `minimum`; anything unparseable is below every minimum. */
const atLeast = (version, minimum) => {
  const parsed = parseVersion(version);
  return parsed !== null && compareVersions(parsed, minimum) >= 0;
};

module.exports = { parseVersion, compareVersions, atLeast };
