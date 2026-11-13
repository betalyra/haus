/**
 * Hover types in the docs' code blocks: an Expressive Code plugin that gives
 * every ```haus and ```haus-schema block the same hovers as the landing page
 * (src/lib/hover.ts). The tooltip itself is HoverTips.astro, added to every
 * docs page by the MarkdownContent override.
 */
import { definePlugin, ExpressiveCodeAnnotation, type AnnotationRenderOptions } from "@astrojs/starlight/expressive-code";
import { h } from "@astrojs/starlight/expressive-code/hast";
import { hoverSpans } from "./hover";

class HoverAnnotation extends ExpressiveCodeAnnotation {
  constructor(
    readonly text: string,
    columnStart: number,
    columnEnd: number,
  ) {
    super({ inlineRange: { columnStart, columnEnd } });
  }
  render({ nodesToTransform }: AnnotationRenderOptions) {
    return nodesToTransform.map((node) => h("span", { class: "hover-tip", "data-hover": this.text }, [node]));
  }
}

export const hausHoverPlugin = () =>
  definePlugin({
    name: "haus-hover",
    hooks: {
      annotateCode: ({ codeBlock }) => {
        if (codeBlock.language !== "haus" && codeBlock.language !== "haus-schema") return;
        const lines = codeBlock.getLines();
        // Where each line starts in the whole text, to turn offsets into line and column.
        const starts: number[] = [];
        let at = 0;
        for (const line of lines) {
          starts.push(at);
          at += line.text.length + 1;
        }
        const kind = codeBlock.language === "haus-schema" ? "schema" : "data";
        for (const { start, end, text } of hoverSpans(kind, codeBlock.code)) {
          let i = starts.length - 1;
          while (i > 0 && starts[i]! > start) i--;
          lines[i]!.addAnnotation(new HoverAnnotation(text, start - starts[i]!, end - starts[i]!));
        }
      },
    },
  });
