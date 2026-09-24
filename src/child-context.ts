/** Approximate active request size; used only for explicitly opted-in children. */
export interface ChildContextLimit { targetInput: number; hardInput: number }

export function parseChildLimits(raw: unknown): Record<string, ChildContextLimit> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("childLimits must be an object")
  const limits: Record<string, ChildContextLimit> = {}
  for (const [pin, value] of Object.entries(raw)) {
    if (!/^[^/#]+\/.+/.test(pin) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid childLimits entry: ${pin}`)
    const item = value as Record<string, unknown>
    if (!Number.isInteger(item.targetInput) || !Number.isInteger(item.hardInput) ||
      (item.targetInput as number) < 1 || (item.hardInput as number) <= (item.targetInput as number)) {
      throw new Error(`childLimits ${pin}: require integer targetInput < hardInput`)
    }
    limits[pin] = { targetInput: item.targetInput as number, hardInput: item.hardInput as number }
  }
  return limits
}

/** Conservative text proxy, not a tokenizer: separate from cumulative session usage. */
export function estimateRequestInput(system: unknown, messages: unknown, tools: unknown): number {
  try {
    const text = JSON.stringify([system, messages, tools])
    return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
  } catch { return Number.POSITIVE_INFINITY }
}

export function childLimitFor(model: { providerID: string; id: string; variant?: string }, limits: Record<string, ChildContextLimit>): ChildContextLimit | undefined {
  const pin = `${model.providerID}/${model.id}`
  return limits[`${pin}#${model.variant}`] ?? limits[pin]
}
