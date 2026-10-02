import { exitCodeForSignal, SIGNAL_NUMBER } from '@memnox/core';

/** Signals sent to the wrapper alone, which the command it started never sees unless relayed. */
const ENDING_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;

/** The one thing relaying needs from a child, so a test can hand in a real one. */
interface Killable {
  kill(signal: NodeJS.Signals): boolean;
}

/** Where the signals arrive, which is the process itself outside a test. */
interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * Passes an ending signal on to the child, so the command stops with its
 * wrapper rather than outliving it; returns the detach to call on exit.
 */
export function relayEndingSignals(
  child: Killable,
  source: SignalSource = process,
): () => void {
  const listeners = ENDING_SIGNALS.map((signal) => {
    const listener = (): void => {
      child.kill(signal);
    };
    source.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) source.off(signal, listener);
  };
}

function isNumberedSignal(signal: NodeJS.Signals): signal is keyof typeof SIGNAL_NUMBER {
  return signal in SIGNAL_NUMBER;
}

/** A signal is `128 + n`, as a shell reports one; a signal we cannot number gets the fallback. */
export function signalledExit(signal: NodeJS.Signals | null, fallback: number): number {
  if (signal === null || !isNumberedSignal(signal)) return fallback;
  return exitCodeForSignal(signal);
}
