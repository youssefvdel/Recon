/* Display facts are read from the machine or they are absent.
 *
 * `get_display_info` can fail (no Windows session, debloated box, transient
 * invoke error). The panels used to default to 2560x1440 @ 260 Hz, which reads
 * as "this is your monitor" — a hardware claim nobody measured. Callers ask
 * here first and render UNVERIFIED instead.
 */
export interface DisplayInfoLike {
  native_width?: number | null;
  native_height?: number | null;
  current_hz?: number | null;
}

export function displayUnread(info?: DisplayInfoLike | null): boolean {
  return info == null || !info.native_width || !info.native_height || !info.current_hz;
}
