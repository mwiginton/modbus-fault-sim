"""
Interoperability verification for modbus-fault-sim.

Connects with pymodbus, a third-party Modbus implementation, and exercises
every function code the simulator supports. This confirms the simulator's
wire format is correct against an implementation it was not written against.

Usage:
    Terminal 1:  node dist/cli.js examples/basic.yaml
    Terminal 2:  python verify.py

Exits 0 if every check passes, 1 otherwise.
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

# Wire addresses from examples/basic.yaml. The config declares documentation
# addresses (40001, 40003, 40004); the simulator subtracts 40001 at load time,
# so clients address registers from zero.
FLOW_RATE = 0      # float32, spans wire addresses 0 and 1
MOTOR_TEMP = 2     # uint16
VALVE_POSITION = 3  # uint16

PUMP_UNIT = 1
TANK_UNIT = 2
ABSENT_UNIT = 99

passed = 0
failed = 0


def check(label, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {label}" + (f"  ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"  FAIL  {label}" + (f"  ({detail})" if detail else ""))


def words_to_float32(high, low):
    """Combine two 16-bit registers into an IEEE 754 float, high word first."""
    return struct.unpack(">f", struct.pack(">HH", high, low))[0]


def main():
    print(f"Connecting to {HOST}:{PORT}\n")
    client = ModbusTcpClient(HOST, port=PORT, timeout=3)

    if not client.connect():
        sys.exit(f"Could not connect to {HOST}:{PORT}. Is the simulator running?")

    try:
        print("FC 03 - Read Holding Registers")

        result = client.read_holding_registers(FLOW_RATE, count=2, slave=PUMP_UNIT)
        check("read float32 across two registers",
              not result.isError() and len(result.registers) == 2,
              f"raw words {result.registers}" if not result.isError() else str(result))

        if not result.isError():
            flow = words_to_float32(result.registers[0], result.registers[1])
            check("float32 decodes to a value in the configured 20-85 range",
                  20.0 <= flow <= 85.0,
                  f"{flow:.2f}")

        result = client.read_holding_registers(MOTOR_TEMP, count=1, slave=PUMP_UNIT)
        check("read single uint16",
              not result.isError(),
              f"motor_temp = {result.registers[0]}" if not result.isError() else str(result))

        result = client.read_holding_registers(FLOW_RATE, count=4, slave=PUMP_UNIT)
        check("read spanning all registers on the device",
              not result.isError(),
              f"{len(result.registers)} registers" if not result.isError() else str(result))

        print("\nLive values")

        first = client.read_holding_registers(FLOW_RATE, count=2, slave=PUMP_UNIT)
        time.sleep(3)
        second = client.read_holding_registers(FLOW_RATE, count=2, slave=PUMP_UNIT)
        check("register values change over time",
              not first.isError() and not second.isError()
              and first.registers != second.registers,
              "sine behavior is advancing")

        print("\nFC 06 - Write Single Register")

        result = client.write_register(MOTOR_TEMP, 1234, slave=PUMP_UNIT)
        check("write accepted", not result.isError(), str(result) if result.isError() else "")

        result = client.read_holding_registers(MOTOR_TEMP, count=1, slave=PUMP_UNIT)
        check("write then read round trip",
              not result.isError() and result.registers[0] == 1234,
              f"read back {result.registers[0]}" if not result.isError() else str(result))

        print("\nFC 16 - Write Multiple Registers")

        result = client.write_registers(MOTOR_TEMP, [555, 666], slave=PUMP_UNIT)
        check("multiple write accepted", not result.isError(),
              str(result) if result.isError() else "")

        result = client.read_holding_registers(MOTOR_TEMP, count=2, slave=PUMP_UNIT)
        check("multiple write round trip",
              not result.isError() and result.registers == [555, 666],
              f"read back {result.registers}" if not result.isError() else str(result))

        print("\nException responses")

        result = client.read_holding_registers(9000, count=2, slave=PUMP_UNIT)
        check("out-of-range address returns an exception", result.isError(), str(result))

        result = client.write_register(FLOW_RATE, 100, slave=PUMP_UNIT)
        check("write to a float32 register is rejected", result.isError(), str(result))

        print("\nSecond device")

        result = client.read_holding_registers(0, count=1, slave=TANK_UNIT)
        check("read from unit 2",
              not result.isError(),
              f"level_pct = {result.registers[0]}" if not result.isError() else str(result))

        print("\nUnknown unit ID")
        print("  (correct Modbus behavior is silence, so this should time out)")

        result = client.read_holding_registers(0, count=1, slave=ABSENT_UNIT)
        check("unconfigured unit ID produces no response", result.isError(), str(result))

    finally:
        client.close()

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
