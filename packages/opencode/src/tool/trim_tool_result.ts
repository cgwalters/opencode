import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "../session/session"
import type { MessageV2 } from "../session/message-v2"
import { formatBytes } from "../util/format"

const TrimEntry = Schema.Struct({
  summary: Schema.String.annotate({
    description: "Concise summary to replace the original output. Preserve key facts, errors, and warnings.",
  }),
  tool: Schema.optional(Schema.String).annotate({
    description:
      "Optional tool name hint (e.g. 'bash', 'read', 'mcp__filesystem__read_file'). " +
      "When provided, skips parts whose tool name does not match. " +
      "Useful when multiple different tools ran and you want to trim a specific one.",
  }),
  input_contains: Schema.optional(Schema.String).annotate({
    description:
      "Optional substring to match against the tool's input (e.g. 'ls -al /usr/bin', 'make build'). " +
      "When provided, skips parts whose serialized input does not contain this string. " +
      "Combine with 'tool' to precisely target e.g. bash('ls') vs bash('make').",
  }),
})

export const Parameters = Schema.Struct({
  results: Schema.Array(TrimEntry).annotate({
    description:
      "One entry per tool result to trim. Pass multiple entries to batch-trim several results in one call " +
      "(e.g. after parallel tool invocations). Entries are processed in order.",
  }),
})

type Entry = Schema.Schema.Type<typeof TrimEntry>

function isTrimmable(part: MessageV2.Part, entry: Entry, trimmedThisCall: Set<string>): part is MessageV2.ToolPart {
  if (part.type !== "tool") return false
  if (part.state.status !== "completed") return false
  if (part.tool === "trim_tool_result") return false
  if (part.state.metadata?.trimmed) return false
  if (trimmedThisCall.has(part.callID)) return false
  if (entry.tool !== undefined && part.tool !== entry.tool) return false
  if (entry.input_contains !== undefined && !JSON.stringify(part.state.input).includes(entry.input_contains)) return false
  return true
}

export const TrimToolResultTool = Tool.define("trim_tool_result", Effect.gen(function*() {
  const sessionService = yield* Session.Service

  return {
    description: [
      "Replace tool results from the current turn with concise summaries to reduce context token usage.",
      "Use after large tool outputs (build logs, file listings, command output, web fetches, subagent results)",
      "that are no longer needed in full.",
      "",
      "IMPORTANT: Call this tool after you have finished extracting all information you need from a large",
      "tool output. Do NOT trim before you are done reading — you cannot un-trim. Once you have noted all",
      "key facts, errors, and file paths you will need, then trim.",
      "",
      "IMPORTANT: trim_tool_result takes a results[] array — one entry per tool result to trim. Each entry",
      "trims the most-recent untrimmed result in the current turn that matches any hints you provide.",
      "Pass N entries to trim N results. Any still-untrimmed results are listed in the output.",
      "",
      "Use 'tool' and 'input_contains' hints to target a specific result when multiple tools ran:",
      '  { "results": [',
      '      { "tool": "bash", "input_contains": "ls -al /usr/bin", "summary": "..." },',
      '      { "tool": "bash", "input_contains": "make build",      "summary": "..." }',
      "  ] }",
      "",
      "Without hints, trims the most-recent untrimmed result:",
      '  { "results": [ { "summary": "Build succeeded. 3 warnings in foo.rs:12, bar.rs:44." } ] }',
      "",
      "When to call trim_tool_result (call it after EVERY one of these):",
      "- After Bash/shell commands that produce long output (ls, find, cargo build, npm install, test runs, grep, etc.)",
      "- After reading a large file with the Read tool",
      "- After any WebFetch or web search that returns a long page or result set",
      "- After a Task/subagent returns a large result",
      "- Any time the previous tool output was more than ~20 lines",
      "",
      "How to write a good summary:",
      "- Preserve key facts, errors, warnings, file paths, counts, and any information you will need later",
      "- Omit repetitive lines, boilerplate, and details that are irrelevant to the task",
      "- A few sentences of prose is usually better than re-listing every line",
      "",
      "Calling trim frequently is strongly preferred over leaving large raw outputs in context.",
      "Each untrimmed result wastes tokens on every subsequent request and degrades model performance.",
    ].join("\n"),
    parameters: Parameters,
    execute: (args: Schema.Schema.Type<typeof Parameters>, ctx) => Effect.gen(function*() {
      // Only consider tool results from the current turn — messages since the last user message.
      const lastUserIdx = (() => {
        for (let i = ctx.messages.length - 1; i >= 0; i--)
          if (ctx.messages[i].info.role === "user") return i
        return 0
      })()
      const currentTurn = ctx.messages.slice(lastUserIdx + 1)

      // Track which parts have been trimmed in this invocation to handle the
      // "most recent untrimmed" fallback correctly across multiple entries.
      const trimmedThisCall = new Set<string>()

      const lines: string[] = []
      let totalOld = 0
      let totalNew = 0

      for (const entry of args.results) {
        // Find the most recent untrimmed completed non-trim part in the current turn,
        // optionally filtered by tool name and/or input substring.
        let targetPart: MessageV2.ToolPart | undefined
        for (let i = currentTurn.length - 1; i >= 0; i--) {
          const msg = currentTurn[i]
          for (let j = msg.parts.length - 1; j >= 0; j--) {
            const part = msg.parts[j]
            if (isTrimmable(part, entry, trimmedThisCall)) {
              targetPart = part
              break
            }
          }
          if (targetPart) break
        }

        if (!targetPart) {
          lines.push("No untrimmed tool result found in the current turn.")
          continue
        }

        const state = targetPart.state as MessageV2.ToolStateCompleted
        const oldLength = Buffer.byteLength(state.output, "utf-8")
        const newLength = Buffer.byteLength(entry.summary, "utf-8")
        const reduction = oldLength > 0 ? ((oldLength - newLength) / oldLength) * 100 : 0

        const updatedState: MessageV2.ToolStateCompleted = {
          ...state,
          output: entry.summary,
          attachments: undefined,
          metadata: {
            ...state.metadata,
            trimmed: true,
            trimReduction: reduction,
            ...(state.metadata?.output ? { output: entry.summary } : {}),
          },
        }
        yield* sessionService.updatePart({ ...targetPart, state: updatedState })

        trimmedThisCall.add(targetPart.callID)
        totalOld += oldLength
        totalNew += newLength
        lines.push(
          `Trimmed '${targetPart.tool}': ${formatBytes(oldLength)} -> ${formatBytes(newLength)} (${reduction.toFixed(1)}% reduction).`,
        )
      }

      // After processing all entries, report any untrimmed parts still remaining in the current
      // turn so the model knows it needs to trim them too.
      const stillUntrimmed: string[] = []
      for (const msg of currentTurn) {
        for (const part of msg.parts) {
          if (
            part.type === "tool" &&
            part.state.status === "completed" &&
            part.tool !== "trim_tool_result" &&
            !part.state.metadata?.trimmed &&
            !trimmedThisCall.has(part.callID)
          ) {
            const size = formatBytes(Buffer.byteLength((part.state as MessageV2.ToolStateCompleted).output, "utf-8"))
            stillUntrimmed.push(`  - '${part.tool}': ${size}`)
          }
        }
      }
      if (stillUntrimmed.length > 0)
        lines.push(`\nStill untrimmed in this turn — call trim_tool_result again for each:\n${stillUntrimmed.join("\n")}`)

      return {
        title: "Trim Tool Result",
        output: lines.join("\n"),
        metadata: {
          oldLength: totalOld,
          newLength: totalNew,
          reduction: totalOld > 0 ? ((totalOld - totalNew) / totalOld) * 100 : 0,
          trimCount: trimmedThisCall.size,
        },
      }
    }),
  }
}))
