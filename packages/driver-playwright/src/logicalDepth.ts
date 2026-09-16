/**
 * Logical (program-level) action depth of a single turtle.
 *
 * Music Blocks realizes flow recursion ITERATIVELY (`logo.js`): entering a
 * flow construct (Do / Repeat / action-call / Foreach / Switch) pushes the
 * parent block onto `turtle.parentFlowQueue` and a `Queue` entry onto
 * `turtle.queue`, and children drain `turtle.queue`. The true logical nesting
 * depth at any instant is therefore `queue.length + parentFlowQueue.length`.
 *
 * This is distinct from the `maxDepth` probe, which measures synchronous JS
 * nesting of `logo.runFromBlockNow` (invariably ~1 in the iterative engine).
 *
 * `LOGICAL_DEPTH_HELPER_SRC` is the page-rehydratable form of this function:
 * it must stay plain ES5-compatible JS (no type annotations, no arrow shorthands)
 * because it is re-injected verbatim into benchmarked pages.
 */
export const LOGICAL_DEPTH_HELPER_SRC = `function(turtle){
  if (!turtle) return 0;
  var queued = Array.isArray(turtle.queue) ? turtle.queue.length : 0;
  var flow = Array.isArray(turtle.parentFlowQueue) ? turtle.parentFlowQueue.length : 0;
  return queued + flow;
}`;

export function logicalDepthOf(turtle: unknown): number {
  if (!turtle || typeof turtle !== "object") return 0;
  const asRecord = turtle as { queue?: unknown; parentFlowQueue?: unknown };
  const queued = Array.isArray(asRecord.queue) ? asRecord.queue.length : 0;
  const flow = Array.isArray(asRecord.parentFlowQueue)
    ? asRecord.parentFlowQueue.length
    : 0;
  return queued + flow;
}