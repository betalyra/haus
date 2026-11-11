import type { LanguageRegistration, ThemeRegistrationRaw } from "shiki";
import grammar from "../../../editors/vscode/syntaxes/haus.tmLanguage.json";

/** The haus grammar, straight from the VS Code extension. */
export const hausLang = {
  ...(grammar as unknown as Omit<LanguageRegistration, "name">),
  name: "haus",
  scopeName: "source.haus",
} satisfies LanguageRegistration;

// Pigment inks from global.css: every colour here is >= 4.5:1 on white.
const ink = "#26231f";
const ink2 = "#57514a";
const ink3 = "#7a726a";
const rose = "#ab2a5d";
const sap = "#3c6a1e";
const sienna = "#9a4019";
const ultramarine = "#2d3f9c";

/** A light theme in the page's own palette. */
export const hausTheme: ThemeRegistrationRaw = {
  name: "haus-light",
  type: "light",
  colors: {
    "editor.background": "#ffffff00",
    "editor.foreground": ink,
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: ink3, fontStyle: "italic" } },
    { scope: ["constant.other.variant.haus", "entity.name.type", "support.type", "support.class", "entity.name.class", "storage.type.rust"], settings: { foreground: rose } },
    { scope: ["string", "string.quoted", "punctuation.definition.string"], settings: { foreground: sap } },
    { scope: ["constant.numeric", "constant.character.escape", "constant.language"], settings: { foreground: sienna } },
    { scope: ["support.type.property-name", "variable.other.property", "meta.object-literal.key", "variable.parameter.type.haus"], settings: { foreground: ink } },
    { scope: ["keyword", "storage.type", "storage.modifier", "keyword.operator.row.haus", "keyword.control"], settings: { foreground: ultramarine } },
    { scope: ["keyword.operator", "keyword.operator.assignment.haus"], settings: { foreground: ink2 } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: ink2 } },
    { scope: ["entity.name.function", "support.function", "variable.function"], settings: { foreground: ink } },
    { scope: ["variable", "variable.other"], settings: { foreground: ink } },
    { scope: ["invalid"], settings: { foreground: rose, fontStyle: "underline" } },
  ],
};
