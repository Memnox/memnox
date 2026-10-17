/**
 * The shape of a JSON-RPC message as the session reads and writes it: who it answers,
 * whether it is a response at all, and the refusal it becomes.
 */
import {
  DECISION_EFFECT,
  describeAlternative,
  refusalShapeFor,
  type Alternative,
  type RefusalShape,
} from '@memnox/core';

import type { JsonRpcMessage } from './json-rpc';

export type MessageId = string | number;

/** The request a cancellation names, which MCP puts in `params.requestId`. */
export function cancelledId(message: JsonRpcMessage): MessageId | null {
  const requestId = message.params?.['requestId'];
  return typeof requestId === 'string' || typeof requestId === 'number'
    ? requestId
    : null;
}

export function describeMessage(message: JsonRpcMessage): string {
  return message.method ?? 'response';
}

/** A response carries no method and does carry a result or an error. */
export function isResponse(message: JsonRpcMessage): boolean {
  return (
    message.method === undefined &&
    (message.result !== undefined || message.error !== undefined)
  );
}

export function identify(message: JsonRpcMessage): MessageId | null {
  return message.id === undefined || message.id === null ? null : message.id;
}

/**
 * An isError result rather than a protocol error, so the model reads the reason and the
 * alternative, and whether retrying could ever work, or it retries a rule forty times.
 */
export function denial(
  id: JsonRpcMessage['id'],
  reason: string,
  alternative?: Alternative,
  shape: RefusalShape = refusalShapeFor(DECISION_EFFECT.DENY, reason),
): JsonRpcMessage {
  const instead =
    alternative === undefined ? '' : `\n${describeAlternative(alternative)}`;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        {
          type: 'text',
          text: `Denied by Memnox: ${reason}${instead}\n${shape.guidance}`,
        },
      ],
      isError: true,
    },
  };
}
