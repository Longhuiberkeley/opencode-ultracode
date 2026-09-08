/**
 * Types-only stub so tsc can resolve `solid-js`. Not imported at runtime.
 */
export function createSignal<T>(value: T): [() => T, (v: T | ((prev: T) => T)) => void] {
  let current = value
  return [
    () => current,
    (v) => {
      current = typeof v === "function" ? (v as (prev: T) => T)(current) : v
    },
  ]
}
