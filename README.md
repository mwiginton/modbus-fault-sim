# modbus-fault-sim

Testing Modbus client code against failure conditions is difficult, because real hardware does not fail on demand. This tool runs virtual Modbus TCP devices defined in a YAML file and injects faults on a schedule you control: freezing a register, delaying responses, dropping the connection, or returning an exception. Point your client at it to verify how your error handling behaves.

Built for the Ready, Spec, Ship hackathon using [Kiro](https://kiro.dev). See [How Kiro was used](#how-kiro-was-used).

---

## Quickstart

Requires Node.js 20 or later. No other runtime is needed.

You'll first run a healthy Modbus server with no faults using `examples/basic.yaml` to confirm correct protocol behavior, then run the fault scenario (`examples/fault-scenario.yaml`) to see how the simulator models problematic devices.

```bash
git clone https://github.com/mwiginton/modbus-fault-sim.git
cd modbus-fault-sim
npm install
npm run build
```

### 1. Run the basic simulator (no faults)

```bash
node dist/cli.js examples/basic.yaml
```

This starts a Modbus TCP server on `127.0.0.1:5020` with two virtual devices (unit IDs 1 and 2). You'll see startup output confirming the listener is ready. **Leave this running** — the next step connects to it from a separate terminal.

### 2. Verify with pymodbus (separate terminal)

The Python scripts in the `clients/` directory simulate a Modbus client connecting to the server. They exist solely for testing and verification — they are not part of the simulator itself.

Open a second terminal window, then:

```bash
python -m pip install -r clients/requirements.txt
python clients/verify.py
```

This exercises FC 03 reads (including float32 spanning two registers), FC 06/FC 16 writes with read-back, exception responses, a second device, and the silent discard of an unconfigured unit ID. It exits 0 on success and prints PASS/FAIL for each check.

The last check intentionally times out (a few seconds of silence) because the Modbus spec says unrecognized unit IDs get no response.

### 3. Watch fault injection in action

Stop the first server (Ctrl+C), then start the fault scenario:

```bash
node dist/cli.js examples/fault-scenario.yaml
```

In another terminal:

```bash
python clients/watch_faults.py
```

This polls once per second and prints what the client observes. You'll see:

- At ~10s: `discharge_pressure` freezes (reads succeed but value stops changing)
- At ~25s: `vibration_level` reads slow down (may time out with the 2s client timeout)
- At ~45s: connections to the heat exchanger drop (socket errors)
- At ~60s: `inlet_temp` freezes
- At ~90s: `rpm` reads slow down

Each fault activation and deactivation is also logged to stdout on the server side.

### 4. Run the unit tests

```bash
npm test
```

The test suite uses property-based testing with fast-check, generating randomized inputs on each run.

### What to look for

- `verify.py` proves the wire format is correct against a third-party implementation (pymodbus), not just self-consistent.
- `watch_faults.py` demonstrates the core value: you can observe how a client behaves when a register freezes (no error, just stale data), when responses slow down (timeout errors), and when connections drop (socket errors).
- The fault timeline in `examples/fault-scenario.yaml` is human-readable and fires exactly on schedule.

No Python is required to run the simulator itself — the pymodbus scripts are just for verification. Any Modbus TCP client (ModRSsim2, QModMaster, or a custom one) can connect to `127.0.0.1:5020`.

---

## The problem this solves

Software that polls industrial equipment is usually tested against the happy path, because that is the only path available. Getting a real PLC to freeze a register, stall for four seconds, or drop its connection means either breaking hardware you cannot afford to break or waiting for it to break on its own, in production, at 3am.

The result is that error handling in this domain is frequently written but rarely exercised. Two of the faults this tool injects produce no error at all on the client side. They produce wrong answers that look like right answers.

---

## Fault catalogue

| Fault | Protocol level | Client observes | Why it matters |
|---|---|---|---|
| **freeze_register** | Register stops updating; the server keeps returning the last value with a normal FC 03 response | Successful reads, valid data, no error. The value simply never changes | A stuck sensor or a stalled PLC scan cycle looks identical to a genuinely stable process. Historians record the flat line as real, alarm thresholds never trip because the value never crosses them, and nobody notices until a physical inspection. Almost no client code checks for staleness. |
| **slow_response** | The server delays the response by a configured interval before sending an otherwise correct frame | The read blocks. It may exceed the client timeout and surface as an error, or succeed very late | Congested industrial networks and overloaded PLCs do this constantly. Polling loops written without a timeout hang and take down the acquisition thread. Loops with a timeout but no backoff pile up retries and worsen the congestion. This is the fault that turns one slow device into a stalled poller for forty devices. |
| **connection_drop** | The server closes open TCP sockets without warning, while continuing to accept new connections | A socket error on the next read, or a half-open connection that appears alive but never responds | Switches reboot, cellular gateways drop, PLCs get power-cycled during maintenance. The bug this exposes is reconnect logic: code that reconnects without backoff hammers a recovering device, and code that does not reconnect goes silently dead until someone restarts the service. |
| **Exception responses** | The server returns a frame with the function code plus `0x80` and an exception code | An error response, if the client parses exceptions at all | Vendors implement inconsistent subsets of the spec and firmware updates change which codes are supported. Clients that do not check the high bit parse an exception frame as register data and produce garbage, because the byte layout superficially resembles a short read response. Silent corruption rather than a visible error. |

---

## Configuration reference

A configuration file has three top-level sections.

### listen

```yaml
listen:
  host: 127.0.0.1
  port: 5020
```

Port 5020 is used rather than the Modbus default of 502, which requires elevated privileges on most systems.

### devices

```yaml
devices:
  - name: pump-station-a
    unitId: 1
    addressBase: documentation
    registers:
      - name: flow_rate
        address: 40001
        type: float32
        initialValue: 52.5
        behavior:
          type: sine
          min: 20.0
          max: 85.0
          periodMs: 20000
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Used as a fault target and in log output |
| `unitId` | yes | Modbus slave address. Requests for an unconfigured unit ID are discarded silently, which is correct protocol behavior |
| `addressBase` | no | `documentation` or `zero`. Defaults to `zero` |
| `registers` | yes | At least one |

### Addressing

Modbus documentation conventionally numbers the first holding register 40001, while the wire address is `0x0000`. Setting `addressBase: documentation` on a device means addresses in the file are documentation-style and the simulator subtracts 40001 at load time.

With `addressBase: documentation`, a register declared at 40001 is read by clients at wire address 0.

Note that `addressBase` is set **per device**, not at the top level of the file.

### registers

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Used as a fault target in the form `deviceName.registerName` |
| `address` | yes | Documentation or wire address depending on `addressBase` |
| `type` | yes | `uint16` or `float32` |
| `initialValue` | yes | Value before any behavior is applied |
| `behavior` | no | Omit for a static register |

A `float32` register occupies two consecutive addresses, high word first. A register declared at 40001 as float32 therefore claims 40001 and 40002, and the next register must start at 40003. Overlapping claims are rejected at load time with an error naming both registers.

### behaviors

**sine** oscillates between `min` and `max` over `periodMs`. The value is at the midpoint at time zero and reaches maximum at one quarter of the period.

```yaml
behavior:
  type: sine
  min: 20.0
  max: 85.0
  periodMs: 20000
```

**ramp** interpolates linearly from `start` to `end` over `durationMs`, then holds at `end`.

```yaml
behavior:
  type: ramp
  start: 60
  end: 95
  durationMs: 45000
```

**constant** returns `value` unchanged.

```yaml
behavior:
  type: constant
  value: 120
```

### scenario

```yaml
scenario:
  - offsetMs: 8000
    fault: freeze_register
    target: pump-station-a.flow_rate

  - offsetMs: 18000
    fault: slow_response
    target: pump-station-a
    delayMs: 4000
    durationMs: 12000

  - offsetMs: 32000
    fault: connection_drop
    target: tank-level-b
```

| Field | Required | Notes |
|---|---|---|
| `offsetMs` | yes | Milliseconds after server start |
| `fault` | yes | `freeze_register`, `slow_response`, or `connection_drop` |
| `target` | yes | A device name, or `deviceName.registerName` for register-scoped faults |
| `delayMs` | for `slow_response` | Response delay |
| `durationMs` | no | Faults without a duration remain active until the server stops |

An empty scenario (`scenario: []`) is valid and runs the simulator with no faults.

---

## Supported function codes

| Code | Name | Notes |
|---|---|---|
| 03 | Read Holding Registers | Quantity 1 to 125 |
| 06 | Write Single Register | Rejected for `float32` registers, since a 16-bit write to half a float is meaningless |
| 16 (0x10) | Write Multiple Registers | Quantity 1 to 123, byte count must equal twice the quantity |

Exception responses use codes 01 (Illegal Function), 02 (Illegal Data Address), and 03 (Illegal Data Value).

Writes override a register's behavior for that register.

---

## Development

```bash
npm test          # run the test suite
npm run test:watch
npm run build
npm run dev       # TypeScript watch mode
```

The test suite is property-based, using [fast-check](https://github.com/dubzzz/fast-check). Rather than asserting specific input and output pairs, each test states a property that must hold across generated inputs: that the MBAP length field always equals the byte count following it, that float32 encoding round-trips bitwise, that a sine behavior's value at time T equals its value at T plus one period, that overlap detection reports exactly the number of overlapping register pairs present.

This suits protocol work, where the failure cases are boundary conditions that hand-written examples tend to miss.

### Project structure

```
src/protocol/    frame encoding and decoding, function code handlers, router
src/config/      YAML schema, loading, validation
src/signals/     value generators and the register store
src/faults/      fault engine and scenario scheduler
src/server/      TCP listener and connection handling
tests/           mirrors src/
examples/        runnable configurations
clients/         pymodbus verification scripts
```

---

## How Kiro was used

The `.kiro` directory is committed and contains the steering files and specs this project was built from.

### Steering

Three steering files were written by hand before any code existed, and loaded into every subsequent interaction:

- `tech.md` — runtime, test framework, and a rule requiring tests before implementation
- `structure.md` — module layout and naming conventions
- `modbus-protocol.md` — the MBAP header layout, function code PDU formats, exception codes, the project's addressing and endianness conventions, and worked hex examples used as test fixtures

The protocol steering file removed the need to restate wire format constraints in individual specs, and the worked examples in it were reused directly as test fixtures.

### Specs

The project was built from a spec generated through Kiro's Requirements-First workflow, starting from sixteen requirements written in EARS notation before the build window opened. The three spec artifacts are in `.kiro/specs/`:

- `requirements.md` — expanded EARS requirements with acceptance criteria
- `design.md` — architecture, module boundaries, and the properties the test suite verifies
- `tasks.md` — a dependency-ordered implementation plan, including an explicit task dependency graph

Kiro's **Analyze Requirements** step was run before approving the requirements, to surface gaps and ambiguities that had been missed in drafting.

The commit history shows spec artifacts committed separately from and prior to the implementation they describe.


---

## Limitations

- Modbus TCP only. Modbus RTU and serial transports are not implemented.
- Function codes 03, 06, and 16 only. Coils, discrete inputs, and input registers are not implemented.
- Register types are `uint16` and `float32`. Signed 16-bit registers are not yet supported.
- Float32 word order is big-endian only. Word-swapped devices exist in the field and are not currently configurable.
- Faults fire on a declared timeline. There is no runtime API for triggering them manually.

---

## Real-world deployment

The Python verification scripts exist for testing locally. In a production setting, this tool slots into several workflows where teams need repeatable, on-demand Modbus failure scenarios.

### CI/CD gate for SCADA/DCS client software

Run the simulator as a test fixture in your pipeline. A job starts `modbus-fault-sim` with a scenario YAML that covers the fault modes your client must handle, then runs your client's integration test suite against it. If the client hangs, crashes, or logs stale data without raising an alert, the pipeline fails. This is the highest-value use case: every merge request proves the error-handling paths still work, without touching real hardware.

```yaml
# Example GitHub Actions step
- name: Modbus fault integration test
  run: |
    node dist/cli.js test-fixtures/ci-scenario.yaml &
    SERVER_PID=$!
    sleep 2
    python tests/integration/poll_and_assert.py
    kill $SERVER_PID
```

### Hardware-in-the-loop test benches

Industrial teams often maintain a bench with a mix of real PLCs and simulators on the same network. Configure `modbus-fault-sim` to impersonate specific devices (matching their unit IDs and register maps) and inject faults that are difficult or dangerous to produce on the real equipment — sensor freeze, intermittent network congestion, or a controller that stops responding mid-poll. The test bench exercises the full acquisition stack (OPC-UA gateway, historian, alarm engine) under failure conditions without risking equipment.

### Operator and developer training

New team members can connect standard Modbus tools (QModMaster, ModRSsim2, or a custom HMI) to the simulator running a scripted fault timeline. Watching a register freeze without an error, or seeing the poller hang because it lacks a timeout, builds intuition about failure modes that text documentation alone cannot provide.

### Typical production configuration

A real deployment might model an entire process unit — pumps, heat exchangers, VFDs — as multiple devices with register maps that mirror the actual hardware. The YAML below sketches what this looks like:

```yaml
listen:
  host: 0.0.0.0    # bind to all interfaces so networked clients can reach it
  port: 502         # standard Modbus port (requires elevated privileges)

devices:
  - name: feed-pump-101
    unitId: 1
    addressBase: documentation
    registers:
      - name: discharge_pressure
        address: 40001
        type: float32
        initialValue: 145.2
        behavior: { type: sine, min: 130.0, max: 160.0, periodMs: 30000 }
      - name: motor_current
        address: 40003
        type: float32
        initialValue: 12.8
        behavior: { type: ramp, start: 12.0, end: 14.5, durationMs: 60000 }
      - name: status_word
        address: 40005
        type: uint16
        initialValue: 1

  - name: heat-exchanger-201
    unitId: 2
    addressBase: documentation
    registers:
      - name: inlet_temp
        address: 40001
        type: float32
        initialValue: 72.3
        behavior: { type: sine, min: 68.0, max: 78.0, periodMs: 45000 }
      - name: outlet_temp
        address: 40003
        type: float32
        initialValue: 55.1
        behavior: { type: sine, min: 50.0, max: 60.0, periodMs: 45000 }

scenario:
  # Simulate a pressure transmitter freeze after 5 minutes
  - offsetMs: 300000
    fault: freeze_register
    target: feed-pump-101.discharge_pressure

  # Network congestion on the heat exchanger after 10 minutes
  - offsetMs: 600000
    fault: slow_response
    target: heat-exchanger-201
    delayMs: 3500
    durationMs: 120000

  # Controller reboot at 15 minutes
  - offsetMs: 900000
    fault: connection_drop
    target: feed-pump-101
```

Key differences from the demo examples:

- **Bind to `0.0.0.0`** so clients on other machines (a historian, an OPC gateway, or a test bench) can connect over the network.
- **Use port 502** if the environment allows it, since that is what production clients expect.
- **Longer timelines** — real scenarios model shifts or maintenance windows, not 90-second demos.
- **Register maps mirror real hardware** — addresses, types, and unit IDs match the vendor documentation so the client under test needs zero configuration changes to switch between the simulator and the real device.

### Running as a service

For long-running test environments, wrap the simulator in a systemd unit (Linux) or a Windows service:

```ini
# /etc/systemd/system/modbus-fault-sim.service
[Unit]
Description=Modbus Fault Simulator
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/modbus-fault-sim/dist/cli.js /etc/modbus-fault-sim/scenario.yaml
Restart=on-failure
User=modbus-sim

[Install]
WantedBy=multi-user.target
```

This keeps the simulator available around the clock for automated test suites or always-on training environments without manual intervention.

---

## License

MIT
