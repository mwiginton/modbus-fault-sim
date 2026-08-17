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

Fault scenario timeline (from examples/fault-scenario.yaml):
    ~10s   freeze_register   compressor-unit.discharge_pressure  (30s duration)
    ~25s   slow_response     compressor-unit.vibration_level     (20s duration)
    ~45s   connection_drop   heat-exchanger                      (10s duration)
    ~60s   freeze_register   heat-exchanger.inlet_temp           (15s duration)
    ~90s   slow_response     compressor-unit.rpm                 (25s duration)
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
DURATION_SECONDS = 120
TIMEOUT_SECONDS = 2

# Unit IDs matching fault-scenario.yaml
COMPRESSOR_UNIT = 1
HEAT_EXCHANGER_UNIT = 2

# Wire addresses (documentation address minus 40001)
# Compressor unit (unit 1):
#   discharge_pressure  float32  40001 -> wire 0  (occupies 0,1)
#   suction_pressure    float32  40003 -> wire 2  (occupies 2,3)
#   vibration_level     uint16   40005 -> wire 4
#   rpm                 uint16   40006 -> wire 5
COMPRESSOR_DISCHARGE_ADDR = 0
COMPRESSOR_VIBRATION_ADDR = 4
COMPRESSOR_RPM_ADDR = 5

# Heat exchanger unit (unit 2):
#   inlet_temp   float32  40001 -> wire 0  (occupies 0,1)
#   outlet_temp  float32  40003 -> wire 2  (occupies 2,3)
#   flow_rate    uint16   40005 -> wire 4
HEAT_EXCHANGER_INLET_ADDR = 0


def words_to_float32(high, low):
    """Decode two consecutive 16-bit registers as a big-endian float32."""
    return struct.unpack(">f", struct.pack(">HH", high, low))[0]


def read_compressor(client):
    """Read discharge_pressure (float32), vibration_level (uint16), rpm (uint16).

    Returns (discharge_pressure, vibration_level, rpm, error_string).
    """
    # Read 6 registers starting at wire address 0 to get all in one request
    result = client.read_holding_registers(0, count=6, slave=COMPRESSOR_UNIT)
    if result.isError():
        return None, None, None, type(result).__name__
    regs = result.registers
    discharge_pressure = words_to_float32(regs[0], regs[1])
    vibration_level = regs[4]
    rpm = regs[5]
    return discharge_pressure, vibration_level, rpm, None


def read_heat_exchanger(client):
    """Read inlet_temp (float32) from the heat exchanger.

    Returns (inlet_temp, error_string).
    """
    result = client.read_holding_registers(0, count=2, slave=HEAT_EXCHANGER_UNIT)
    if result.isError():
        return None, type(result).__name__
    return words_to_float32(result.registers[0], result.registers[1]), None


def main():
    print(f"Polling {HOST}:{PORT} for {DURATION_SECONDS} seconds")
    print(f"Client timeout is {TIMEOUT_SECONDS}s\n")
    print(
        f"  {'time':>5s}  {'disch_press':>11s}  {'vibration':>9s}  "
        f"{'rpm':>5s}  {'inlet_temp':>10s}  note"
    )
    print(
        f"  {'-----':>5s}  {'-----------':>11s}  {'---------':>9s}  "
        f"{'-----':>5s}  {'----------':>10s}  ----"
    )

    client = ModbusTcpClient(HOST, port=PORT, timeout=TIMEOUT_SECONDS)
    if not client.connect():
        sys.exit(f"Could not connect to {HOST}:{PORT}. Is the simulator running?")

    previous_discharge = None
    previous_inlet = None
    start = time.monotonic()

    try:
        for _ in range(DURATION_SECONDS):
            elapsed = time.monotonic() - start
            notes = []

            # --- Compressor unit (unit 1) ---
            discharge, vibration, rpm, comp_error = read_compressor(client)

            if comp_error:
                disch_text = "ERROR"
                vib_text = "ERROR"
                rpm_text = "ERROR"
                notes.append(f"unit 1 {comp_error}")
            else:
                disch_text = f"{discharge:11.2f}"
                vib_text = f"{vibration:9d}"
                rpm_text = f"{rpm:5d}"
                if previous_discharge is not None and discharge == previous_discharge:
                    notes.append("disch_press unchanged")
                previous_discharge = discharge

            # --- Heat exchanger (unit 2) ---
            inlet, hx_error = read_heat_exchanger(client)

            if hx_error:
                inlet_text = "ERROR"
                notes.append(f"unit 2 {hx_error}")
                # A dropped connection needs an explicit reconnect.
                client.close()
                client.connect()
            else:
                inlet_text = f"{inlet:10.2f}"
                if previous_inlet is not None and inlet == previous_inlet:
                    notes.append("inlet_temp unchanged")
                previous_inlet = inlet

            note_str = "; ".join(notes)
            print(
                f"  {elapsed:4.0f}s  {disch_text}  {vib_text}  "
                f"{rpm_text}  {inlet_text}  {note_str}"
            )

            remaining = 1.0 - ((time.monotonic() - start) % 1.0)
            time.sleep(remaining)

    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        client.close()

    print("\nWhat to look for:")
    print("  ~10s  freeze_register   discharge_pressure stops changing while reads")
    print("                          keep succeeding. No error is raised.")
    print("  ~25s  slow_response     vibration_level reads exceed the 2s client")
    print("                          timeout and surface as errors.")
    print("  ~45s  connection_drop   the socket to unit 2 closes; reads fail until")
    print("                          the client reconnects.")
    print("  ~60s  freeze_register   inlet_temp stops changing (stale data, no error).")
    print("  ~90s  slow_response     rpm reads exceed timeout and surface as errors.")


if __name__ == "__main__":
    main()