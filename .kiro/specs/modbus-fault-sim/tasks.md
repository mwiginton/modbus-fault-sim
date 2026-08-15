# Implementation Plan: modbus-fault-sim

## Overview

Bottom-up implementation of a fault-injecting Modbus TCP device simulator. Tasks are ordered by dependency: foundational protocol utilities first, then configuration and signals, then faults, then server and CLI wiring. Each task includes property-based tests (TDD style) alongside implementation.

## Tasks

- [x] 1. Protocol layer foundations
  - [x] 1.1 Implement frame-builder module
    - Create `src/protocol/frame-builder.ts`
    - Implement `buildResponse(opts, pdu)` that constructs a complete Modbus TCP response frame with correct MBAP header (transaction ID echo, protocol ID 0x0000, length field, unit ID echo)
    - Implement `buildException(opts, functionCode, exceptionCode)` that produces a 9-byte exception frame
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 6.1_

  - [x] 1.2 Write property tests for frame-builder (Property 1: MBAP Header Invariants)
    - **Property 1: MBAP Header Invariants**
    - Create `tests/protocol/frame-builder.test.ts`
    - For any valid request parameters, verify response frame has correct transaction ID echo, protocol ID 0x0000, correct length field, and correct unit ID
    - Use `fc.nat(65535)` for transaction IDs, `fc.nat(255)` for unit IDs, `fc.uint8Array` for PDUs
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [x] 1.3 Implement frame-parser module
    - Create `src/protocol/frame-parser.ts`
    - Implement `FrameParser` class with `feed(data: Buffer): ModbusRequest[]` that accumulates TCP bytes and extracts complete frames using the MBAP length field
    - Handle partial frames (buffer until complete), coalesced frames (multiple frames in one chunk), protocol ID validation (discard non-0x0000), and PDU length check (close if < 1 byte after header)
    - Implement `reset()` for connection cleanup
    - _Requirements: 4.1–4.5, 5.2_

  - [x] 1.4 Write property tests for frame-parser (Properties 2, 3)
    - **Property 2: Non-Zero Protocol ID Discards**
    - **Property 3: Unknown Unit ID Discards** (tested at router level, but parser validates protocol ID)
    - Create `tests/protocol/frame-parser.test.ts`
    - Verify that frames with protocol ID ≠ 0x0000 are discarded
    - Verify that valid frames are correctly parsed regardless of chunking
    - **Validates: Requirements 4.5, 5.2**

  - [x] 1.5 Implement float32 encoding utilities
    - Create `src/protocol/float32.ts`
    - Implement `float32ToWords(value): [highWord, lowWord]` and `wordsToFloat32(high, low): number`
    - IEEE 754 single-precision, big-endian word order (high word at address N, low word at N+1)
    - _Requirements: 10.1, 10.3_

  - [x] 1.6 Write property tests for float32 encoding (Property 19)
    - **Property 19: Float32 Encoding Round Trip**
    - Create `tests/protocol/float32.test.ts`
    - For any IEEE 754 representable float32 (no NaN/Infinity), encoding to words and decoding back produces bitwise identical value
    - **Validates: Requirements 10.1, 10.3**

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Configuration layer
  - [x] 3.1 Define configuration schema types
    - Create `src/config/schema.ts`
    - Define TypeScript interfaces: `ConfigFile`, `ListenConfig`, `DeviceConfig`, `RegisterConfig`, `BehaviorConfigYaml`, `ScenarioEntryConfig`
    - Define `ValidationError` interface with `path` and `message` fields
    - _Requirements: 7.1_

  - [x] 3.2 Implement configuration validator
    - Create `src/config/validator.ts`
    - Implement `validateConfig(raw: unknown): ConfigFile | ValidationError[]`
    - Validate required fields (listen, devices, scenario), type checks, address base conversion, overlap detection, scenario reference validation
    - Collect all errors (don't fail on first)
    - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 16.4_

  - [x] 3.3 Write property tests for address conversion (Properties 16, 17)
    - **Property 16: Address Base Conversion**
    - **Property 17: Documentation Address Rejection**
    - Create `tests/config/validator.test.ts`
    - For any address A ≥ 40001 with `addressBase: 'documentation'`, wire address equals A - 40001
    - For any address A < 40001 with `addressBase: 'documentation'`, validator rejects
    - For any address A with `addressBase: 'zero'` or absent, wire address equals A
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [x] 3.4 Write property tests for overlap detection (Property 18)
    - **Property 18: Overlap Detection Completeness**
    - Add to `tests/config/validator.test.ts`
    - For any set of registers with N overlapping pairs (float32 claims 2 addresses), validator reports exactly those N overlaps
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 3.5 Write property tests for scenario validation (Property 34)
    - **Property 34: Scenario Entry Validation**
    - Add to `tests/config/validator.test.ts`
    - For any scenario entry with invalid fault type or non-existent target, validator rejects with identifying error
    - **Validates: Requirements 16.4**

  - [x] 3.6 Implement configuration loader
    - Create `src/config/loader.ts`
    - Implement `loadConfig(filePath: string): ConfigFile | ValidationError[]`
    - Read YAML file using `yaml` package, pass to validator, return result
    - Handle file-not-found and YAML syntax errors
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Signal generators and register store
  - [x] 5.1 Implement behavior value computation
    - Create `src/signals/behaviors.ts`
    - Implement `computeSine(params, elapsedMs)`: midpoint + amplitude × sin(2π × elapsed / period)
    - Implement `computeRamp(params, elapsedMs)`: linear interpolation, clamped at end, truncated toward zero
    - Implement `computeBehaviorValue(config, elapsedMs)` dispatcher
    - _Requirements: 11.1–11.4, 12.1–12.3_

  - [x] 5.2 Write property tests for sine behavior (Properties 21, 22, 23, 24)
    - **Property 21: Sine Behavior Formula**
    - **Property 22: Sine Behavior Periodicity**
    - **Property 23: Sine Behavior Initial Conditions**
    - **Property 24: Sine Integer Rounding**
    - Create `tests/signals/sine.test.ts`
    - Verify formula correctness, periodicity (value at T equals value at T + period), initial conditions (midpoint at T=0, max at T=period/4), and Math.round for uint16
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**

  - [x] 5.3 Write property tests for ramp behavior (Properties 25, 26)
    - **Property 25: Ramp Behavior Formula**
    - **Property 26: Ramp Behavior Clamping**
    - Create `tests/signals/ramp.test.ts`
    - Verify linear formula with Math.trunc, and clamping to end value after duration
    - **Validates: Requirements 12.1, 12.2, 12.3**

  - [x] 5.4 Implement register store
    - Create `src/signals/register-store.ts`
    - Implement `RegisterStore` class with injectable clock
    - Support `readRegisters`, `writeSingle`, `writeMultiple` with address validation
    - Handle uint16 and float32 types (float32 occupies two consecutive slots)
    - Implement `freeze`/`unfreeze` for fault integration
    - Apply behaviors when computing current values
    - _Requirements: 1.1, 2.1, 2.2, 3.1, 10.1–10.4, 13.1–13.4_

  - [x] 5.5 Write property tests for register store (Properties 7, 19, 20, 27, 28, 29, 30)
    - **Property 7: FC 06 Write-Then-Read Round Trip**
    - **Property 20: Float32 Read Consistency**
    - **Property 27: Freeze Captures and Holds Value**
    - **Property 28: Freeze Ignores Writes**
    - **Property 29: Freeze-Unfreeze Round Trip**
    - **Property 30: Partial Freeze in Multi-Register Read**
    - Create `tests/signals/register-store.test.ts`
    - Test write/read round trips, float32 encoding via store, freeze/unfreeze behavior
    - **Validates: Requirements 2.2, 10.1, 10.2, 13.1, 13.2, 13.3, 13.4**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Function code handlers and router
  - [x] 7.1 Implement FC 03 handler
    - Create `src/protocol/handlers/fc03.ts`
    - Implement `handleReadHoldingRegisters(request, store): RouteResult`
    - Validate quantity in [1, 125], validate address range, read values from store
    - Return PDU: `03 | byteCount | values...` or exception
    - _Requirements: 1.1, 1.2, 6.2_

  - [x] 7.2 Write property tests for FC 03 (Properties 4, 5, 14)
    - **Property 4: FC 03 Response Structure**
    - **Property 5: FC 03 Quantity Validation**
    - **Property 14: Multi-Register Range Validation**
    - Create `tests/protocol/fc03.test.ts`
    - Verify correct response structure, exception on invalid quantity, exception on out-of-range addresses
    - **Validates: Requirements 1.1, 1.2, 6.2**

  - [x] 7.3 Implement FC 06 handler
    - Create `src/protocol/handlers/fc06.ts`
    - Implement `handleWriteSingleRegister(request, store): RouteResult`
    - Validate address exists and is not float32, write value, echo request PDU
    - _Requirements: 2.1, 2.2, 2.3, 6.3_

  - [x] 7.4 Write property tests for FC 06 (Properties 6, 8, 13)
    - **Property 6: FC 06 Echo Response**
    - **Property 8: FC 06 Float32 Rejection**
    - **Property 13: Invalid Address Exception**
    - Create `tests/protocol/fc06.test.ts`
    - Verify echo response, float32 rejection with exception code 02, and invalid address exception
    - **Validates: Requirements 2.1, 2.3, 6.3, 10.4**

  - [x] 7.5 Implement FC 16 handler
    - Create `src/protocol/handlers/fc16.ts`
    - Implement `handleWriteMultipleRegisters(request, store): RouteResult`
    - Validate quantity in [1, 123], validate byte count = 2 × quantity, validate address range, write values
    - _Requirements: 3.1, 3.2, 3.3, 6.2_

  - [x] 7.6 Write property tests for FC 16 (Properties 9, 10, 11)
    - **Property 9: FC 16 Response Structure**
    - **Property 10: FC 16 Quantity Validation**
    - **Property 11: FC 16 Byte Count Consistency**
    - Create `tests/protocol/fc16.test.ts`
    - Verify correct response structure, quantity validation, and byte count consistency check
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 7.7 Implement router
    - Create `src/protocol/router.ts`
    - Implement `route(request, devices): RouteResult`
    - Handle: unit ID not found → discard, protocol ID ≠ 0x0000 → discard, PDU < 1 byte → close, unsupported FC → exception 01, valid → dispatch to handler
    - _Requirements: 1.3, 4.5, 5.1, 5.2_

  - [x] 7.8 Write property tests for router (Properties 3, 12)
    - **Property 3: Unknown Unit ID Discards**
    - **Property 12: Unsupported Function Code Exception**
    - Create `tests/protocol/router.test.ts`
    - Verify unknown unit ID produces discard, unsupported FC produces 9-byte exception with code 01
    - **Validates: Requirements 1.3, 5.1**

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Fault injection layer
  - [x] 9.1 Implement fault engine
    - Create `src/faults/fault-engine.ts`
    - Implement `FaultEngine` class with `activate`, `tick`, `applyFaults`, `isFrozen`
    - Handle freeze_register (delegate to register store), slow_response (delay via setTimeout), connection_drop (close sockets)
    - Track active faults per device/register, handle duration-based expiry
    - _Requirements: 13.1–13.4, 14.1–14.4, 15.1–15.2_

  - [ ]* 9.2 Write property tests for fault engine (Properties 31, 32)
    - **Property 31: Slow Response Delay Application**
    - **Property 32: Slow Response Duration Expiry**
    - Create `tests/faults/fault-engine.test.ts`
    - Verify delay is applied correctly via injectable clock, and fault deactivates after duration
    - **Validates: Requirements 14.1, 14.2**

  - [ ] 9.3 Implement scenario scheduler
    - Create `src/faults/scenario-scheduler.ts`
    - Implement `ScenarioScheduler` class with `start()` and `stop()`
    - Sort entries by offset (stable sort preserving declaration order for ties)
    - Schedule activations via setTimeout, log to stdout on fire
    - Schedule deactivation if duration is specified
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ]* 9.4 Write property tests for scenario scheduler (Property 33)
    - **Property 33: Scenario Activation Order**
    - Create `tests/faults/scenario-scheduler.test.ts`
    - Verify faults activate in ascending offset order, ties in declaration order
    - Use fake timers for deterministic testing
    - **Validates: Requirements 16.2**

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Server and connection handling
  - [x] 11.1 Implement TCP server
    - Create `src/server/tcp-server.ts`
    - Implement `TcpServer` class wrapping `net.Server`
    - Support `start()`, `stop()`, `closeAllConnections()`
    - Accept new connections within 100ms after closing existing ones (for connection_drop fault)
    - _Requirements: 15.1, 15.2, 17.1, 17.5_

  - [x] 11.2 Implement connection handler
    - Create `src/server/connection-handler.ts`
    - Implement `handleConnection(socket, devices, faultEngine)`
    - Feed data to FrameParser, route frames, apply faults, send responses via frame-builder
    - Handle socket errors gracefully (log, clean up, continue)
    - _Requirements: 1.1, 1.3, 4.1–4.5, 5.1, 5.2_

  - [ ]* 11.3 Write integration tests for connection drop fault
    - Create `tests/integration/connection-drop.test.ts`
    - Test that connection_drop fault closes all TCP connections without graceful shutdown
    - Verify new connections accepted within 100ms
    - **Validates: Requirements 15.1, 15.2**

- [ ] 12. CLI entrypoint and wiring
  - [ ] 12.1 Implement CLI entrypoint
    - Create `src/cli.ts`
    - Parse command-line arguments (config file path)
    - Load and validate config, start TCP server, print ready message, begin scenario
    - Handle SIGINT/SIGTERM: cancel timers, close connections with 5s grace period, exit 0
    - Handle error cases: missing file, validation failure, no arguments → stderr + exit 1
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

  - [ ]* 12.2 Write unit tests for CLI error cases
    - Create `tests/integration/cli.test.ts`
    - Test: missing file → stderr + exit 1, invalid config → stderr + exit 1, no arguments → usage message + exit 1
    - **Validates: Requirements 17.2, 17.3, 17.4**

- [ ] 13. Example configurations and end-to-end verification
  - [ ] 13.1 Create example YAML configurations
    - Create `examples/basic.yaml` — simple single-device config with a few registers
    - Create `examples/fault-scenario.yaml` — multi-device config with freeze, slow response, and connection drop faults on a timeline
    - Demonstrate documentation addressing, float32 registers, sine and ramp behaviors
    - _Requirements: 7.1, 8.1_

  - [ ]* 13.2 Write end-to-end integration tests
    - Create `tests/integration/end-to-end.test.ts`
    - Start server with example config, send real Modbus TCP frames via `net.Socket`, verify correct responses
    - Test scenario execution: verify faults activate at correct times with correct log output
    - **Validates: Requirements 1.1, 4.1, 16.1, 16.3, 17.1**

- [ ] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All time-dependent code uses an injectable clock for deterministic testing
- fast-check is the approved PBT library (add to devDependencies when implementing first PBT task)
- TDD approach: write tests alongside or before implementation

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.5", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.6", "5.1"] },
    { "id": 2, "tasks": ["1.4", "3.2", "5.2", "5.3"] },
    { "id": 3, "tasks": ["3.3", "3.4", "3.5", "3.6", "3.7", "5.4"] },
    { "id": 4, "tasks": ["3.8", "5.5", "7.1", "7.3", "7.5"] },
    { "id": 5, "tasks": ["7.2", "7.4", "7.6", "7.7"] },
    { "id": 6, "tasks": ["7.8", "9.1"] },
    { "id": 7, "tasks": ["9.2", "9.3"] },
    { "id": 8, "tasks": ["9.4", "11.1"] },
    { "id": 9, "tasks": ["11.2", "11.3"] },
    { "id": 10, "tasks": ["12.1"] },
    { "id": 11, "tasks": ["12.2", "13.1"] },
    { "id": 12, "tasks": ["13.2"] }
  ]
}
```
