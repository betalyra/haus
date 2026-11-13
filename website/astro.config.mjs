// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://haus-fmt.org',
  // Keep the spaces between words and inline links/code.
  compressHTML: false,
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // The playground and the hover types use the haus parser and the examples from the repo.
    server: { fs: { allow: [".."] } },
  },
});
