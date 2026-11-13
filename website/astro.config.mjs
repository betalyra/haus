// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import tailwindcss from '@tailwindcss/vite';
import { hausLang, hausSchemaLang, hausTheme } from './src/lib/code.ts';
import { hausHoverPlugin } from './src/lib/ec-hover.ts';


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
        MarkdownContent: './src/components/docs/MarkdownContent.astro',
        PageTitle: './src/components/docs/PageTitle.astro',
      },
      expressiveCode: {
        // The landing page's pigment-ink theme, and the grammars from the VS Code extension.
        themes: [/** @type {any} */ (hausTheme)],
        // Hover types in haus blocks, as on the landing page.
        plugins: [hausHoverPlugin()],
        // Code as on the landing page: a sheet of white paper with a thin line, the
        // file name small and grey above the code, no window chrome.
        defaultProps: { overridesByLang: { 'sh,bash,shell': { frame: 'none' } } },
        styleOverrides: {
          borderRadius: '14px',
          borderColor: 'color-mix(in oklab, #26231f 15%, white)',
          codeBackground: '#ffffff',
          codeFontFamily: 'var(--font-mono)',
          codeFontSize: '0.86rem',
          codeLineHeight: '1.7',
          codePaddingBlock: '0.9rem',
          codePaddingInline: '1.25rem',
          uiFontFamily: 'var(--font-mono)',
          frames: {
            frameBoxShadowCssValue: 'none',
            editorTabBarBackground: '#ffffff',
            editorActiveTabBackground: '#ffffff',
            editorActiveTabForeground: '#7a726a',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorActiveTabBorderColor: 'transparent',
            editorTabBarBorderColor: 'transparent',
            editorTabBarBorderBottomColor: 'transparent',
            editorTabsMarginInlineStart: '0.4rem',
            terminalTitlebarBackground: '#ffffff',
            terminalTitlebarForeground: '#7a726a',
            terminalTitlebarDotsOpacity: '0',
            terminalTitlebarBorderBottomColor: 'transparent',
            terminalBackground: '#ffffff',
            inlineButtonBackground: '#26231f',
            inlineButtonForeground: '#26231f',
            inlineButtonBorder: 'color-mix(in oklab, #26231f 15%, white)',
          },
        },
        shiki: {
          langs: [/** @type {any} */ (hausLang), /** @type {any} */ (hausSchemaLang)],
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
        {
          label: 'Start',
          items: [
            { label: 'Welcome', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'A tour of haus', slug: 'docs/tour' },
            { label: 'Coming from JSON', slug: 'docs/from-json' },
          ],
        },
        {
          label: 'Guided tours',
          items: [
            { label: 'Evolving your data', slug: 'docs/tours/evolving' },
            { label: 'Logs and streams', slug: 'docs/tours/streams' },
            { label: 'From schema to code', slug: 'docs/tours/typed' },
            { label: 'Time and money', slug: 'docs/tours/time-money' },
          ],
        },
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
