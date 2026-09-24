/**
 * Portable RPC definition for the ultracode plugin channel.
 * Host-free JSON Schema only — no @opencode/plugin import (CONTRACTS.md).
 *
 * `ctx.rpc.register` is available on the pinned @opencode/plugin build
 * (0.0.0-beta-19289). Callers still capability-gate and fail soft so older
 * hosts keep session-heuristic TUI.
 */
export const ULTRACODE_RPC_ID = "ultracode"

const RUN_ID = { type: "string" as const }
const RUN_STATUS = { type: "string" as const }
const SOURCE = { type: "string" as const }
const NUMBER = { type: "number" as const }
const PANEL_SETTINGS_SCHEMA = {
  type: "object" as const,
  properties: {
    concurrency: NUMBER,
    maxAgents: NUMBER,
    timeoutMs: NUMBER,
    permissions: { type: "string" as const },
  },
}

export const ULTRACODE_RPC = {
  id: ULTRACODE_RPC_ID,
  methods: {
    control: {
      input: {
        type: "object" as const,
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string" as const },
          runID: RUN_ID,
          // Ask mode: validated pin, applied as the run-level fallback override.
          model: { type: "string" as const },
          remember: { type: "boolean" as const },
        },
      },
      output: {
        type: "object" as const,
        required: ["runID", "action", "status"],
        properties: {
          runID: RUN_ID,
          action: { type: "string" as const },
          status: RUN_STATUS,
          model: { type: "string" as const },
          remembered: { type: "string" as const },
          rememberError: { type: "string" as const },
        },
      },
    },
    runStatus: {
      input: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          runID: RUN_ID,
          sessionID: { type: "string" as const },
          limit: NUMBER,
          includeFinished: { type: "boolean" as const },
        },
      },
      output: {
        type: "object" as const,
        required: ["runs"],
        properties: {
          runs: {
            type: "array" as const,
            items: {
              type: "object" as const,
              required: ["runID", "status", "agents", "startedAt", "source"],
              properties: {
                runID: RUN_ID,
                status: RUN_STATUS,
                startedAt: NUMBER,
                source: SOURCE,
                parentSessionID: { type: "string" as const },
                name: { type: "string" as const },
                workflowName: { type: "string" as const },
                endedAt: NUMBER,
                runningCount: NUMBER,
                queuedCount: NUMBER,
                agentDetails: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    required: ["id", "status"],
                    properties: {
                      id: RUN_ID,
                      sessionID: RUN_ID,
                      status: RUN_STATUS,
                      phase: { type: "string" as const },
                      label: { type: "string" as const },
                      // Provenance for children with no session in this run
                      // (warm-replayed): the panel joins details by session.
                      requestedAgent: { type: "string" as const },
                      effectiveAgent: { type: "string" as const },
                      effectiveModel: {
                        type: "object" as const,
                        required: ["providerID", "id"],
                        properties: {
                          providerID: { type: "string" as const },
                          id: { type: "string" as const },
                          variant: { type: "string" as const },
                        },
                      },
                      // Intended spawn model (provenance when a failover
                      // changed what actually ran).
                      spawnModel: {
                        type: "object" as const,
                        required: ["providerID", "id"],
                        properties: {
                          providerID: { type: "string" as const },
                          id: { type: "string" as const },
                          variant: { type: "string" as const },
                        },
                      },
                      tokens: {
                        type: "object" as const,
                        required: ["input", "output"],
                        properties: {
                          input: NUMBER,
                          output: NUMBER,
                          reasoning: NUMBER,
                        },
                      },
                      toolCalls: NUMBER,
                    },
                  },
                },
                projectID: { type: "string" as const },
                directory: { type: "string" as const },
                agents: {
                  type: "object" as const,
                  required: ["done", "total", "failed"],
                  properties: {
                    done: NUMBER,
                    total: NUMBER,
                    failed: NUMBER,
                  },
                },
              },
            },
          },
        },
      },
    },
    settings: {
      input: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          runID: RUN_ID,
          sessionID: { type: "string" as const },
        },
      },
      output: {
        type: "object" as const,
        required: ["overlay"],
        properties: {
          overlay: PANEL_SETTINGS_SCHEMA,
          runID: RUN_ID,
          effective: PANEL_SETTINGS_SCHEMA,
        },
      },
    },
  },
  events: {
    runState: {
      schema: {
        type: "object" as const,
        required: ["runID", "status"],
        properties: {
          runID: RUN_ID,
          status: RUN_STATUS,
          reason: { type: "string" as const },
          parentSessionID: { type: "string" as const },
          projectID: { type: "string" as const },
          directory: { type: "string" as const },
          runningCount: NUMBER,
        },
      },
    },
  },
} as const
