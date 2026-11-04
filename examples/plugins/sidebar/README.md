# Sidebar and docked views example

A small Go backend plus one HTML page demonstrating every plugin entry point added for tools like SSH:

- `sidebar`: the SSH group in the left connection tree (`list` returns bounded nodes);
- `views`: the terminal page in the right-hand dock;
- `keybindings`: `CmdOrCtrl+Shift+T` opens the terminal page;
- `navigation.location: "statusbar"`: a status-bar entry;
- page bridge capabilities: `plugin.invoke`, `progress.report`, `dialog.confirm`.

Build it with the example packager from the repository root:

```sh
go -C examples/plugins run ./package \
  -source ./sidebar \
  -manifest ./sidebar/gonavi.plugin.json \
  -output /tmp/sidebar-package
```

`go test ./...` inside `examples/plugins` validates the manifest, the sidebar/view/keybinding declarations and the least-privilege permissions.
