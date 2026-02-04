# OriJS Benchmarks

Performance benchmarks for the OriJS framework.

## Quick Start

```bash
# Run all benchmarks
bun benchmarks/run-all.ts

# Run individual benchmarks
bun benchmarks/scenarios/raw-bun.ts        # Raw Bun.serve baseline
bun benchmarks/scenarios/orijs-minimal.ts   # OriJS minimal endpoint
bun benchmarks/scenarios/orijs-guards.ts    # OriJS with guards/context
bun benchmarks/scenarios/logging.ts         # Logger performance
```

## Scenarios

| Scenario           | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `raw-bun.ts`       | Raw Bun.serve baseline - no framework overhead                 |
| `orijs-minimal.ts` | Minimal OriJS app with simple health endpoint                  |
| `orijs-guards.ts`  | Full middleware stack with guards, query parsing, body parsing |
| `logging.ts`       | Logger async buffering vs sync performance                     |

## CPU Profiling

Generate CPU profiles with Bun's built-in profiler:

```bash
# Generate .cpuprofile file
bun --cpu-prof benchmarks/scenarios/orijs-minimal.ts

# Profiles are saved to current directory as CPU.*.cpuprofile
# Open in Chrome DevTools (Performance tab) or VS Code
```

## Expected Results

On a typical development machine:

| Scenario          | Throughput      |
| ----------------- | --------------- |
| Raw Bun           | ~45-50k req/sec |
| OriJS Minimal     | ~38-42k req/sec |
| OriJS with Guards | ~33-38k req/sec |
| Async Logging     | ~900k logs/sec  |

Framework overhead vs raw Bun is typically ~15%.

## Configuration

Benchmarks use these defaults:

- **Total Requests**: 10,000-20,000
- **Concurrency**: 50 parallel requests
- **Warmup**: 10 iterations before measurement

Modify options in individual scenario files or use `runner.ts` utilities.

## Structure

```
benchmarks/
├── README.md           # This file
├── runner.ts           # Shared benchmark utilities
├── run-all.ts          # Run all benchmarks
└── scenarios/          # Individual benchmark scripts
    ├── raw-bun.ts
    ├── orijs-minimal.ts
    ├── orijs-guards.ts
    └── logging.ts
```
