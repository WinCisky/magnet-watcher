// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://wincisky.github.io',
  base: '/magnet-watcher',
  integrations: [svelte()],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        $lib: new URL('./src/lib', import.meta.url).pathname
      }
    }
  }
});