/**
 * Types-only stub so tsc can resolve `solid-js`. Not imported at runtime.
 * Host supplies createSignal / createMemo / createEffect / onCleanup / onMount.
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

export function createMemo<T>(fn: () => T): () => T {
  return fn
}

export function createEffect(_fn: () => void): void {}

export function onCleanup(_fn: () => void): void {}

export function onMount(_fn: () => void): void {}
