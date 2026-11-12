/**
 * haus for CodeMirror: a small tokenizer (the same scopes as the TextMate
 * grammar of the VS Code extension) and the page's code colours (code.ts).
 */
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

interface State {
  /** Inside a block comment, at this depth. */
  comment: number;
  /** Inside a """ block string. */
  block: boolean;
}

const parser: StreamParser<State> = {
  name: "haus",
  startState: () => ({ comment: 0, block: false }),
  token(stream, state) {
    if (state.comment > 0) {
      while (!stream.eol()) {
        if (stream.match("/*")) state.comment++;
        else if (stream.match("*/")) {
          if (--state.comment === 0) break;
        } else stream.next();
      }
      return "comment";
    }
    if (state.block) {
      if (stream.skipTo('"""')) {
        stream.match('"""');
        state.block = false;
      } else stream.skipToEnd();
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = 1;
      return "comment";
    }
    if (stream.match('"""')) {
      state.block = true;
      return "string";
    }
    if (stream.match(/^x"[0-9a-fA-F\s]*"/)) return "string";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?(?:0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/)) return "number";
    if (stream.match(/^(?:type|import|closed)\b/)) return "keyword";
    if (stream.match(/^std\/[a-z]+|^@[\w.-]+\/[\w.-]+|^\.\.?\/[\w./-]+/)) return "string";
    if (stream.match(/^[A-Z][A-Za-z0-9_]*/)) return "typeName";
    if (stream.match(/^[a-z_][A-Za-z0-9_]*(?=\s*\??\s*:)/)) return "propertyName";
    if (stream.match(/^[a-z_][A-Za-z0-9_]*/)) return "variableName";
    stream.next();
    return "punctuation";
  },
  blankLine() {},
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
};

export const haus = StreamLanguage.define(parser);

// The colours of the page's code cards (src/lib/code.ts).
const style = HighlightStyle.define([
  { tag: t.comment, color: "#7a726a", fontStyle: "italic" },
  { tag: t.string, color: "#3c6a1e" },
  { tag: t.number, color: "#9a4019" },
  { tag: t.keyword, color: "#2d3f9c" },
  { tag: t.typeName, color: "#ab2a5d" },
  { tag: t.propertyName, color: "#26231f" },
  { tag: t.variableName, color: "#26231f" },
  { tag: t.punctuation, color: "#57514a" },
  // TypeScript and JSON in the output panel
  { tag: [t.definitionKeyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#2d3f9c" },
  { tag: [t.bool, t.null], color: "#9a4019" },
  { tag: [t.definition(t.typeName), t.className], color: "#ab2a5d" },
]);

export const highlighting = syntaxHighlighting(style);
