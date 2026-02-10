# orijs-compile

**Status: Prototype** — This tool is not required to use OriJS. The framework works fully without it.

## What is this?

An AOT (ahead-of-time) compiler that generates optimized TypeScript route handlers at build time. It eliminates runtime conditionals from the request pipeline by generating route-specific handler functions.

Only consider this if you need extreme performance and want to remove per-request branching overhead from guard checks, schema validation, and interceptor chains.

## How it works

1. OriJS generates a `routes.json` manifest during a prebuild step
2. This tool reads the manifest and generates a `.ts` file with purpose-built handlers per route
3. Guard checks are unrolled (no loops), validation/interceptor blocks are omitted when not needed

## Usage

```bash
orijs-compile --manifest routes.json --out compiled-handlers.ts
```

## Requirements

- Rust toolchain (for building the compiler)
- OriJS application with route manifest generation
