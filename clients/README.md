# Verification clients

Two Python scripts that exercise the simulator using [pymodbus](https://github.com/pymodbus-dev/pymodbus), an independent Modbus implementation. They exist so that the simulator's wire format can be confirmed against something it was not written against.

These are optional. The simulator itself has no Python dependency.

## Setup

```bash
python -m pip install -r requirements.txt
```

On Windows, use `py -m pip install -r requirements.txt` if `python` is not on your PATH.

## verify.py

Exercises every supported function code and checks the responses.

```bash
# Terminal 1
node dist/cli.js examples/basic.yaml

# Terminal 2
python clients/verify.py
```

Covers FC 03 reads including a float32 spanning two registers, FC 06 and FC 16 writes with read-back, exception responses for out-of-range addresses and float32 writes, reads against a second device, and the silent discard of an unconfigured unit ID.

Exits 0 if every check passes.

Note that the final check is expected to take a few seconds. An unconfigured unit ID produces no response at all, which is correct Modbus behavior, so the client waits for its timeout.

## watch_faults.py

Polls once per second and prints what a client sees while faults fire.

```bash
# Terminal 1
node dist/cli.js examples/fault-scenario.yaml

# Terminal 2
python clients/watch_faults.py
```

The client timeout is set to 2 seconds so the `slow_response` fault surfaces as an error rather than a long pause.

What each fault looks like from the client side:

**freeze_register** — `flow_rate` stops changing while `motor_temp` continues climbing. Reads keep succeeding and no error is raised. This is the failure mode that historians record as a flat line and alarm thresholds never catch.

**slow_response** — responses exceed the client timeout. A client without a timeout hangs instead.

**connection_drop** — the socket closes without warning. The script reconnects explicitly; a client that does not will go permanently silent.

## Addressing

The example configurations declare documentation-style addresses (40001 and up) and set `addressBase: documentation` per device. The simulator subtracts 40001 at load time, so clients address registers from zero.

`flow_rate` at declared address 40001 becomes wire address 0, and occupies wire addresses 0 and 1 because it is a float32.
