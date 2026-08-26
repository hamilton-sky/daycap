/**
 * Gate 2 of 3 — the network boundary, installed for the WHOLE suite via vitest `setupFiles`.
 *
 * The brief's posture is "no server, no proxy, no login". That is not enforceable by review: an
 * adapter could start fetching a price table, or `npx` could resolve a package from the registry,
 * and both would look ordinary in a diff. Here any connect to a non-loopback address throws, so
 * the build fails the moment the product grows an egress path.
 *
 * Loopback is allowed because a collector's local HTTP surface is a legitimate design (budi's
 * daemon listens on 127.0.0.1). Everything else is not.
 */

import net from "node:net";

const LOOPBACK = /^(127(\.\d+){3}|::1|::ffff:127(\.\d+){3}|localhost)$/i;

export class EgressForbiddenError extends Error {
  constructor(target: string) {
    super(
      `network egress to ${target} is forbidden: lum talks to a LOCAL collector and nothing else. ` +
        "If this is npx resolving a package, resolve the binary directly instead.",
    );
    this.name = "EgressForbiddenError";
  }
}

/** Pull a host out of every `connect()` overload: (options), (port, host), (path). */
export function hostFromConnectArgs(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: unknown; path?: unknown };
    // A unix socket has no host and cannot leave the machine.
    if (typeof o.path === "string") return null;
    return typeof o.host === "string" ? o.host : "localhost";
  }
  if (typeof first === "string") return null; // IPC path
  const second = args[1];
  return typeof second === "string" ? second : "localhost";
}

export function isAllowed(host: string | null): boolean {
  return host === null || LOOPBACK.test(host);
}

let installed = false;

export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patched(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const host = hostFromConnectArgs(args);
    if (!isAllowed(host)) throw new EgressForbiddenError(String(host));
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

installNetworkGuard();
