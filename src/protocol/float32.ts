/**
 * IEEE 754 single-precision float ↔ Modbus register word conversion.
 *
 * Modbus represents 32-bit floats across two consecutive 16-bit holding
 * registers. This module uses big-endian word order: the high word resides
 * at address N and the low word at address N+1.
 */

/**
 * Encode an IEEE 754 single-precision float as two 16-bit Modbus words.
 *
 * Word order is big-endian: high word first (address N), low word second (N+1).
 *
 * @param value - The floating-point number to encode.
 * @returns A tuple of [highWord, lowWord], each in the range 0x0000–0xFFFF.
 */
export function float32ToWords(value: number): [highWord: number, lowWord: number] {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

/**
 * Decode two 16-bit Modbus words into an IEEE 754 single-precision float.
 *
 * Expects big-endian word order: high word from address N, low word from N+1.
 *
 * @param high - The high word (address N), range 0x0000–0xFFFF.
 * @param low  - The low word (address N+1), range 0x0000–0xFFFF.
 * @returns The decoded floating-point number.
 */
export function wordsToFloat32(high: number, low: number): number {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(high, 0);
  buf.writeUInt16BE(low, 2);
  return buf.readFloatBE(0);
}
