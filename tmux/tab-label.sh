#!/usr/bin/env bash

# Prints the label for the window <target> whose pane is at <path>: the name
# set with M-p's "Rename the tab", else the Linear ticket and its title, else
# the name accent-color.sh gives the directory, or for a Windows tab the same
# name for its folder there. path-facts.sh works out the last two.
#
# Usage: tab-label.sh <target> <path> [<label>]
#
# <label> is path-facts.sh's label for <path>, from a caller that has already
# asked it for the color and PR, so it isn't asked twice.
#
# window-names.sh puts this in the tab and tab-status.sh at the front of the
# second status line, so the two can never disagree about what a window is.
# Runs for every window on every pane focus, so it never waits on the network:
# path-facts.sh answers from caches.

set -u

target="${1:-}"
path="${2:-}"
label="${3:-}"
[ -n "$target" ] || exit 0

# A tab on the Windows machine (tmux/remote-tab.zsh) is named for its folder
# and branch there as accent-color.sh names a local one, the trunk left
# unsaid: its pane's own directory is only where the attach runs.
# bin/remote-winmux's watcher keeps @remote_branch from the session's events,
# so asking costs no network. \x1f between the fields, since tabs would
# collapse an empty one.
IFS=$'\x1f' read -r name remote remote_cwd branch <<<"$(tmux display -p -t "$target" $'#{@tab_name}\x1f#{@remote}\x1f#{@remote_cwd}\x1f#{@remote_branch}' 2>/dev/null)"
if [ -n "$name" ]; then
  printf '%s' "$name"
  exit 0
fi
if [ -n "$remote" ]; then
  dir=${remote_cwd%\\}
  dir=${dir##*\\}
  case "$branch" in
    ''|main|master) printf '%s' "${dir:-$remote}" ;;
    *) printf '%s' "${dir:-$remote}:$branch" ;;
  esac
  exit 0
fi

[ -n "$label" ] || IFS=$'\t' read -r _ label _ <<<"$("${0%/*}/path-facts.sh" "$path")"
printf '%s' "$label"
