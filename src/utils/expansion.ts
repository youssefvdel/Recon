/** Which row the ledger should have expanded.
 *
 *  Two ways a request arrives, and they must agree:
 *  - the ledger is already on screen → the `recon:goto-match` event sets it;
 *  - the ledger mounts AFTER the request (the usual case, because the tab
 *    switch happens first) → the id arrives as `initialExpandedId`.
 *
 *  Pure so the mount-order rule can be checked without a browser: an incoming
 *  request always wins over the current value, and no request changes nothing.
 */
export const nextExpandedId = (
  current: string | null,
  incoming: string | null | undefined
): string | null => (incoming ? incoming : current);
