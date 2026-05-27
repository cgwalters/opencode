import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { TrimToolResultTool } from "@/tool/trim_tool_result"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = Layer.mergeAll(Agent.defaultLayer, Bus.layer, Session.defaultLayer, Truncate.defaultLayer)

const it = testEffect(layer)

// Seeds a session with a user message, assistant message, and a completed tool
// part. Returns enough context to exercise the tool and verify its effects.
const seed = Effect.fn("TrimToolResultTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({})

  const userID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: userID,
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })

  const assistantID = MessageID.ascending()
  const assistant: MessageV2.Assistant = {
    id: assistantID,
    role: "assistant",
    parentID: userID,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)

  const partID = PartID.ascending()
  const toolPart: MessageV2.ToolPart = {
    id: partID,
    sessionID: chat.id,
    messageID: assistantID,
    type: "tool",
    callID: "call-1",
    tool: "shell",
    state: {
      status: "completed",
      input: { command: "ls -la" },
      output: "total 0\n-rw-r--r-- 1 user user 0 Jan 1 00:00 file.txt",
      title: "Shell",
      metadata: {},
      time: { start: Date.now(), end: Date.now() + 100 },
      attachments: [
        {
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistantID,
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,abc123",
        },
      ],
    },
  }
  yield* sessions.updatePart(toolPart)

  const messages: MessageV2.WithParts[] = [
    {
      info: { id: userID, role: "user", sessionID: chat.id, agent: "build", model: ref, time: { created: Date.now() } },
      parts: [],
    },
    {
      info: assistant,
      parts: [toolPart],
    },
  ]

  return { chat, assistant, assistantID, partID, toolPart, messages }
})

// Convenience: build a ctx object for execute() calls
const ctx = (sessionID: SessionID, messages: MessageV2.WithParts[]) => ({
  sessionID,
  messageID: MessageID.ascending(),
  callID: "call-trim",
  agent: "build" as const,
  abort: new AbortController().signal,
  messages,
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.trim_tool_result", () => {
  it.instance("replaces the output of the most recent completed tool part with the summary", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, partID, toolPart, messages } = yield* seed()

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      const summary = "Directory contains one empty file: file.txt"
      const result = yield* def.execute(
        { results: [{ summary }] },
        ctx(chat.id, messages),
      )

      expect(result.output).toContain("shell")
      expect(result.output).toContain("Trimmed")
      expect(result.output).toContain("reduction")

      const updated = yield* sessions.getPart({ sessionID: chat.id, messageID: toolPart.messageID, partID })
      const completedState = (updated as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(completedState.output).toBe(summary)
      expect(completedState.attachments).toBeUndefined()
    }),
  )

  it.instance("returns a friendly message when no completed tool result exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { results: [{ summary: "nothing to trim" }] },
        ctx(chat.id, []),
      )

      expect(result.output).toContain("No untrimmed tool result found")
    }),
  )

  it.instance("skips trim_tool_result parts and targets the previous tool", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, partID, toolPart, messages } = yield* seed()

      const trimPart: MessageV2.ToolPart = {
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: toolPart.messageID,
        type: "tool",
        callID: "call-prior-trim",
        tool: "trim_tool_result",
        state: {
          status: "completed",
          input: { results: [{ summary: "old summary" }] },
          output: "Trimmed 'shell': ...",
          title: "Trim Tool Result",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 10 },
        },
      }
      yield* sessions.updatePart(trimPart)

      const messagesWithTrim: MessageV2.WithParts[] = [
        messages[0],
        { info: messages[1].info, parts: [...messages[1].parts, trimPart] },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      const summary = "Trimmed again"
      yield* def.execute({ results: [{ summary }] }, ctx(chat.id, messagesWithTrim))

      const updated = yield* sessions.getPart({ sessionID: chat.id, messageID: toolPart.messageID, partID })
      const completedState = (updated as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(completedState.output).toBe(summary)
    }),
  )

  it.instance("reports a friendly message when the most recent tool result is already trimmed", () =>
    Effect.gen(function* () {
      const { chat, toolPart, messages } = yield* seed()

      const state = toolPart.state as MessageV2.ToolStateCompleted
      const trimmedMessages: MessageV2.WithParts[] = [
        messages[0],
        {
          info: messages[1].info,
          parts: [{ ...toolPart, state: { ...state, metadata: { ...state.metadata, trimmed: true } } }],
        },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { results: [{ summary: "should not be used" }] },
        ctx(chat.id, trimmedMessages),
      )

      expect(result.output).toContain("No untrimmed tool result found")
    }),
  )

  it.instance("batch-trims multiple results with one entry each, most-recent first", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, assistantID, toolPart, messages } = yield* seed()

      const part2ID = PartID.ascending()
      const toolPart2: MessageV2.ToolPart = {
        id: part2ID,
        sessionID: chat.id,
        messageID: assistantID,
        type: "tool",
        callID: "call-2",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/big.txt" },
          output: "A very large file content that should be trimmed",
          title: "Read",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 50 },
        },
      }
      yield* sessions.updatePart(toolPart2)

      const messagesWithBoth: MessageV2.WithParts[] = [
        messages[0],
        { info: assistant, parts: [toolPart, toolPart2] },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          results: [
            { summary: "Summary of read output" },
            { summary: "Summary of shell output" },
          ],
        },
        ctx(chat.id, messagesWithBoth),
      )

      expect(result.output).toContain("read")
      expect(result.output).toContain("shell")

      // read (most recent) gets first entry's summary
      const state2 = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: part2ID })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(state2.output).toBe("Summary of read output")
      expect(state2.metadata.trimmed).toBe(true)

      // shell gets second entry's summary
      const state1 = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: toolPart.id })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(state1.output).toBe("Summary of shell output")
      expect(state1.metadata.trimmed).toBe(true)
    }),
  )

  it.instance("single entry with two untrimmed parts trims only the most recent and lists the other", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, assistantID, toolPart, messages } = yield* seed()

      const part2ID = PartID.ascending()
      const toolPart2: MessageV2.ToolPart = {
        id: part2ID,
        sessionID: chat.id,
        messageID: assistantID,
        type: "tool",
        callID: "call-2",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/big.txt" },
          output: "Second big output",
          title: "Read",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 50 },
        },
      }
      yield* sessions.updatePart(toolPart2)

      const messagesWithBoth: MessageV2.WithParts[] = [
        messages[0],
        { info: assistant, parts: [toolPart, toolPart2] },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { results: [{ summary: "Summary of most recent output" }] },
        ctx(chat.id, messagesWithBoth),
      )

      // Most recent (read) trimmed
      expect(result.output).toContain("read")
      expect(result.output).toContain("Trimmed")
      // Still-untrimmed listing mentions the shell part
      expect(result.output).toContain("Still untrimmed")
      expect(result.output).toContain("shell")

      const state2 = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: part2ID })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(state2.output).toBe("Summary of most recent output")
      expect(state2.metadata.trimmed).toBe(true)

      const state1 = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: toolPart.id })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(state1.metadata.trimmed).toBeUndefined()
    }),
  )

  it.instance("tool hint skips non-matching tools and targets the right one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, assistantID, toolPart, messages } = yield* seed()

      // Add a second part for a different tool (read)
      const part2ID = PartID.ascending()
      const toolPart2: MessageV2.ToolPart = {
        id: part2ID,
        sessionID: chat.id,
        messageID: assistantID,
        type: "tool",
        callID: "call-2",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/big.txt" },
          output: "Large file contents",
          title: "Read",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 50 },
        },
      }
      yield* sessions.updatePart(toolPart2)

      const messagesWithBoth: MessageV2.WithParts[] = [
        messages[0],
        { info: assistant, parts: [toolPart, toolPart2] },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      // Target 'shell' specifically even though 'read' is more recent
      const result = yield* def.execute(
        { results: [{ tool: "shell", summary: "Shell summary" }] },
        ctx(chat.id, messagesWithBoth),
      )

      expect(result.output).toContain("shell")
      expect(result.output).toContain("Trimmed")

      const state1 = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: toolPart.id })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(state1.output).toBe("Shell summary")
      expect(state1.metadata.trimmed).toBe(true)

      // read was NOT trimmed
      const state2 = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: part2ID })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(state2.metadata.trimmed).toBeUndefined()
    }),
  )

  it.instance("input_contains hint targets the right bash invocation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant, assistantID, messages } = yield* seed()

      // Two bash parts with different commands
      const lsPart: MessageV2.ToolPart = {
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistantID,
        type: "tool",
        callID: "call-ls",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls -al /usr/bin" },
          output: "huge ls output",
          title: "Bash",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 10 },
        },
      }
      const makePart: MessageV2.ToolPart = {
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: assistantID,
        type: "tool",
        callID: "call-make",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "make build" },
          output: "huge make output",
          title: "Bash",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 20 },
        },
      }
      yield* sessions.updatePart(lsPart)
      yield* sessions.updatePart(makePart)

      const msgs: MessageV2.WithParts[] = [
        messages[0],
        { info: assistant, parts: [lsPart, makePart] },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      // Trim the ls one specifically
      const result = yield* def.execute(
        { results: [{ tool: "bash", input_contains: "ls -al /usr/bin", summary: "ls summary" }] },
        ctx(chat.id, msgs),
      )

      expect(result.output).toContain("Trimmed")

      const lsState = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: lsPart.id })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(lsState.output).toBe("ls summary")
      expect(lsState.metadata.trimmed).toBe(true)

      const makeState = ((yield* sessions.getPart({ sessionID: chat.id, messageID: assistantID, partID: makePart.id })) as MessageV2.ToolPart).state as MessageV2.ToolStateCompleted
      expect(makeState.metadata.trimmed).toBeUndefined()
    }),
  )

  it.instance("cannot trim a tool result from a previous turn (before the last user message)", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistantID, toolPart } = yield* seed()

      const user2ID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: user2ID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      const asst2ID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: asst2ID,
        role: "assistant",
        parentID: user2ID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      })

      const crossTurnMessages: MessageV2.WithParts[] = [
        { info: { id: MessageID.ascending(), role: "user", sessionID: chat.id, agent: "build", model: ref, time: { created: Date.now() } }, parts: [] },
        { info: { id: assistantID, role: "assistant", parentID: MessageID.ascending(), sessionID: chat.id, mode: "build", agent: "build", cost: 0, path: { cwd: "/tmp", root: "/tmp" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: ref.modelID, providerID: ref.providerID, time: { created: Date.now() } }, parts: [toolPart] },
        { info: { id: user2ID, role: "user", sessionID: chat.id, agent: "build", model: ref, time: { created: Date.now() } }, parts: [] },
        { info: { id: asst2ID, role: "assistant", parentID: user2ID, sessionID: chat.id, mode: "build", agent: "build", cost: 0, path: { cwd: "/tmp", root: "/tmp" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: ref.modelID, providerID: ref.providerID, time: { created: Date.now() } }, parts: [] },
      ]

      const tool = yield* TrimToolResultTool
      const def = yield* tool.init()

      // The only tool part is in the previous turn — should not be found
      const result = yield* def.execute(
        { results: [{ summary: "should not work" }] },
        ctx(chat.id, crossTurnMessages),
      )

      expect(result.output).toContain("No untrimmed tool result found")
    }),
  )
})
