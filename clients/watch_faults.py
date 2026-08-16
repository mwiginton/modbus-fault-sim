"""
Watch fault injection from the client side.

Polls the simulator once per second and prints what a real Modbus client sees
while the fault scenario runs. Run this against examples/fault-scenario.yaml
to observe each fault as it fires.

Usage:
    Terminal 1:  node dist/cli.js examples/fault-scenario.yaml
    Terminal 2:  python watch_faults.py

The client timeout is deliberately short (2 seconds) so that the slow_response
fault surfaces as a timeout rather than a long pause. Production clients that
poll without a timeout will hang instead.
"""

import struct
import sys
import time

try:
    from pymodbus.client import ModbusTcpClient
except ImportError:
    sys.exit("pymodbus is not installed. Run: python -m pip install -r requirements.txt")

HOST = "127.0.0.1"
PORT = 5020
DURATION_SECONDS = 45
TIMEOUT_SECONDS = 2

FLOW_RATE = 0    # float32 on unit 1
MOTOR_TEMP = 2   # uint16 on unit 1
LEVEL_PCT = 0    # uint16 on unit 2

PUMP_UNIT = 1
TANK_UNIT = 2


def words_to_float32(high, low):
    return struct.unpack(">f", struct.pack(">HH", high, low))[0]


def read_pump(client):
    """Return (flow_rate, motor_temp) or an error string."""
    result = client.read_holding_registers(FLOW_RATE, count=3, slave=PUMP_UNIT)
    if result.isError():
        return None, None, type(result).__name__
    flow = words_to_float32(result.registers[0], result.registers[1])
    return flow, result.registers[2], None


def read_tank(client):
    result = client.read_holding_registers(LEVEL_PCT, count=1, slave=TANK_UNIT)
    if result.isError():
        return None, type(result).__name__
    return result.registers[0], None


def main():
    print(f"Polling {HOST}:{PORT} for {DURATION_SECONDS} seconds")
    print(f"Client timeout is {TIMEOUT_SECONDS}s\n")
    print("  time   flow_rate   motor_temp   tank_level   note")
    print("  -----  ---------   ----------   ----------   ----")

    client = ModbusTcpClient(HOST, port=PORT, timeout=TIMEOUT_SECONDS)
    if not client.connect():
        sys.exit(f"Could not connect to {HOST}:{PORT}. Is the simulator running?")

    previous_flow = None
    start = time.monotonic()

    try:
        for _ in range(DURATION_SECONDS):
            elapsed = time.monotonic() - start
            note = ""

            flow, temp, pump_error = read_pump(client)
            level, tank_error = read_tank(client)

            if pump_error:
                flow_text = "ERROR"
                temp_text = "ERROR"
                note = f"unit 1 {pump_error}"
            else:
                flow_text = f"{flow:8.2f}"
                temp_text = f"{temp:9d}"
                if previous_flow is not None and flow == previous_flow:
                    note = "flow_rate unchanged"
                previous_flow = flow

            if tank_error:
                level_text = "ERROR"
                note = (note + "; " if note else "") + f"unit 2 {tank_error}"
                # A dropped connection needs an explicit reconnect. Production
                # clients that skip this go permanently silent.
                client.close()
                client.connect()
            else:
                level_text = f"{level:9d}"

            print(f"  {elapsed:4.0f}s  {flow_text}   {temp_text}   {level_text}   {note}")

            remaining = 1.0 - ((time.monotonic() - start) % 1.0)
            time.sleep(remaining)

    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        client.close()

    print("\nWhat to look for:")
    print("  freeze_register  flow_rate stops changing while reads keep succeeding")
    print("                   and motor_temp keeps climbing. No error is raised.")
    print("  slow_response    reads exceed the client timeout and surface as errors.")
    print("  connection_drop  the socket closes and the client must reconnect.")


if __name__ == "__main__":
    main()
