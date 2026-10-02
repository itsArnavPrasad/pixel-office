// The office's two homes: an editor panel (big) and an activity-bar view (mini). Same page, two modes.
import * as vscode from 'vscode'

import { parseFromWebview, type FromWebview, type ViewState } from '../protocol'

export class OfficeViews implements vscode.WebviewViewProvider {
  private panel: vscode.WebviewPanel | null = null
  private sidebar: vscode.WebviewView | null = null
  private last: ViewState | null = null

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly onMessage: (m: FromWebview) => void) {
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('pixelOffice.sidebar', this, { webviewOptions: { retainContextWhenHidden: true } }))
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.sidebar = view
    this.setup(view.webview, 'mini')
    view.onDidDispose(() => (this.sidebar = null))
  }

  /** True while the big office panel is the focused editor tab. */
  get isPanelActive(): boolean {
    return !!this.panel?.active
  }

  openPanel() {
    if (this.panel) return this.panel.reveal()
    this.panel = vscode.window.createWebviewPanel('pixelOffice.office', 'Pixel Office', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    })
    this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'office.svg')
    this.setup(this.panel.webview, 'full')
    this.panel.onDidDispose(() => (this.panel = null))
  }

  post(v: ViewState) {
    this.last = v
    void this.panel?.webview.postMessage(v)
    void this.sidebar?.webview.postMessage(v)
  }

  private setup(webview: vscode.Webview, mode: 'full' | 'mini') {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    }
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'office.css'))
    webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${style}"></head>
<body class="mode-${mode}"><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
    webview.onDidReceiveMessage(raw => {
      const m = parseFromWebview(raw)
      if (m) this.onMessage(m)
    })
    if (this.last) void webview.postMessage(this.last)
  }
}
