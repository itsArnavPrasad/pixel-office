// Lets node:test import the TypeScript sources, whose relative imports omit the .ts extension.
import { registerHooks } from 'node:module'
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx)
    } catch (err) {
      if (spec.startsWith('.')) return next(`${spec}.ts`, ctx)
      throw err
    }
  },
})
