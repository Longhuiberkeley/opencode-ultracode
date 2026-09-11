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
      // OpenTUI TextRenderable accepts fg/bg color strings or theme RGBA
      // token objects, passed through fail-soft helpers in tui.tsx.
      text: { children?: any; fg?: string | object; bg?: string | object }
      box: { children?: any; flexDirection?: string; flexGrow?: number | string; width?: number; flexShrink?: number }
    }
  }
}
