# MCP setup

The shipped MCP server uses stdio and converts calls into requests to the local Writeback WebSocket bridge. It is not a Streamable HTTP server.

`get_scale` and `resolve` are annotated read-only. `edit` and `undo` are annotated destructive because they modify source, even though writes are constrained and undoable.

Inputs are validated before bridge access. Relative paths containing `..`, invalid locations, unsupported groups, empty hashes, malformed variants, and unknown tools return JSON-RPC invalid-params errors. Successful calls return both text and `structuredContent`.

The adapter connects to `ws://127.0.0.1:${WRITEBACK_PORT}` and defaults to `7331`. It exposes no arbitrary host setting.

Adding local HTTP transport would not make it usable by hosted ChatGPT. Production remote transport must be designed with authentication, secure project pairing, authorization, and source-data handling.
