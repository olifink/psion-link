/**
 * PLP spec §"Timers": retransmission timeout = Baud Rate Bits Factor
 * (13200 / baud seconds) + Round Trip Time Factor (0.2s constant; the
 * spec's optional Backoff Factor is omitted, as the spec allows for "a
 * simple implementation"). Physically: low baud is dominated by transmit
 * time, high baud by the RTT allowance.
 *
 * NOTE: plptools' `Link::retransTimeout()` (lib/link.cc) computes
 * `baud * 1000 / 13200 + 200` — the *inverse* relationship (longer timeout
 * at higher baud). That contradicts the spec's own physical justification
 * and looks like a long-standing bug rather than an intentional deviation,
 * so this implementation follows the spec formula rather than plptools.
 */
export function retransmitTimeoutMs(baudRate: number): number {
  return (13200 / baudRate + 0.2) * 1000;
}

/** PLP spec §"Timers": "a timeout of 60 seconds is recommended". */
export const INACTIVITY_TIMEOUT_MS = 60_000;

/** PLP spec, Idle_Ack_State: retry the connection handshake up to 4 times. */
export const CONNECT_RETRIES = 4;

/** PLP spec, Data_Ack_State: retry an unacknowledged Data_Pdu up to 8 times. */
export const DATA_RETRIES = 8;

/** BRIEF.md §4.2: EPOC is multi-windowed, up to 8 outstanding Data_Pdus. */
export const MAX_OUTSTANDING = 8;

/** BRIEF.md §4.2 / plptools `Link::send`: data field is capped at 300 bytes. */
export const MAX_PAYLOAD_BYTES = 300;
