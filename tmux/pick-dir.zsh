#!/bin/zsh

# Asks which directory to open something in, from the ones you work in, and
# prints it. For the popups that open a tab running Claude: new-tab.zsh (M-t,
# M-n) and shape-open.zsh (the palette's "Continue shaping Linear tickets").
#
# Usage: dir=$(pick-dir.zsh [--windows] "<what Enter does>") || exit 0
#
# An fzf list, the way the Slack relay's places and the Work map find them:
# the directory you are in first (the popup's -d), then every open tab's, then
# every one a Claude session ran in, most recent first, from wt-revive's cache
# (~/.cache/wt-revive/index.json, kept fresh by the sidebar daemon), then your
# home. Only directories that still exist are listed, and no worktree but the
# one you are in. Type to narrow it; Enter takes the chosen one, or, when
# nothing matches, what you typed if it is a directory. Exits 1 on Esc or a
# path that isn't a directory, having said which.
#
# With --windows (new-tab.zsh), folders on the Windows machine in
# ~/.config/remote-winmux/config.json are listed too, as <host>:<path>: the
# open Windows tabs' with the open tabs, the ones remote-tab.zsh opened
# (~/.local/state/remote-winmux/recent) among the recent ones by when, then the
# config's projects, if it names any. None of it asks the machine, so the list
# is as quick as ever; a <host>:<path> typed in opens a folder not listed yet.
# What it prints for one is the row as shown, for remote-tab.zsh.

windows= host= open_windows=() projects=()
if [[ $1 == --windows ]]; then
  shift
  host=$(jq -r '.host // empty' ~/.config/remote-winmux/config.json 2>/dev/null)
  [[ -n $host ]] && windows=1
fi

here=$PWD
typeset -U dirs
if [[ -n $windows ]]; then
  # Claude's directories and the Windows folders opened, merged by when, the
  # Windows ones marked with the host.
  recents=(${(f)"$(
    { jq -r '.transcripts | .[] | select(.cwd) | "\((.mtimeMs // 0) / 1000 | floor)\t\(.cwd)"' ~/.cache/wt-revive/index.json 2>/dev/null
      awk -F'\t' -v h="$host" '{ print $1 "\t" h ":" $2 }' ~/.local/state/remote-winmux/recent 2>/dev/null
    } | sort -t$'\t' -k1,1 -rn | cut -f2-
  )"})
  open_windows=(${(f)"$(tmux list-panes -a -F '#{@remote_cwd}' 2>/dev/null)"})
  projects=(${(f)"$(jq -r '(.projects // {}) | .[]' ~/.config/remote-winmux/config.json 2>/dev/null)"})
else
  recents=(${(f)"$(jq -r '.transcripts | to_entries | sort_by(-.value.mtimeMs) | .[].value.cwd // empty' ~/.cache/wt-revive/index.json 2>/dev/null)"})
fi
dirs=(
  "$here"
  ${(f)"$(tmux list-panes -a -F '#{?@sidebar,,#{?@remote_cwd,,#{pane_current_path}}}' 2>/dev/null)"}
  ${open_windows/#/$host:}
  $recents
  ${projects/#/$host:}
  "$HOME"
)
shown=()
# Worktrees (.claude/worktrees/…) are left out: there are dozens, and a new
# tab belongs in a repository, where wt or wtpr makes its worktree. The one you
# are in stays, first, since that is where you asked from.
for dir in $dirs; do
  if [[ -n $windows && $dir == "$host":* ]]; then
    shown+=("$dir")
    continue
  fi
  [[ $dir == */.claude/worktrees/* && $dir != "$here" ]] && continue
  [[ -n $dir && -d $dir ]] && shown+=("${dir/#$HOME/~}")
done

# fzf prints the query, then the choice: none when nothing matches (exit 1),
# and it exits 130 on Esc. Its list is drawn on the terminal, not on stdout.
out=$(print -rl -- $shown | fzf --print-query --no-sort --layout=reverse --height=100% \
  --prompt='Open in > ' --header="${1:-Enter picks it}; a path you type works too. Esc cancels.")
(( $? == 130 )) && exit 1
picked=("${(@f)out}")
choice=${picked[2]:-${picked[1]}}
[[ -n $choice ]] || exit 1
if [[ -n $windows && $choice == "$host":[A-Za-z]:\\* ]]; then
  print -r -- "$choice"
  exit 0
fi
dir=${choice/#\~/$HOME}
if [[ ! -d $dir ]]; then
  print -u2 "\n  \e[31mNo such directory: $choice\e[0m\n\n  \e[38;5;244mPress any key to close.\e[0m"
  read -sk 1
  exit 1
fi
print -r -- "$dir"
