// Thin Vercel shim. Deliberately plain JS, not TypeScript: Vercel's function bundler only needs to
// bundle an already-compiled require() graph here, never re-transform Nest's decorator syntax
// (esbuild doesn't support emitDecoratorMetadata). The real logic is src/serverless.ts, compiled
// to dist/serverless.js by the normal `nest build` that runs in this project's buildCommand.
module.exports = require('../dist/serverless.js').default;
