# OMC CLI Notes

The standalone analytics CLI has been removed.

Use the main `omc` CLI (`src/cli/index.ts`) for supported commands such as:

- `omc` / `omc launch`
- `omc hud`
- `omc wait`, `omc status`, `omc daemon`
- `omc setup`, `omc update`, `omc info`

For runtime observability, use HUD output and replay logs under `.omc/state/`.
