---
inclusion: always
---
# Modbus TCP Wire Format

These constraints apply to all protocol code. Do not restate them in
individual specs.

## MBAP header, 7 bytes, every message

| Bytes | Field          | Value                                       |
|-------|----------------|---------------------------------------------|
| 0-1   | Transaction ID | Any value; the server echoes it back        |
| 2-3   | Protocol ID    | Always 0x0000 for Modbus                    |
| 4-5   | Length         | Bytes AFTER this field: unit ID + PDU       |
| 6     | Unit ID        | Slave address                               |

The Length field counts from the unit ID onward, NOT the whole frame.
This is the most common source of framing bugs.

## Function codes

FC 03, Read Holding Registers
  Request PDU:  03 + start address (2) + quantity (2). Quantity 1-125.
  Response PDU: 03 + byte count (1, equals 2 x N) + values (2 x N)

FC 06, Write Single Register
  Request PDU:  06 + register address (2) + value (2)
  Response PDU: identical echo of the request

FC 16 (0x10), Write Multiple Registers
  Request PDU:  10 + start address (2) + quantity (2) + byte count (1)
                + values (2 x N). Quantity 1-123.
  Response PDU: 10 + start address (2) + quantity (2)

## Exception responses

Function code with the high bit set (original + 0x80), then one
exception code byte. Always 9 bytes total.

  01  Illegal Function      unsupported function code
  02  Illegal Data Address  address not in the device register map
  03  Illegal Data Value    quantity outside legal range
  06  Server Device Busy    available as a fault type

## Conventions this project adopts

- All multi-byte values are big-endian.
- float32 spans two consecutive registers, high word first.
- Configuration files use documentation addressing (40001 is the first
  holding register). Wire address = declared address - 40001.
- The byte count field in an FC 03 response is derived independently
  from the MBAP length field. Both must be correct.

## Worked examples for test fixtures

FC 03 request, read 4 registers from address 100, unit ID 3:
  00 01  00 00  00 06  03  03  00 64  00 04

Response carrying values 10, 20, 30, 40:
  00 01  00 00  00 0B  03  03  08  00 0A  00 14  00 1E  00 28

Exception response, illegal data value:
  00 01  00 00  00 03  03  83  03