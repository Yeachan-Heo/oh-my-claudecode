#!/usr/bin/env sh

resolve_claude_config_dir() {
  configured="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  configured="${configured%/}"
  case "$configured" in
    \~)
      printf '%s\n' "$HOME"
      ;;
    \~/*)
      configured="${configured#\~/}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    *)
      printf '%s\n' "$configured"
      ;;
  esac
}
