// Resolve explicit targets without silently choosing a different application.
export class TargetUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'TargetUnavailableError'; }
}

export function captureRect(rect, bounds) {
  if (rect == null) return null;
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0) {
    throw new TargetUnavailableError('rect requires integer x/y >= 0 and w/h > 0, in target-relative pixels');
  }
  if (bounds && (x + w > bounds.width || y + h > bounds.height)) {
    throw new TargetUnavailableError('rect extends outside the capture target');
  }
  return { x, y, w, h };
}

export function selectWindow(windows, { windowId, title } = {}) {
  if (windowId != null && !/^(?:[1-9]\d*|0x[\da-f]+)$/i.test(String(windowId))) {
    throw new TargetUnavailableError('windowId must be a positive decimal or hexadecimal native window ID');
  }
  if (windowId == null && (typeof title !== 'string' || !title.trim())) {
    throw new TargetUnavailableError('Window capture requires windowId or a nonempty title');
  }
  const matches = windows.filter((w) => windowId != null
    ? w.id != null && BigInt(w.id) === BigInt(windowId)
    : w.title.toLowerCase().includes(title.toLowerCase()));
  const visible = matches.filter((w) => !w.hidden && w.width > 0 && w.height > 0);
  if (!visible.length) throw new TargetUnavailableError('Window target is missing, minimized, or hidden; use list_windows and select a visible window ID');
  if (visible.length > 1) throw new TargetUnavailableError('Window title is ambiguous; use list_windows and pass an exact windowId');
  return visible[0];
}
