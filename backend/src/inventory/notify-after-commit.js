// Notifications are best effort. A broadcast failure cannot undo a committed write.
export async function notifyAfterCommit(req) {
  try {
    await req.app.locals.notifyInventoryChanged?.();
  } catch (err) {
    req.log.warn('inventory notification failed after commit', { err });
  }
}
