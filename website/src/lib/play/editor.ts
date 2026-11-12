/** A CodeMirror editor for haus, in the page's style. */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionSource } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState, StateEffect, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, hoverTooltip, keymap, lineNumbers, placeholder, type Tooltip } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { haus, highlighting } from "./lang";

const languages = { haus: () => haus, typescript: () => javascript({ typescript: true }), json: () => javascript() };
const languageSlot = new Compartment();

/** Ask an editor to lint again (its problems may depend on another editor's text). */
const relint = StateEffect.define<null>();
export const lintAgain = (view: EditorView) => view.dispatch({ effects: relint.of(null) });

/** Switch an editor's language (one created by createEditor). */
export const setLanguage = (view: EditorView, language: keyof typeof languages) =>
  view.dispatch({ effects: languageSlot.reconfigure(languages[language]()) });

const theme = EditorView.theme({
  "&": { fontSize: "0.84rem", backgroundColor: "transparent", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { padding: "0.6rem 0", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--ink-3)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.6rem 0 0.9rem", fontSize: "0.74rem" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--ultramarine) 4%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--ultramarine) 16%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-placeholder": { color: "var(--ink-3)" },
  ".cm-tooltip": {
    border: "1px solid var(--line)",
    borderRadius: "10px",
    backgroundColor: "var(--paper)",
    boxShadow: "0 6px 24px -12px color-mix(in oklab, var(--ink) 35%, transparent)",
    overflow: "hidden",
  },
  ".cm-tooltip-hover, .cm-tooltip-lint": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    lineHeight: "1.55",
    padding: "0.45rem 0.7rem",
    whiteSpace: "pre-wrap",
    maxWidth: "min(30rem, 90vw)",
  },
  ".cm-hover-type": { fontWeight: "600" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "0.8rem" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "color-mix(in oklab, var(--ultramarine) 14%, transparent)", color: "var(--ink)" },
  ".cm-diagnostic": { padding: "0", borderLeft: "none" },
  ".cm-diagnostic-error": { color: "var(--rose-ink, #ab2a5d)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #ab2a5d", textUnderlineOffset: "3px", textDecorationThickness: "1px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted #2d3f9c", textUnderlineOffset: "3px" },
  ".cm-gutter-lint": { width: "0.9rem" },
  ".cm-lint-marker": { width: "0.6rem", height: "0.6rem" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--gold, #e39b16) 22%, transparent)", outline: "none" },
});

export interface EditorOptions {
  readonly parent: HTMLElement;
  readonly doc: string;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  /** haus (default), TypeScript, JSON, or none. */
  readonly language?: "haus" | "typescript" | "json" | false;
  readonly onChange?: (text: string) => void;
  /** Problems to underline, from the last analysis. */
  readonly diagnostics?: () => Diagnostic[];
  /** Hover text at a position: the first line is the type. */
  readonly hover?: (pos: number) => { from: number; to: number; text: string } | undefined;
  readonly complete?: CompletionSource;
}

export function createEditor(o: EditorOptions): EditorView {
  const extensions: Extension[] = [theme, highlighting];
  extensions.push(languageSlot.of(o.language === false ? [] : languages[o.language ?? "haus"]()));
  if (o.readOnly) {
    // Line numbers here too, so the output lines up with the editors next to it.
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers());
  } else {
    extensions.push(
      lineNumbers(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    );
    if (o.placeholder) extensions.push(placeholder(o.placeholder));
  }
  if (o.onChange) {
    const onChange = o.onChange;
    extensions.push(EditorView.updateListener.of((u) => u.docChanged && onChange(u.state.doc.toString())));
  }
  if (o.diagnostics) {
    const get = o.diagnostics;
    extensions.push(
      linter(() => get(), { delay: 0, needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(relint))) }),
      lintGutter(),
    );
  }
  if (o.hover) {
    const get = o.hover;
    extensions.push(
      hoverTooltip((_, pos): Tooltip | null => {
        const info = get(pos);
        if (!info) return null;
        return {
          pos: info.from,
          end: info.to,
          above: false,
          create: () => {
            const dom = document.createElement("div");
            const [first, ...rest] = info.text.split("\n");
            const type = dom.appendChild(document.createElement("div"));
            type.className = "cm-hover-type";
            type.textContent = first ?? "";
            if (rest.length) dom.appendChild(document.createElement("div")).textContent = rest.join("\n");
            return { dom };
          },
        };
      }, { hoverTime: 250 }),
    );
  }
  if (o.complete) extensions.push(autocompletion({ override: [o.complete], icons: false }));
  return new EditorView({ parent: o.parent, state: EditorState.create({ doc: o.doc, extensions }) });
}

/** Replace a read-only editor's text. */
export const setText = (view: EditorView, text: string) => {
  if (view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};
