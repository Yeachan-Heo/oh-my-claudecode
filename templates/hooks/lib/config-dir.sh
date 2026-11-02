#!/usr/bin/env sh

resolve_claude_config_dir() {
  configured="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  configured="${configured#${configured%%[![:space:]]*}}"
  configured="${configured%${configured##*[![:space:]]}}"
  # Match the JS helpers: a blank override means the default directory.
  configured="${configured:-$HOME/.claude}"
  if [ "$configured" != "/" ]; then
    configured="${configured%/}"
  fi
  case "$configured" in
    \~)
      printf '%s\n' "$HOME"
      ;;
    \~/*)
      configured="${configured#\~/}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    \~\\*)
      configured="${configured#\~}"
      configured="${configured#\\}"
      printf '%s/%s\n' "$HOME" "$configured"
      ;;
    *)
      printf '%s\n' "$configured"
      ;;
  esac
}
