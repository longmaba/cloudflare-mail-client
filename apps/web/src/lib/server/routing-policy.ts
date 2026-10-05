// SPDX-License-Identifier: Apache-2.0
/** Every mutation must remain inside the domain selected by the installer. */
export function assertMailScope(domain: string, zone: string, configured: string, mode: string) {
  if (!configured || domain !== configured || !(domain === zone || domain.endsWith(`.${zone}`))) {
    throw new Error('This domain is outside the configured mail instance. Run setup to select its domain.');
  }
  if (mode !== 'apex' && domain === zone) {
    throw new Error('Pilot mode cannot change apex mail routing. Select a pilot subdomain in setup.');
  }
}

export function assertRecipientScope(address: string, domain: string) {
  if (address.split('@').length !== 2 || address.split('@')[1] !== domain) {
    throw new Error('Recipient must belong to the configured mail domain.');
  }
}
