# Security

## Controls

- The bridge listens on IPv4 loopback only.
- Browser `/api` and WebSocket origins are limited to the bridge's own origin; `/health` returns liveness only.
- Paths are checked lexically and through `realpath` to reject traversal and symlink escapes.
- Import following accepts relative project modules only and excludes `node_modules`.
- Optimistic hashes cover every edited source; cross-file `cva` hashes cover call site and definition.
- Tailwind syntax is validated before splicing; off-scale values require explicit raw syntax.
- JSX edits are reparsed before writes; CSS token edits are rescanned and verified.
- Undo checks post-edit hashes before restoring source.
- Checkpoints use a temporary Git index and never checkout, reset, or stash.
- MCP exposes no shell, arbitrary command, arbitrary host, or unrestricted file tool.

## Trust assumptions

Headerless local clients are treated as the local operating-system user. Do not proxy, tunnel, or bind the bridge beyond loopback.

The `.writeback` journal contains source snapshots needed for undo. Treat it like source code and exclude it from publication.

A dedicated security contact has not been supplied and remains a blocker for a public directory listing.
