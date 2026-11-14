# systemd user service

Install the current build for the current Linux user:

```sh
taga daemon install --brain="$HOME/.taga/brain"
```

Lifecycle commands are idempotent:

```sh
taga daemon start
taga daemon status
taga daemon restart
taga daemon stop
taga daemon uninstall
```

The unit is stored below `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`. Uninstalling removes only the unit and preserves the Brain directory. When systemd is unavailable, `taga daemon run` keeps the foreground runtime available.
