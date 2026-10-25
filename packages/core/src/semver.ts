/**
 * Semantic Versioning 2.0.0 parsing and precedence (https://semver.org).
 *
 * For convenience when targeting app versions, a missing minor or patch is
 * read as 0 ("2" and "2.1" mean 2.0.0 and 2.1.0) and a leading "v" is
 * ignored. Everything else follows the spec, including pre-release ordering;
 * build metadata is parsed and ignored for precedence.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const PATTERN = new RegExp(
  `^v?(${NUM})(?:\\.(${NUM}))?(?:\\.(${NUM}))?` +
    `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

const MAX_LENGTH = 256;

export function parseSemver(input: string): SemVer | undefined {
  if (input.length > MAX_LENGTH) return undefined;
  const m = PATTERN.exec(input);
  if (m === null) return undefined;
  const nums = [m[1], m[2], m[3]].map((s) => (s === undefined ? 0 : Number(s)));
  if (!nums.every(Number.isSafeInteger)) return undefined;
  const prerelease =
    m[4] === undefined ? [] : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  if (prerelease.some((id) => typeof id === 'number' && !Number.isSafeInteger(id))) {
    return undefined;
  }
  const [major = 0, minor = 0, patch = 0] = nums;
  return { major, minor, patch, prerelease };
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative, zero or positive as `a` has lower, equal or higher precedence than `b`. */
export function compareSemver(a: SemVer, b: SemVer): number {
  const core =
    Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdentifiers(a.prerelease[i] ?? 0, b.prerelease[i] ?? 0);
    if (c !== 0) return c;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}
