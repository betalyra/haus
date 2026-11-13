// Starts the haus language server for .haus files.
import * as vscode from "vscode"
import { LanguageClient, TransportKind, type ServerOptions } from "vscode-languageclient/node"
import { extendMarkdownIt } from "./highlight"

let client: LanguageClient | undefined

/** Diagnostic code of "not in the schema" hints (see server.ts). */
const NOT_IN_SCHEMA = "not-in-schema"

/** What the extension gives VS Code: haus highlighting for the Markdown preview. */
interface Api {
  extendMarkdownIt: typeof extendMarkdownIt
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
  const hints = new Map<string, readonly vscode.Diagnostic[]>()
  const notInSchema = vscode.window.createTextEditorDecorationType({
    light: { textDecoration: "underline dotted rgba(0, 0, 0, 0.45)" },
    dark: { textDecoration: "underline dotted rgba(255, 255, 255, 0.45)" },
  })
  const decorate = (editor: vscode.TextEditor) => {
    const found = hints.get(editor.document.uri.toString()) ?? []
    editor.setDecorations(notInSchema, found.map((d) => ({ range: d.range, hoverMessage: d.message })))
  }
  const module = context.asAbsolutePath("dist/server.js")
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  }
  client = new LanguageClient("haus", "haus language server", serverOptions, {
    documentSelector: [{ language: "haus" }, { language: "haus-schema" }],
    middleware: {
      // "Not in the schema" hints are shown as a dotted underline over the
      // whole name instead of as diagnostics (VS Code would add its own dots
      // under the first characters and list them with the problems).
      handleDiagnostics(uri, diagnostics, next) {
        hints.set(uri.toString(), diagnostics.filter((d) => d.code === NOT_IN_SCHEMA))
        next(uri, diagnostics.filter((d) => d.code !== NOT_IN_SCHEMA))
        for (const editor of vscode.window.visibleTextEditors) if (editor.document.uri.toString() === uri.toString()) decorate(editor)
      },
    },
  })
  await client.start()

  vscode.window.visibleTextEditors.forEach(decorate)
  context.subscriptions.push(notInSchema, vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorate)))

  context.subscriptions.push(
    vscode.commands.registerCommand("haus.inferSchema", async () => {
      const document = vscode.window.activeTextEditor?.document
      if (!document || document.languageId !== "haus" || !client) return
      const schema = await client.sendRequest<string | null>("haus/inferSchema", { uri: document.uri.toString() })
      if (schema === null) {
        void vscode.window.showWarningMessage("haus: fix the syntax errors in this file first.")
        return
      }
      const result = await vscode.workspace.openTextDocument({ language: "haus-schema", content: schema })
      await vscode.window.showTextDocument(result, vscode.ViewColumn.Beside)
    }),
    // Format Document uses the pretty layout; these switch a document between the two styles.
    ...(["pretty", "compact"] as const).map((style) =>
      vscode.commands.registerCommand(`haus.print.${style}`, async () => {
        const editor = vscode.window.activeTextEditor
        const document = editor?.document
        if (!editor || !document || document.languageId !== "haus" || !client) return
        const text = await client.sendRequest<string | null>("haus/print", { uri: document.uri.toString(), style })
        if (text === null) {
          void vscode.window.showWarningMessage("haus: fix the syntax errors in this file first.")
          return
        }
        if (text === document.getText()) return
        const all = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))
        await editor.edit((edit) => edit.replace(all, text))
      }),
    ),
  )

  return { extendMarkdownIt }
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop()
}
