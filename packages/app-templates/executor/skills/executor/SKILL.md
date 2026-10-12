---
name: executor
description: Start here. What Executor is, how to find and call app tools with search, call and execute, when to build an app, and when to send feedback.
---

# Executor

## What Executor is

Executor is a host that runs apps: TypeScript packages that expose tools,
storage, UI, accounts and background work. Agents reach every app through the
same few MCP tools: `skills`, `search`, `describe`, `call` and `execute`. Each
app's slug is its namespace in all of them.
Credentials go only through Executor's secure connection links, never through
chat or source code. Some calls pause until the user approves them.

This is the `executor` skill of the Executor app (slug `executor` unless
renamed). Read its other skills with the `skills` tool, for example
`{app: "executor", name: "code-mode"}`. `{}` lists every visible skill.

## Find and call tools

Find tools with `search({ query: "..." })`. It returns each tool's exact
`path`, such as `tools.<slug>.<tool>`, and its input type; `describe({ paths })`
returns full signatures. Never guess argument names.

For one or a few independent calls, use `call({ calls: { path, input } })`, or
pass an array as `calls` to run them concurrently. Each result has `ok` and its
`value` or `error`.

Write a JavaScript program for `execute` when one call's result feeds another,
or a large result should be filtered before it reaches you. Inside it, the same
paths are async functions, and `tools.search` and `tools.search.describe` work
as above. Return only the data you need. For depth, read the `code-mode` skill.

`call` and `execute` can pause for approval or input. Show the request to the
user and resume it; never repeat the call or run the program again.

## Build an app

Build an app when the user needs tools, data, a UI or automation that no
existing app provides. For a known service, check Executor's catalog first:
Quick Add on the Add app page installs published apps and remote MCP servers
without code. With a shell, keep the source in a directory and deploy it with
the `executor apps` CLI; without one, build through `execute`. Read the
`app-authoring` skill before writing an app.

## Send feedback

Send feedback with the Executor app's `feedback.submit` tool when Executor gets
in your way, when you need something it cannot do, when something works
especially well, or when the user has feedback about it. Before your final
reply, check whether anything is worth reporting. Be specific. Never include
credentials or user data. Read `feedback.md` in this skill for details.
