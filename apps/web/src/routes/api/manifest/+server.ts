// SPDX-License-Identifier: Apache-2.0
import { APP_NAME } from '$app/env/private';
import { json } from '@sveltejs/kit';
export const GET = () => json({
  name: APP_NAME || 'Domain Mail', short_name: APP_NAME || 'Mail',
  description: 'Your domain email', start_url: '/app', scope: '/', display: 'standalone',
  background_color: '#15171E', theme_color: '#0E7AE6',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, { headers: { 'content-type': 'application/manifest+json' } });
