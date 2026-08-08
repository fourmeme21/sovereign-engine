# Sovereign Engine

Sovereign Engine is a local-first, agentic runtime built in Rust. It executes transient, self-organizing code blocks with a deterministic compiler-feedback loop via Tauri IPC and Supabase.

## Architecture
Intent -> Dynamic Code Generation -> Compiler Feedback Loop -> Transient Execution -> Memory Pruning


## Core Features
- **Local-First Sovereign Execution:** Zero cloud lock-in for runtime logic.
- **Compiler Feedback Loop:** Native Rust/TypeScript compiler outputs are fed back to the context window for self-healing synthesis.
- **Ephemeral Logic Modules:** Code generated for intent is executed and pruned post-execution, preventing runtime bloat.

## Quick Start
```bash
cargo build --release
cargo run
