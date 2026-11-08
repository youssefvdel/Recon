# Driving Recon with the Tauri MCP server

Recon embeds [`tauri-plugin-mcp-bridge`](https://crates.io/crates/tauri-plugin-mcp-bridge);
the AI-side half is [`@hypothesi/tauri-mcp-server`](https://github.com/hypothesi/mcp-server-tauri).

```
AI client (on the server)  ──stdio──  MCP server (Node)  ──WebSocket──  Recon (PC)
```

The plugin executes JS inside the webview and invokes IPC commands **with no
authentication**. That is fine on loopback and unacceptable on a network, so the
plugin is registered with `.bind_address("127.0.0.1")` in `lib.rs`.

## Consequence

The MCP server connects to `127.0.0.1:9223`, so it must run **on the same machine
as Recon** — or reach it through a tunnel. Both work:

### On the PC (simplest)

```bash
npx -y @hypothesi/tauri-mcp-server
```

### From the server, through SSH (how our tooling does it)

```bash
# keep the tunnel open in the background
ssh -N -L 9223:127.0.0.1:9223 youssefvdel@192.168.100.3

# then the MCP server can run here
npx -y @hypothesi/tauri-mcp-server
```

Verify the bridge is listening on the PC before connecting:

```powershell
netstat -ano | findstr 9223     # expect 127.0.0.1:9223, never 0.0.0.0
```

The app logs `MCP Bridge plugin initialized for 'Recon' ... on 127.0.0.1:PORT` at
startup; the port is 9223 unless it is taken, in which case the plugin scans
upward.

## What it can do

Screenshots, DOM snapshots, clicks/typing, console + IPC logs, and
`ipc_execute_command`. Useful for verifying UI work against the real app without
opening a visible window.

## Why not bind to 0.0.0.0

It was bound to every interface in alpha9 and earlier. QA proved from another
machine that `execute_js` and `invoke` worked over the LAN with no credential —
any device on the Wi-Fi could drive Recon. Loopback plus a tunnel gives the same
capability with an authenticated boundary (SSH).
