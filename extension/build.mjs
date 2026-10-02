// Bundles the extension host code and the webview, and copies the mod in so the VSIX carries it.
import { build } from 'esbuild'
import { cpSync, rmSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' }
await build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] })
await build({ ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' })

rmSync('mod', { recursive: true, force: true })
mkdirSync('mod', { recursive: true })
for (const p of ['.claude-plugin/plugin.json', 'hooks', 'sounds', 'types']) cpSync(`../pixel-office/${p}`, `mod/${p}`, { recursive: true })
cpSync('../pixel-office/sounds/chime.wav', 'media/chime.wav')
if (watch) console.log('built (watch mode is not implemented: re-run on change)')
