/**
 * TCP server for Modbus fault simulator.
 *
 * Wraps Node.js `net.Server` with connection tracking and the ability to
 * forcefully drop all connections (for connection_drop fault injection)
 * while continuing to accept new connections immediately.
 */

import net from 'node:net';

/** Options for creating a TcpServer instance. */
export interface TcpServerOptions {
  /** Host address to bind to (e.g. '127.0.0.1' or '0.0.0.0'). */
  host: string;
  /** TCP port to listen on. Use 0 for an OS-assigned port. */
  port: number;
  /** Callback invoked for each new incoming connection. */
  onConnection: (socket: net.Socket) => void;
}

/**
 * TCP server that accepts Modbus connections and supports forceful
 * connection dropping without interrupting the listener.
 *
 * Key behaviors:
 * - `closeAllConnections()` destroys all active sockets immediately
 *   (no graceful FIN sequence) but the server continues listening so
 *   new connections are accepted within 100ms.
 * - `stop()` closes the listener and destroys all active connections.
 */
export class TcpServer {
  private readonly server: net.Server;
  private readonly connections: Set<net.Socket> = new Set();
  private readonly host: string;
  private readonly port: number;
  private readonly onConnection: (socket: net.Socket) => void;
  private stopped = false;

  constructor(options: TcpServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.onConnection = options.onConnection;

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
  }

  /**
   * Start listening on the configured host and port.
   * Resolves once the server is bound and ready to accept connections.
   */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        this.stopped = false;
        resolve();
      });
    });
  }

  /**
   * Stop the server: close the listener and destroy all active connections.
   * Resolves once the underlying server is fully closed.
   */
  stop(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.stopped = true;

    // Destroy all tracked connections immediately
    this.closeAllConnections();

    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          // ERR_SERVER_NOT_RUNNING is fine — the server was already closed
          if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
            resolve();
          } else {
            reject(err);
          }
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Forcefully destroy all active TCP connections without graceful shutdown.
   *
   * The server remains listening, so new connections are accepted immediately.
   * This satisfies Requirement 15.1 (immediate close, no graceful TCP shutdown)
   * and Requirement 15.2 (accept new connections within 100ms).
   */
  closeAllConnections(): void {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
  }

  /**
   * Returns the bound address of the server, or undefined if not listening.
   */
  address(): net.AddressInfo | undefined {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return addr;
    }
    return undefined;
  }

  /**
   * Handle a new incoming connection: track it and invoke the user callback.
   */
  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);

    // Remove from tracking when the socket closes (for any reason)
    socket.once('close', () => {
      this.connections.delete(socket);
    });

    this.onConnection(socket);
  }
}
