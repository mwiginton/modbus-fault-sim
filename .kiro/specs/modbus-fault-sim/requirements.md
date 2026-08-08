# Requirements Document

## Introduction

A fault-injecting Modbus TCP device simulator delivered as a Node.js CLI tool. It reads a YAML configuration describing virtual Modbus slave devices, serves them over TCP, and injects protocol-level faults on a configurable timeline. The target audience is developers writing software that polls industrial equipment, enabling them to test failure modes (frozen registers, slow responses, dropped connections, exception codes) that are impractical to reproduce with real hardware.

## Glossary

- **System**: The modbus-fault-sim CLI application
- **Client**: Any Modbus TCP master that connects to the System over TCP
- **Device**: A virtual Modbus slave identified by a unit ID, containing a set of registers
- **Register**: A named addressable data location within a Device, holding a typed value
- **Register_Map**: The set of valid register addresses for a given Device
- **MBAP_Header**: The 7-byte Modbus Application Protocol header preceding every PDU
- **PDU**: Protocol Data Unit; the function-code-specific payload following the MBAP header
- **Behavior**: A value generator (sine, ramp, constant) attached to a Register that produces time-varying values
- **Fault**: A protocol-level disruption (freeze, delay, drop, exception) activated at a scheduled time
- **Scenario**: An ordered list of timed Fault activations that execute relative to server start
- **Configuration_File**: A YAML file defining listen parameters, devices, registers, and a scenario
- **Wire_Address**: The zero-based register address transmitted on the wire (documentation address minus 40001)
- **Parser**: The module that reads and validates Configuration_File YAML into internal data structures
- **Pretty_Printer**: The module that serializes internal configuration structures back to valid YAML

## Requirements

### Requirement 1: FC 03 Read Holding Registers Response

**User Story:** As a developer testing Modbus polling code, I want the simulator to respond correctly to FC 03 requests, so that my client code exercises the standard read path.

#### Acceptance Criteria

1. WHEN a Client sends a valid FC 03 request to a configured Device, THE System SHALL respond with a frame containing the echoed transaction ID, the echoed unit ID, function code 0x03, a byte count equal to twice the requested quantity, and the current values of the requested registers in big-endian order.
2. WHEN an FC 03 request specifies a quantity outside 1 to 125, THE System SHALL respond with an exception frame containing function code 0x83 and exception code 03 (Illegal Data Value).
3. IF a request addresses a unit ID that does not match any configured Device, THEN THE System SHALL not send any response to that request.

### Requirement 2: FC 06 Write Single Register Response

**User Story:** As a developer testing Modbus write operations, I want the simulator to accept and echo single-register writes, so that my client code exercises the standard write path.

#### Acceptance Criteria

1. WHEN a Client sends a valid FC 06 request, THE System SHALL update the target register to the supplied value and respond with a PDU that echoes the function code, register address, and value from the request.
2. WHEN a Client sends a valid FC 06 request, THE System SHALL persist the written value such that a subsequent FC 03 read of the same register returns the new value.
3. IF an FC 06 request targets a register declared as type float32, THEN THE System SHALL respond with an exception frame containing exception code 02 (Illegal Data Address).

### Requirement 3: FC 16 Write Multiple Registers Response

**User Story:** As a developer testing batch write operations, I want the simulator to accept multi-register writes and respond correctly, so that my client code exercises the bulk write path.

#### Acceptance Criteria

1. WHEN a Client sends a valid FC 16 request with quantity between 1 and 123, THE System SHALL write all supplied values to the target registers and respond with a frame containing function code 0x10, the echoed start address, and the echoed quantity.
2. WHEN an FC 16 request specifies a quantity outside 1 to 123, THE System SHALL respond with an exception frame containing exception code 03 (Illegal Data Value).
3. IF an FC 16 request byte count field does not equal twice the specified quantity, THEN THE System SHALL respond with an exception frame containing exception code 03 (Illegal Data Value).

### Requirement 4: MBAP Header Framing

**User Story:** As a developer relying on correct framing, I want the simulator to produce valid MBAP headers, so that my client's frame parser works without modification.

#### Acceptance Criteria

1. THE System SHALL set the MBAP length field to the count of bytes following it, comprising the unit ID byte and the PDU, encoded as a big-endian unsigned 16-bit integer.
2. THE System SHALL echo the transaction ID from the request in every response frame, preserving the original two bytes without modification.
3. THE System SHALL set the protocol ID to 0x0000 in every response frame.
4. THE System SHALL echo the unit ID from the request in every response frame.
5. IF a request arrives with a protocol ID other than 0x0000, THEN THE System SHALL silently discard the frame without sending a response.

### Requirement 5: Unsupported Function Code Exception

**User Story:** As a developer testing error handling, I want the simulator to reject unsupported function codes with the correct exception, so that my client code exercises the exception path.

#### Acceptance Criteria

1. WHEN a Client sends a request with a function code other than 03, 06, or 16, THE System SHALL respond with a 9-byte exception frame containing the MBAP header, the received function code OR'd with 0x80, and exception code 01 (Illegal Function).
2. IF a Client sends a request whose PDU is fewer than 1 byte after the MBAP header, THEN THE System SHALL close the connection without sending a response.

### Requirement 6: Illegal Data Address Exception

**User Story:** As a developer testing boundary conditions, I want the simulator to reject out-of-range register addresses, so that my client handles address errors correctly.

#### Acceptance Criteria

1. WHEN a request references any Wire_Address that is not present in the target Device Register_Map, THE System SHALL respond with an exception frame containing the request's function code plus 0x80 and exception code 02 (Illegal Data Address).
2. WHEN a multi-register request (FC 03 or FC 16) specifies a start address and quantity such that any address in the range [start_address, start_address + quantity - 1] falls outside the Device Register_Map, THE System SHALL respond with an exception frame containing exception code 02 (Illegal Data Address).
3. IF a single-register request (FC 06) targets a Wire_Address not present in the Device Register_Map, THEN THE System SHALL respond with an exception frame containing exception code 02 (Illegal Data Address).

### Requirement 7: Configuration File Parsing

**User Story:** As a developer setting up test scenarios, I want to define devices and faults in a YAML file, so that I can version-control and share my test configurations.

#### Acceptance Criteria

1. WHEN a valid Configuration_File is provided, THE Parser SHALL load the listen host and port, at least one Device with its unit ID and registers, any declared Behaviors, and all Scenario entries into internal data structures that the System can use to start serving.
2. WHEN an invalid Configuration_File is provided, THE Parser SHALL return an error message that includes the name or path of the invalid field and a reason for the failure, such that a developer can locate and correct the problem without inspecting source code.
3. IF the Configuration_File contains a syntactically invalid YAML document, a missing required field (listen, devices, or scenario), a value of the wrong type, or a reference to an undefined device or register, THEN THE Parser SHALL reject the file and report each distinct validation failure separately.
4. THE Pretty_Printer SHALL serialize internal configuration structures back to valid YAML that the Parser can re-read.
5. FOR ALL valid configuration structures, parsing the output of the Pretty_Printer SHALL produce a structure that is deeply equal to the original (all field names, values, and collection orderings are preserved).

### Requirement 8: Documentation Address Base Conversion

**User Story:** As a developer familiar with PLC documentation conventions, I want to use 40001-style addresses in my config, so that register addresses match vendor manuals.

#### Acceptance Criteria

1. WHEN the Configuration_File declares address_base as "documentation", THE System SHALL subtract 40001 from each declared register address to derive the Wire_Address, accepting any declared address that is at least 40001.
2. IF the Configuration_File does not declare an address_base field, THEN THE System SHALL treat declared register addresses as zero-based Wire_Addresses with no conversion applied.
3. IF address_base is "documentation" and a declared register address is less than 40001, THEN THE System SHALL reject the Configuration_File with an error message identifying the invalid address and stating that documentation addresses must be at least 40001.

### Requirement 9: Overlapping Address Validation

**User Story:** As a developer authoring configurations, I want immediate feedback if two registers collide, so that I don't waste time debugging phantom data.

#### Acceptance Criteria

1. WHEN two registers on the same Device claim overlapping Wire_Address ranges (where a register's range is its starting Wire_Address through starting Wire_Address plus word count minus one), THE System SHALL reject the Configuration_File at load time with an error message naming both registers and their conflicting addresses.
2. IF more than one pair of registers overlap on the same Device, THEN THE System SHALL report all detected overlaps in the error output rather than stopping at the first conflict.
3. WHEN a float32 register occupies two consecutive Wire_Addresses, THE System SHALL treat both addresses as claimed by that register for the purpose of overlap detection.

### Requirement 10: Float32 Register Type

**User Story:** As a developer testing code that reads 32-bit floating point values from PLCs, I want the simulator to encode float32 across two registers, so that my client exercises multi-register decoding.

#### Acceptance Criteria

1. WHEN a register declares type float32, THE System SHALL occupy two consecutive register addresses (N and N+1) and encode the value as IEEE 754 single-precision with the high word at address N and the low word at address N+1 (big-endian word order).
2. WHEN a Client reads a range that includes one or both words of a float32 register, THE System SHALL return the individual 16-bit word values at each requested address within the range.
3. WHEN a Client sends an FC 16 request writing exactly two registers starting at the base address of a float32 register, THE System SHALL decode the written words as an IEEE 754 single-precision value and update the register.
4. IF a Client sends an FC 06 request targeting any address occupied by a float32 register, THEN THE System SHALL respond with an exception frame containing exception code 02 (Illegal Data Address).

### Requirement 11: Sine Behavior

**User Story:** As a developer testing time-varying signals, I want a register to oscillate sinusoidally, so that my polling code sees realistic changing values.

#### Acceptance Criteria

1. WHILE a register has a sine Behavior, THE System SHALL compute the register value using the formula: value = midpoint + amplitude × sin(2π × elapsed_ms / period_ms), where midpoint = (minimum + maximum) / 2, amplitude = (maximum − minimum) / 2, and elapsed_ms is the number of milliseconds since the Behavior was started.
2. WHILE a register has a sine Behavior, THE System SHALL begin oscillation at the midpoint rising (phase offset of 0), such that the value equals the midpoint at elapsed_ms = 0 and first reaches the maximum at one quarter period.
3. WHILE a register has a sine Behavior, THE System SHALL repeat the oscillation continuously with no limit on cycle count, restarting the waveform seamlessly at each period boundary.
4. WHILE a register with an integer type (uint16) has a sine Behavior, THE System SHALL round the computed value to the nearest integer using half-up rounding before returning it.

### Requirement 12: Ramp Behavior

**User Story:** As a developer testing trending values, I want a register to ramp linearly over time, so that my client code exercises trend detection logic.

#### Acceptance Criteria

1. WHILE a register has a ramp Behavior, THE System SHALL compute the current value as start + (end − start) × (elapsed / duration), where elapsed is the time since server start, truncating to the nearest integer toward zero, and SHALL return that value in read responses.
2. WHILE a register has a ramp Behavior and the elapsed time since server start exceeds the configured duration, THE System SHALL return the configured end value in all subsequent read responses.
3. IF a ramp Behavior is configured with a start value greater than the end value, THEN THE System SHALL ramp downward using the same linear formula, producing decreasing values from start to end over the configured duration.

### Requirement 13: Freeze Register Fault

**User Story:** As a developer testing stale-data detection, I want a fault that locks a register's value, so that my client code can detect when a sensor stops updating.

#### Acceptance Criteria

1. WHEN a freeze_register Fault is activated on a register, THE System SHALL capture the register's current value and return that captured value in all subsequent read responses for that register until the Fault is deactivated.
2. WHILE a freeze_register Fault is active on a register, THE System SHALL ignore write requests targeting that register and respond as if the write succeeded.
3. WHEN a freeze_register Fault is deactivated, THE System SHALL resume returning live values from the register's configured Behavior or last written value.
4. WHILE a freeze_register Fault is active on a register that is part of a multi-register read, THE System SHALL return the frozen value for the affected register and live values for all non-frozen registers in the same response.

### Requirement 14: Slow Response Fault

**User Story:** As a developer testing timeout handling, I want a fault that delays responses, so that my client code exercises its timeout and retry logic.

#### Acceptance Criteria

1. WHEN a slow_response Fault is active on a Device, THE System SHALL delay each response to that Device by the configured delay interval (between 1 ms and 60 000 ms inclusive) before sending an otherwise correct frame.
2. IF a slow_response Fault specifies a duration, THEN THE System SHALL deactivate the Fault after the configured duration elapses from activation, resuming normal response timing for subsequent requests.
3. IF a slow_response Fault does not specify a duration, THEN THE System SHALL keep the Fault active until the Scenario ends or the server is stopped.
4. IF multiple requests arrive on the same Device while the slow_response Fault is active, THEN THE System SHALL apply the configured delay independently to each response.

### Requirement 15: Connection Drop Fault

**User Story:** As a developer testing reconnection logic, I want a fault that abruptly closes connections, so that my client code exercises its reconnection and request-retry paths.

#### Acceptance Criteria

1. WHEN a connection_drop Fault fires, THE System SHALL immediately close all open TCP connections to the affected Device without sending a response to any in-flight request and without performing a graceful TCP shutdown sequence.
2. WHEN a connection_drop Fault has fired, THE System SHALL continue accepting new TCP connections to the affected Device within 100 milliseconds of closing the existing connections.

### Requirement 16: Scenario Timeline Execution

**User Story:** As a developer orchestrating complex test sequences, I want faults to activate at specified offsets from server start, so that I can script reproducible failure scenarios.

#### Acceptance Criteria

1. WHEN a Scenario timeline entry reaches its configured offset (specified in milliseconds) from server start, THE System SHALL activate the specified Fault within 50 ms of the target time.
2. WHEN multiple Scenario timeline entries are defined, THE System SHALL activate them in chronological order of their offsets; entries with equal offsets SHALL activate in their declared order within the Configuration_File.
3. WHEN a Fault is activated via the Scenario, THE System SHALL emit a line to stdout containing the elapsed time in milliseconds since server start, the fault type, and the target Device or register identifier.
4. IF a Scenario timeline entry references a Fault type or target that does not exist in the Configuration_File, THEN THE System SHALL reject the Configuration_File at load time with an error message identifying the invalid entry.

### Requirement 17: CLI Entrypoint

**User Story:** As a developer, I want to start the simulator from the command line with a path to a config file, so that I can integrate it into my test scripts.

#### Acceptance Criteria

1. WHEN the user invokes the CLI with a path to a Configuration_File, THE System SHALL load the configuration, start listening on the configured host and port, print a ready message to stdout indicating the listening host and port, and begin the Scenario timeline.
2. IF the specified Configuration_File does not exist, THEN THE System SHALL print an error message to stderr identifying the missing file and exit with a non-zero exit code.
3. IF the specified Configuration_File fails validation, THEN THE System SHALL print the validation errors to stderr and exit with a non-zero exit code.
4. IF the user invokes the CLI without providing a Configuration_File path, THEN THE System SHALL print a usage message to stderr and exit with a non-zero exit code.
5. WHEN the System receives SIGINT or SIGTERM, THE System SHALL close all open TCP connections within 5 seconds; IF connections cannot be closed cleanly within 5 seconds, THE System SHALL force-terminate all connections and exit with code 0 regardless.
6. IF the System is in the process of exiting due to a validation error and receives SIGINT or SIGTERM, THEN THE System SHALL exit with code 0.
