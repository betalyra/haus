// Starts the haus language server for .haus files.
import * as vscode from "vscode"
import { LanguageClient, TransportKind, type ServerOptions } from "vscode-languageclient/node"

let client: LanguageClient | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath("dist/server.js")
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  }
  client = new LanguageClient("haus", "haus language server", serverOptions, {
    documentSelector: [{ language: "haus" }],
  })
  await client.start()

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
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop()
}
