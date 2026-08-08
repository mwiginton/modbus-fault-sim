---
inclusion: always
---
# Project Structure

- src/protocol/   frame encoding and decoding, function code handlers
- src/config/     YAML schema, loading, validation
- src/signals/    value generators
- src/faults/     fault definitions and the injection layer
- src/server/     TCP listener and connection handling
- tests/          mirrors src/ structure, one test file per module
- examples/       runnable YAML configurations

Naming: files kebab-case, types PascalCase, functions camelCase.
Each module exports a narrow public surface; no barrel files.