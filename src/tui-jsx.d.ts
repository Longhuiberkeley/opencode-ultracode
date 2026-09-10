/**
 * JSX intrinsic shims for OpenTUI `<text>` / `<box>` (probe recipe).
 * Module path mapping for solid-js lives in tsconfig paths → src/tui-shims.
 */
export {}

declare global {
  namespace JSX {
    type Element = any
    interface ElementChildrenAttribute {
      children: any
    }
    interface IntrinsicElements {
      text: { children?: any }
      box: { children?: any; flexDirection?: string; flexGrow?: number | string; width?: number; flexShrink?: number }
    }
  }
}
