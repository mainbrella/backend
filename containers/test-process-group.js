// Host-only adapter: these fixtures execute in Node's own PID namespace, unlike
// the provider's ExecProcess. Production Linux signaling is tested separately.
export function hostProcessGroups(controller) {
  controller.signalOperationGroup = async (createdAt, groupId, signal, incarnation) => {
    const metadata = await controller.ctx.storage.get('builderMachine');
    if (!controller.container.running || !metadata || new Date(metadata.createdAt).toISOString() !== createdAt
      || metadata.telemetryId !== incarnation) return false;
    try { process.kill(-groupId, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  return controller;
}
