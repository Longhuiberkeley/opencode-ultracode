/**
 * Live paint wiring: load the real server plugin (src/index.ts) in place of
 * the probe server half. Used by `scripts/tui-probe.sh --live`.
 */
export { default } from "../../../../../src/index.ts"
