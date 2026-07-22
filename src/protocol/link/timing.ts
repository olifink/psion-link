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

/**
 * The spec's sample state table also has Data_State's "Timeout" event
 * (i.e. 60s with nothing outstanding) send Disc_Pdu and terminate the
 * connection — deliberately not implemented here. plptools' `Link` class
 * (`lib/link.cc`) has no such mechanism at all: no keep-alive, no idle
 * timer, no self-initiated disconnect. Implementing the spec's version
 * against real hardware meant we tore down a perfectly healthy connection
 * out from under the user every time they spent over a minute just
 * looking at a directory listing. A genuinely dead link is still caught
 * by the per-packet retransmit-limit path in `checkTimeouts` the next
 * time something is actually sent.
 */

/** PLP spec, Idle_Ack_State: retry the connection handshake up to 4 times. */
export const CONNECT_RETRIES = 4;

/** PLP spec, Data_Ack_State: retry an unacknowledged Data_Pdu up to 8 times. */
export const DATA_RETRIES = 8;

/** BRIEF.md §4.2: EPOC is multi-windowed, up to 8 outstanding Data_Pdus. */
export const MAX_OUTSTANDING = 8;

/** BRIEF.md §4.2 / plptools `Link::send`: data field is capped at 300 bytes. */
export const MAX_PAYLOAD_BYTES = 300;
