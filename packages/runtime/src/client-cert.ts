import type { TLSSocket } from 'node:tls';
import type { FastifyRequest } from 'fastify';
import type { AgentIdentity, IdentityStore } from '@memnox/core';

/** The one certificate field the mapping relies on; full peer certs satisfy it. */
export interface ClientCertificate {
  subject?: { CN?: string };
}

/** Maps a CA-verified client certificate to the agent whose name equals the subject CN. */
export async function resolveAgentFromClientCert(
  cert: ClientCertificate | null,
  identityStore: IdentityStore,
): Promise<AgentIdentity | null> {
  if (cert === null) return null;
  const commonName = cert.subject === undefined ? undefined : cert.subject.CN;
  if (!commonName) return null;
  const agents = await identityStore.list();
  return agents.find((agent) => agent.name === commonName) ?? null;
}

/** The verified peer certificate, or null on plain sockets and unverified peers. */
export function peerCertificate(request: FastifyRequest): ClientCertificate | null {
  const socket = request.raw.socket as Partial<TLSSocket>;
  if (typeof socket.getPeerCertificate !== 'function' || !socket.authorized) return null;
  const cert = socket.getPeerCertificate();
  return cert && Object.keys(cert).length > 0 ? (cert as ClientCertificate) : null;
}
