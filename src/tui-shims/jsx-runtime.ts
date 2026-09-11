/**
 * Types-only stub so tsc can resolve `solid-js/jsx-runtime` (TS2875).
 * Not imported at runtime — the host bun compiler supplies JSX.
 */
export type TuiChild = any

export namespace JSX {
  export type Element = any
  export interface ElementChildrenAttribute {
    children: any
  }
  export interface IntrinsicElements {
    // OpenTUI TextRenderable accepts fg/bg as a color string OR a theme
    // RGBA token object; keep in sync with src/tui-jsx.d.ts.
    text: { children?: any; fg?: string | object; bg?: string | object }
    box: { children?: any; flexDirection?: string; flexGrow?: number | string; width?: number; flexShrink?: number }
  }
}

export function jsx(_type: unknown, _props: unknown, _key?: unknown): any {
  return null
}
export const jsxs = jsx
export const jsxDEV = jsx
export const Fragment = Symbol("Fragment")
