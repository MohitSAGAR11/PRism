import { isIP } from "node:net";

/**
 * Who is this visitor, for rate limiting.
 *
 * Behind a proxy (TRUST_PROXY=1), only the last X-Forwarded-For hop is
 * trusted: the proxy appends the address it actually saw, while earlier
 * entries, and headers such as X-Real-IP that an edge may pass through
 * untouched, are whatever the client chose to send. Anything that is not a
 * literal IP falls back to the socket address.
 */
export function resolveClientIp(
  trustProxy: boolean,
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
): string {
  if (trustProxy && forwardedFor) {
    const last = forwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last && isIP(last)) return last;
  }
  return socketAddress && socketAddress.length > 0 ? socketAddress : "unknown";
}
