/**
 * The tools page: compare two documents, format a file. Runs in
 * the browser; a shared link carries the texts in its fragment.
 */
import type { EditorView } from "@codemirror/view";
import {
  HausSyntaxError,
  canonical,
  contextOf,
  equals,
  format,
  hoverAt,
  hoverText,
  parseDocument,
  type HoverContext,
  type Value,
} from "../../../../typescript/packages/haus/src/index.ts";
import { syntaxProblem, type Problem } from "../play/analyze";
import { createEditor, lintAgain, setText } from "../play/editor";
import { copyLink, copyText, decodeState, encodeState } from "../share";
import { compareExamples, formatDefault, formatExamples } from "./examples";
import { linkEditors, pairValues } from "./sync";

type Tool = "compare" | "format";
type Style = "pretty" | "compact";

const $ = <E extends HTMLElement>(sel: string) => document.querySelector<E>(sel)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ── reading a text ───────────────────────────────────────────

interface Reading {
  readonly text: string;
  readonly values?: Value[];
  readonly comments: [number, number][];
  readonly problems: Problem[];
  readonly hover?: HoverContext;
}

function read(text: string): Reading {
  try {
    const { values, comments } = parseDocument(text);
    return { text, values, comments, problems: [], hover: contextOf(values) };
  } catch (e) {
    if (!(e instanceof HausSyntaxError)) throw e;
    return { text, comments: [], problems: [syntaxProblem(e, text)] };
  }
}

/** An editor for one input, with errors and hovers from its last reading. */
function input(parent: HTMLElement, doc: string, onChange: () => void, onCursor?: (pos: number) => void) {
  let reading = read(doc);
  const view: EditorView = createEditor({
    parent,
    doc,
    wrap: true,
    ...(onCursor ? { onCursor } : {}),
    placeholder: "Write or paste haus here…",
    onChange: (text) => {
      reading = read(text);
      onChange();
      requestAnimationFrame(() => lintAgain(view));
    },
    diagnostics: () => reading.problems.map((p) => ({ ...p })),
    hover: (pos) => {
      if (!reading.hover) return undefined;
      const info = hoverAt(reading.hover, pos, { width: 60 });
      return info && { from: info.start, to: info.end, text: hoverText(info) };
    },
  });
  return {
    view,
    get reading() {
      return reading;
    },
    set: (text: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
  };
}

const syntaxSummary = (r: Reading, name = "") => {
  const p = r.problems[0]!;
  const before = r.text.slice(0, p.from).split("\n");
  return `${name ? `${name}: ` : ""}syntax error at ${before.length}:${before.at(-1)!.length + 1}, ${p.message}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── state in the link ────────────────────────────────────────

interface State {
  t: Tool;
  a: string;
  b: string;
  f: string;
  s: Style;
  i: number;
}

async function loadState(): Promise<State> {
  const fallback: State = {
    t: "compare",
    a: compareExamples[0]!.a,
    b: compareExamples[0]!.b,
    f: formatDefault,
    s: "pretty",
    i: 2,
  };
  if (location.hash.length <= 1) return fallback;
  const raw = (await decodeState(location.hash.slice(1))) as Partial<Record<keyof State, unknown>> | undefined;
  if (!raw) return fallback;
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  return {
    t: raw.t === "format" ? "format" : "compare",
    a: str(raw.a, fallback.a),
    b: str(raw.b, fallback.b),
    f: str(raw.f, fallback.f),
    s: raw.s === "compact" ? "compact" : "pretty",
    i: raw.i === 4 ? 4 : 2,
  };
}

// ── the page ─────────────────────────────────────────────────

async function start() {
  const state = await loadState();

  let saving = 0;
  const save = () => {
    clearTimeout(saving);
    saving = window.setTimeout(async () => {
      history.replaceState(null, "", `#${await encodeState(state)}`);
    }, 400);
  };

  // Tabs
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-tool]")];
  const showTool = (tool: Tool) => {
    state.t = tool;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tool === tool));
    for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) panel.hidden = panel.dataset.panel !== tool;
  };
  for (const tab of tabs)
    tab.addEventListener("click", () => {
      showTool(tab.dataset.tool as Tool);
      save();
    });

  // ── Compare ──
  const verdict = $("#cmp-verdict");
  const body = $("#cmp-body");
  const rest = $("#cmp-rest");
  const updateCompare = () => {
    state.a = a.reading.text;
    state.b = b.reading.text;
    save();
    const ci = compareExamples.findIndex((e) => e.a === state.a && e.b === state.b);
    example.value = ci < 0 ? "" : String(ci);
    body.replaceChildren();
    const ra = a.reading;
    const rb = b.reading;
    if (!ra.values || !rb.values) {
      verdict.dataset.state = "error";
      rest.textContent = "";
      if (!ra.values) body.append(el("p", "cmp-verdict__text", syntaxSummary(ra, "a.haus")));
      if (!rb.values) body.append(el("p", "cmp-verdict__text", syntaxSummary(rb, "b.haus")));
      return;
    }
    const va = ra.values;
    const vb = rb.values;
    const differing = va.flatMap((v, i) => (i < vb.length && !equals(v, vb[i]!) ? [i] : []));
    const same = va.length === vb.length && differing.length === 0;
    const stream = va.length > 1 || vb.length > 1;
    verdict.dataset.state = same ? "same" : "different";

    if (same) {
      rest.textContent = stream ? plural(va.length, "value") : "";
      body.append(
        el(
          "p",
          "cmp-verdict__text",
          ra.text === rb.text
            ? "The texts are identical."
            : "Only layout, comments, key order or spelling differ.",
        ),
      );
      const list = el("div", "cmp-canon");
      va.forEach((v, i) => list.append(canonBlock(stream ? `Value ${i + 1}` : "Canonical form", canonical(v))));
      body.append(list);
      return;
    }

    rest.textContent = "";
    const reasons: string[] = [];
    if (va.length !== vb.length) reasons.push(`a.haus has ${plural(va.length, "value")}, b.haus has ${vb.length}.`);
    if (stream && differing.length) reasons.push(`${differing.length === 1 ? "Value" : "Values"} ${differing.map((i) => i + 1).join(", ")} ${differing.length === 1 ? "differs" : "differ"}.`);
    for (const r of reasons) body.append(el("p", "cmp-verdict__text", r));
    const list = el("div", "cmp-canon");
    for (const i of differing) {
      const label = stream ? `Value ${i + 1}` : "";
      list.append(canonBlock(`${label ? `${label}, ` : ""}a.haus`, canonical(va[i]!)), canonBlock(`${label ? `${label}, ` : ""}b.haus`, canonical(vb[i]!)));
    }
    body.append(list);
    const note = el("p", "cmp-verdict__note");
    note.innerHTML =
      '<code class="inline-code">1.0</code> is not <code class="inline-code">1</code>, and a missing field is not <code class="inline-code">None</code>. <a class="prose-link" href="/docs/spec#2-equality">What counts as equal</a>';
    body.append(note);
  };

  const canonBlock = (label: string, text: string) => {
    const block = el("div", "cmp-canon__item");
    block.append(el("div", "canon-label", label), el("pre", "canon-text", text));
    return block;
  };

  const a = input($("#cmp-a"), state.a, () => updateCompare());
  const b = input($("#cmp-b"), state.b, () => updateCompare());

  const example = $<HTMLSelectElement>("#cmp-example");
  compareExamples.forEach((e, i) => example.add(new Option(e.name, String(i))));
  example.addEventListener("change", () => {
    const e = compareExamples[Number(example.value)];
    if (!e) return;
    a.set(e.a);
    b.set(e.b);
  });

  // ── Format ──
  const out = createEditor({ parent: $("#fmt-out"), doc: "", readOnly: true, wrap: true, onCursor: (pos) => link.cursor("b", pos) });
  const fmtSummary = $("#fmt-summary");
  const styleButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-style]")];
  const indent = $<HTMLSelectElement>("#fmt-indent");
  indent.value = String(state.i);

  const updateFormat = () => {
    state.f = fmtIn.reading.text;
    save();
    const fi = formatExamples.findIndex((e) => e.text === state.f);
    fmtExample.value = fi < 0 ? "" : String(fi);
    for (const btn of styleButtons) btn.setAttribute("aria-selected", String(btn.dataset.style === state.s));
    indent.disabled = state.s === "compact";
    const r = fmtIn.reading;
    if (!r.values) {
      fmtSummary.textContent = syntaxSummary(r);
      fmtSummary.dataset.state = "error";
      link.setPairs([]); // the output is from an older text: nothing lines up
      return;
    }
    const text =
      state.s === "compact"
        ? format(r.values, { style: "compact" })
        : format(r.values, { source: r.text, comments: r.comments, indent: state.i });
    setText(out, text);
    // The output is the same values, so a second parse pairs each one with its copy.
    try {
      link.setPairs(pairValues(r.values, parseDocument(text).values));
    } catch {
      link.setPairs([]);
    }
    const dropped = state.s === "compact" && r.comments.length > 0;
    fmtSummary.textContent =
      state.s === "compact"
        ? `Each value on one line.${dropped ? ` ${plural(r.comments.length, "comment")} dropped: compact has no room for them.` : ""}`
        : "One entry per line, comments kept.";
    fmtSummary.dataset.state = "ok";
  };
  const fmtIn = input($("#fmt-in"), state.f, () => updateFormat(), (pos) => link.cursor("a", pos));
  const link = linkEditors(fmtIn.view, out);
  for (const btn of styleButtons)
    btn.addEventListener("click", () => {
      state.s = btn.dataset.style as Style;
      updateFormat();
    });
  indent.addEventListener("change", () => {
    state.i = Number(indent.value);
    updateFormat();
  });
  const fmtExample = $<HTMLSelectElement>("#fmt-example");
  formatExamples.forEach((e, i) => fmtExample.add(new Option(e.name, String(i))));
  fmtExample.addEventListener("change", () => {
    const e = formatExamples[Number(fmtExample.value)];
    if (e) fmtIn.set(e.text);
  });
  const copyOut = $<HTMLButtonElement>("#fmt-copy");
  copyOut.addEventListener("click", () => copyText(copyOut, out.state.doc.toString()));

  // Share: the URL already holds the state; write it now and copy it.
  const share = $<HTMLButtonElement>("#tools-share");
  share.addEventListener("click", async () => {
    clearTimeout(saving);
    history.replaceState(null, "", `#${await encodeState(state)}`);
    await copyLink(share);
  });

  showTool(state.t);
  updateCompare();
  updateFormat();
}

start();
