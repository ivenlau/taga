# launchd user service

Install the current build for the current macOS user:

```sh
taga daemon install --brain="$HOME/.taga/brain"
```

The plist is stored at `~/Library/LaunchAgents/com.taga.daemon.plist`. Install, start, status, restart, stop, and uninstall are idempotent and never remove the Brain directory.

When `launchctl` is unavailable or the user agent is stopped, use `taga daemon start` or `taga daemon run`; CLI, MCP, and the local Fast Path remain available.
