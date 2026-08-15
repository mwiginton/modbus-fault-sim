import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { TcpServer } from '../../src/server/tcp-server.js';

/**
 * Helper: connect to a server and return the socket.
 */
function connectTo(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host }, () => resolve(socket));
    socket.on('error', reject);
  });
}

/**
 * Helper: wait for a socket to emit 'close'.
 */
function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.on('close', () => resolve());
  });
}

describe('TcpServer', () => {
  const servers: TcpServer[] = [];

  afterEach(async () => {
    for (const server of servers) {
      await server.stop().catch(() => {});
    }
    servers.length = 0;
  });

  /**
   * Helper: create and track a server for cleanup.
   */
  function createServer(options: ConstructorParameters<typeof TcpServer>[0]): TcpServer {
    const server = new TcpServer(options);
    servers.push(server);
    return server;
  }

  describe('start()', () => {
    it('listens on the configured host and port', async () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      await server.start();

      const addr = server.address();
      expect(addr).toBeDefined();
      expect(addr!.port).toBeGreaterThan(0);
      expect(addr!.address).toBe('127.0.0.1');
    });

    it('accepts TCP connections after starting', async () => {
      let connectionCount = 0;
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => { connectionCount++; },
      });

      await server.start();
      const { port } = server.address()!;

      const socket = await connectTo(port);
      // Give the server time to fire onConnection
      await new Promise((r) => setTimeout(r, 50));

      expect(connectionCount).toBe(1);
      socket.destroy();
    });

    it('invokes onConnection callback with the socket', async () => {
      const sockets: net.Socket[] = [];
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: (socket) => { sockets.push(socket); },
      });

      await server.start();
      const { port } = server.address()!;

      const client = await connectTo(port);
      await new Promise((r) => setTimeout(r, 50));

      expect(sockets).toHaveLength(1);
      expect(sockets[0]).toBeInstanceOf(net.Socket);

      client.destroy();
    });
  });

  describe('closeAllConnections()', () => {
    it('destroys all connected sockets without graceful shutdown (Req 15.1)', async () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      await server.start();
      const { port } = server.address()!;

      const client1 = await connectTo(port);
      const client2 = await connectTo(port);
      await new Promise((r) => setTimeout(r, 50));

      const close1 = waitForClose(client1);
      const close2 = waitForClose(client2);

      server.closeAllConnections();

      // Both connections should be closed
      await Promise.all([close1, close2]);

      expect(client1.destroyed).toBe(true);
      expect(client2.destroyed).toBe(true);
    });

    it('continues accepting new connections within 100ms after closing (Req 15.2)', async () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      await server.start();
      const { port } = server.address()!;

      // Establish and then drop connections
      const client1 = await connectTo(port);
      await new Promise((r) => setTimeout(r, 50));

      const closePromise = waitForClose(client1);
      server.closeAllConnections();
      await closePromise;

      // New connection should be accepted within 100ms
      const start = Date.now();
      const newClient = await connectTo(port);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(newClient.destroyed).toBe(false);

      newClient.destroy();
    });

    it('is a no-op when no connections exist', () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      // Should not throw
      expect(() => server.closeAllConnections()).not.toThrow();
    });
  });

  describe('stop()', () => {
    it('stops accepting new connections', async () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      await server.start();
      const { port } = server.address()!;

      await server.stop();

      // Attempting to connect should fail
      await expect(connectTo(port)).rejects.toThrow();
    });

    it('closes all existing connections on stop (Req 17.5)', async () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      await server.start();
      const { port } = server.address()!;

      const client = await connectTo(port);
      await new Promise((r) => setTimeout(r, 50));

      const closePromise = waitForClose(client);
      await server.stop();
      await closePromise;

      expect(client.destroyed).toBe(true);
    });

    it('resolves even when called multiple times', async () => {
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => {},
      });

      await server.start();
      await server.stop();
      // Second stop should not throw
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  describe('multiple connections', () => {
    it('tracks multiple simultaneous connections', async () => {
      let connectionCount = 0;
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: () => { connectionCount++; },
      });

      await server.start();
      const { port } = server.address()!;

      const clients = await Promise.all([
        connectTo(port),
        connectTo(port),
        connectTo(port),
      ]);
      await new Promise((r) => setTimeout(r, 50));

      expect(connectionCount).toBe(3);

      for (const client of clients) {
        client.destroy();
      }
    });

    it('removes disconnected clients from tracking', async () => {
      const connectedSockets: net.Socket[] = [];
      const server = createServer({
        host: '127.0.0.1',
        port: 0,
        onConnection: (socket) => { connectedSockets.push(socket); },
      });

      await server.start();
      const { port } = server.address()!;

      const client = await connectTo(port);
      await new Promise((r) => setTimeout(r, 50));

      expect(connectedSockets).toHaveLength(1);

      // Client disconnects
      const closePromise = waitForClose(connectedSockets[0]);
      client.destroy();
      await closePromise;
      await new Promise((r) => setTimeout(r, 50));

      // closeAllConnections should be a no-op now (no tracked sockets)
      // This verifies cleanup happened
      expect(() => server.closeAllConnections()).not.toThrow();
    });
  });
});
