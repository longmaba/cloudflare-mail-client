// SPDX-License-Identifier: Apache-2.0
import { error } from '@sveltejs/kit';
export const load = ({ locals }) => {
  if (locals.user?.role !== 'superadmin') error(403, 'Instance administrator only');
  return {};
};
