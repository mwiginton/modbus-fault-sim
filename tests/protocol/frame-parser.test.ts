import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FrameParser } from '../../src/protocol/frame-parser.js';

/**
 * Helper: Build a valid Modbus TCP frame from parts.
 * MBAP header (7 bytes) + PDU (functionCode + data).
 */
function buildFrame(opts: {
  transactionId: number;
  protocolId: number;
  unitId: number;
  functionCode: number;
  data: Buffer;
}): Buffer {
  const pduLength = 1 + opts.data.length; // functionCode + data
  const length = 1 + pduLength;           // unitId + PDU
  const frame = Buffer.alloc(6 + length);

  frame.writeUInt16BE(opts.transactionId, 0);
  frame.writeUInt16BE(opts.protocolId, 2);
  frame.writeUInt16BE(length, 4);
  frame.writeUInt8(opts.unitId, 6);
  frame.writeUInt8(opts.functionCode, 7);
  opts.data.copy(frame, 8);

  return frame;
}

/**
 * Arbitrary: generates a valid Modbus TCP frame with protocol ID 0x0000.
 */
function arbValidFrame() {
  return fc.record({
    transactionId: fc.nat(65535),
    unitId: fc.nat(255),
    functionCode: fc.integer({ min: 1, max: 255 }),
    data: fc.uint8Array({ minLength: 0, maxLength: 100 }).map(a => Buffer.from(a)),
  }).map(({ transactionId, unitId, functionCode, data }) =>
    buildFrame({ transactionId, protocolId: 0x0000, unitId, functionCode, data })
  );
}

/**
 * Arbitrary: splits a buffer into random-sized chunks.
 */
function arbChunks(frame: Buffer): fc.Arbitrary<Buffer[]> {
  if (frame.length <= 1) {
    return fc.constant([frame]);
  }
  // Generate split points within the buffer
  return fc.array(fc.integer({ min: 1, max: frame.length - 1 }), { minLength: 0, maxLength: frame.length - 1 })
    .map(points => {
      const sorted = [...new Set(points)].sort((a, b) => a - b);
      const chunks: Buffer[] = [];
      let prev = 0;
      for (const point of sorted) {
        chunks.push(frame.subarray(prev, point));
        prev = point;
      }
      chunks.push(frame.subarray(prev));
      return chunks;
    });
}

// Feature: modbus-fault-sim, Property 2: Non-Zero Protocol ID Discards
// **Validates: Requirements 4.5, 5.2**
describe('frame-parser property tests', () => {
  describe('Property 2: Non-Zero Protocol ID Discards', () => {
    it('frames with protocol ID != 0x0000 are silently discarded and produce no requests', () => {
      fc.assert(
        fc.property(
          fc.nat(65535),                                       // transactionId
          fc.integer({ min: 1, max: 65535 }),                  // protocolId: non-zero
          fc.nat(255),                                         // unitId
          fc.integer({ min: 1, max: 255 }),                    // functionCode
          fc.uint8Array({ minLength: 0, maxLength: 50 }).map(a => Buffer.from(a)), // data
          (transactionId, protocolId, unitId, functionCode, data) => {
            const frame = buildFrame({ transactionId, protocolId, unitId, functionCode, data });
            const parser = new FrameParser();

            const requests = parser.feed(frame);

            // Non-zero protocol ID frames must be discarded — no requests returned
            expect(requests).toHaveLength(0);
            // Parser should not signal close for discarded frames
            expect(parser.shouldClose).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('a non-zero protocol ID frame followed by a valid frame still yields the valid frame', () => {
      fc.assert(
        fc.property(
          fc.nat(65535),                                       // bad transactionId
          fc.integer({ min: 1, max: 65535 }),                  // bad protocolId
          fc.nat(255),                                         // bad unitId
          fc.integer({ min: 1, max: 255 }),                    // bad functionCode
          fc.uint8Array({ minLength: 0, maxLength: 20 }).map(a => Buffer.from(a)), // bad data
          fc.nat(65535),                                       // good transactionId
          fc.nat(255),                                         // good unitId
          fc.integer({ min: 1, max: 255 }),                    // good functionCode
          fc.uint8Array({ minLength: 0, maxLength: 20 }).map(a => Buffer.from(a)), // good data
          (badTxn, badProto, badUnit, badFc, badData, goodTxn, goodUnit, goodFc, goodData) => {
            const badFrame = buildFrame({
              transactionId: badTxn,
              protocolId: badProto,
              unitId: badUnit,
              functionCode: badFc,
              data: badData,
            });
            const goodFrame = buildFrame({
              transactionId: goodTxn,
              protocolId: 0x0000,
              unitId: goodUnit,
              functionCode: goodFc,
              data: goodData,
            });

            const parser = new FrameParser();
            const combined = Buffer.concat([badFrame, goodFrame]);
            const requests = parser.feed(combined);

            // The bad frame is discarded; the good frame is parsed
            expect(requests).toHaveLength(1);
            expect(requests[0].header.transactionId).toBe(goodTxn);
            expect(requests[0].header.unitId).toBe(goodUnit);
            expect(requests[0].functionCode).toBe(goodFc);
            expect(requests[0].data).toEqual(goodData);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: Chunking Invariance — valid frames parse correctly regardless of TCP segmentation', () => {
    it('a single valid frame fed in arbitrary chunks produces the same parsed request', () => {
      fc.assert(
        fc.property(
          fc.nat(65535),                                       // transactionId
          fc.nat(255),                                         // unitId
          fc.integer({ min: 1, max: 255 }),                    // functionCode
          fc.uint8Array({ minLength: 0, maxLength: 100 }).map(a => Buffer.from(a)), // data
          fc.context(),
          (transactionId, unitId, functionCode, data, ctx) => {
            const frame = buildFrame({ transactionId, protocolId: 0x0000, unitId, functionCode, data });

            // Generate random split points
            fc.assert(
              fc.property(
                arbChunks(frame),
                (chunks) => {
                  const parser = new FrameParser();
                  const allRequests = chunks.flatMap(chunk => parser.feed(chunk));

                  // Must produce exactly one request
                  expect(allRequests).toHaveLength(1);

                  const req = allRequests[0];
                  expect(req.header.transactionId).toBe(transactionId);
                  expect(req.header.protocolId).toBe(0x0000);
                  expect(req.header.unitId).toBe(unitId);
                  expect(req.functionCode).toBe(functionCode);
                  expect(req.data).toEqual(data);
                }
              ),
              { numRuns: 10 } // inner runs per outer case
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple valid frames coalesced into one buffer are all parsed correctly', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              transactionId: fc.nat(65535),
              unitId: fc.nat(255),
              functionCode: fc.integer({ min: 1, max: 255 }),
              data: fc.uint8Array({ minLength: 0, maxLength: 50 }).map(a => Buffer.from(a)),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (frameSpecs) => {
            const frames = frameSpecs.map(spec =>
              buildFrame({ ...spec, protocolId: 0x0000 })
            );
            const coalesced = Buffer.concat(frames);

            const parser = new FrameParser();
            const requests = parser.feed(coalesced);

            // Must produce one request per frame
            expect(requests).toHaveLength(frameSpecs.length);

            for (let i = 0; i < frameSpecs.length; i++) {
              expect(requests[i].header.transactionId).toBe(frameSpecs[i].transactionId);
              expect(requests[i].header.unitId).toBe(frameSpecs[i].unitId);
              expect(requests[i].functionCode).toBe(frameSpecs[i].functionCode);
              expect(requests[i].data).toEqual(frameSpecs[i].data);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple coalesced frames split into random chunks all parse correctly', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              transactionId: fc.nat(65535),
              unitId: fc.nat(255),
              functionCode: fc.integer({ min: 1, max: 255 }),
              data: fc.uint8Array({ minLength: 0, maxLength: 30 }).map(a => Buffer.from(a)),
            }),
            { minLength: 1, maxLength: 4 }
          ),
          (frameSpecs) => {
            const frames = frameSpecs.map(spec =>
              buildFrame({ ...spec, protocolId: 0x0000 })
            );
            const coalesced = Buffer.concat(frames);

            // Split coalesced buffer at random points
            fc.assert(
              fc.property(
                arbChunks(coalesced),
                (chunks) => {
                  const parser = new FrameParser();
                  const requests = chunks.flatMap(chunk => parser.feed(chunk));

                  expect(requests).toHaveLength(frameSpecs.length);

                  for (let i = 0; i < frameSpecs.length; i++) {
                    expect(requests[i].header.transactionId).toBe(frameSpecs[i].transactionId);
                    expect(requests[i].header.unitId).toBe(frameSpecs[i].unitId);
                    expect(requests[i].functionCode).toBe(frameSpecs[i].functionCode);
                    expect(requests[i].data).toEqual(frameSpecs[i].data);
                  }
                }
              ),
              { numRuns: 10 }
            );
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
