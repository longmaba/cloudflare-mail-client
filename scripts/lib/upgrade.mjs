// SPDX-License-Identifier: Apache-2.0
export function assertUpgradeTarget(config, { sourceOrigin, dirty, current, target, publishedCommits, manifest, isAncestor }) {
  if (sourceOrigin !== config.sourceOrigin) throw new Error('Release source differs from the installed source. Restore the original Git remote.');
  if (dirty) throw new Error('Tracked edits must be preserved before upgrade; automatic overwrite is blocked.');
  if (!publishedCommits.includes(target)) throw new Error('Local release tag differs from the published source. Upgrade blocked.');
  if (!isAncestor) throw new Error('Selected release diverges from the installed version. Automatic downgrade/history replacement is blocked.');
  if (!manifest.scripts?.setup || !manifest.scripts?.upgrade || manifest.engines?.node !== '>=24 <25' || manifest.mailInstaller?.configVersion !== config.version) throw new Error('Selected release does not support this instance configuration/Node 24 contract. Use a compatible release of this fork.');
  return { from: current, to: target };
}
