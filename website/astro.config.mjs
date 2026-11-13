// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { hausLang, hausTheme } from './src/lib/code.ts';

const schemaGrammar = JSON.parse(readFileSync(new URL('../editors/vscode/syntaxes/haus-schema.tmLanguage.json', import.meta.url), 'utf8'));

// https://astro.build/config
export default defineConfig({
  site: 'https://haus-fmt.org',
  // Keep the spaces between words and inline links/code.
  compressHTML: false,
  integrations: [
    react(),
    sitemap(),
    starlight({
      title: 'haus',
      description: 'A data format for humans: friendly to write, pleasant to read, and at home in your code.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/haus-mark.svg', alt: 'haus' },
      editLink: { baseUrl: 'https://github.com/betalyra/haus-fmt/edit/main/docs/' },
      customCss: ['./src/styles/docs.css'],
      // The docs and the spec live outside src/: let Starlight's Markdown extras (asides, heading anchors) reach them.
      markdown: { processedDirs: ['../docs', '../spec'] },
      components: {
        Head: './src/components/docs/Head.astro',
        ThemeProvider: './src/components/docs/ThemeProvider.astro',
        ThemeSelect: './src/components/docs/ThemeSelect.astro',
        SocialIcons: './src/components/docs/SocialIcons.astro',
      },
      expressiveCode: {
        // The landing page's pigment-ink theme, and the grammars from the VS Code extension.
        themes: [/** @type {any} */ (hausTheme)],
        shiki: {
          langs: [/** @type {any} */ (hausLang), { ...schemaGrammar, name: 'haus-schema', embeddedLangs: ['haus'] }],
        },
      },
      plugins: [
        starlightLlmsTxt({
          projectName: 'haus',
          description:
            'haus is a data format for humans: records, variants instead of null, exact numbers, dates and times, streams of values, and optional schemas. It has bindings for TypeScript, Effect, Rust, Roc and Python.',
          rawContent: true,
        }),
      ],
      sidebar: [
        { label: 'Start', items: [{ label: 'Welcome', slug: 'docs' }] },
        {
          label: 'Reference',
          items: [
            { label: 'Specification', slug: 'docs/spec' },
            { label: 'std/time', slug: 'docs/spec/time' },
          ],
        },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // The playground and the hover types use the haus parser and the examples from the repo.
    server: { fs: { allow: [".."] } },
    // Native canvas for the Open Graph images: keep it out of the bundle.
    ssr: { external: ['@napi-rs/canvas'] },
    optimizeDeps: { exclude: ['@napi-rs/canvas'] },
  },
});
