// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { libmediaChunks } from './scripts/vite-libmedia.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://wincisky.github.io',
  base: '/magnet-watcher',
  integrations: [svelte()],

  vite: {
    plugins: [tailwindcss(), libmediaChunks()],
    define: {
      // Which build a diagnostics export came from (each deploy builds anew).
      __MW_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16) + 'Z'),
    },
    resolve: {
      alias: {
        $lib: new URL('./src/lib', import.meta.url).pathname
      }
    }
  }
});