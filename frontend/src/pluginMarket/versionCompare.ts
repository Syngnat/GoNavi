// compareMarketVersions orders two marketplace versions: <0 when left is older,
// 0 when equal, >0 when newer. It follows the service's semver semantics: an
// optional v prefix, numeric major.minor.patch, and a prerelease suffix that
// sorts below the release it annotates (numeric identifiers below alphanumeric).
function compareNumeric(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, ''); const b = right.replace(/^0+(?=\d)/, '');
  return a.length !== b.length ? (a.length < b.length ? -1 : 1) : a === b ? 0 : a < b ? -1 : 1;
}
export function compareMarketVersions(left: string, right: string): number {
  const core = (value: string) => value.trim().replace(/^v/, '').split('+')[0];
  const leftCore = core(left);
  const rightCore = core(right);
  if (!leftCore || !rightCore) return 0;
  const leftParts = leftCore.split('-')[0].split('.');
  const rightParts = rightCore.split('-')[0].split('.');
  for (let index = 0; index < 3; index += 1) {
    const a = /^\d+$/.test(leftParts[index] ?? '') ? leftParts[index] : '0';
    const b = /^\d+$/.test(rightParts[index] ?? '') ? rightParts[index] : '0';
    const compared = compareNumeric(a, b); if (compared) return compared;
  }
  const prerelease = (value: string) => (value.includes('-') ? value.slice(value.indexOf('-') + 1) : '');
  const leftPre = prerelease(leftCore);
  const rightPre = prerelease(rightCore);
  if (leftPre === rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  const leftIdentifiers = leftPre.split('.');
  const rightIdentifiers = rightPre.split('.');
  for (let index = 0; index < Math.min(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    if (leftIdentifiers[index] === rightIdentifiers[index]) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifiers[index]);
    const rightNumeric = /^\d+$/.test(rightIdentifiers[index]);
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifiers[index], rightIdentifiers[index]);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifiers[index] < rightIdentifiers[index] ? -1 : 1;
  }
  return leftIdentifiers.length === rightIdentifiers.length ? 0 : (leftIdentifiers.length < rightIdentifiers.length ? -1 : 1);
}
