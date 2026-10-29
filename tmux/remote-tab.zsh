#!/bin/zsh -i

# Opens a tab, or a split, on a folder of the Windows machine
# (bin/remote-winmux). Run with -i for the PATH the tmux server lacks, since
# remote-winmux is a node script.
#
# Usage: remote-tab.zsh open <path>
#        remote-tab.zsh split <split-window flags> <pane>
#        remote-tab.zsh restore
#        remote-tab.zsh here <path> <claude session id>
#
# open, for new-tab.zsh when M-t's choice is one, always opens a new tab, as
# M-t does for a local directory, with a new Claude unless one on that folder
# is running there with no tab, which it takes back; so a folder can have as
# many as you like, each its own session; closing the tab ends it, as closing
# a local one does (client.js's attach). A folder that is one of the projects
# in ~/.config/remote-winmux/config.json gets that project's name for its
# session, any other the name of its last part; with that name in use there,
# "-2", and so on. Each folder opened goes at the top of
# ~/.local/state/remote-winmux/recent (<epoch>\t<path>, the last 20), which
# pick-dir.zsh lists among the recent directories.
#
# split, for M-H/J/K/L in a Windows pane, opens PowerShell there in the same
# folder, as a local split opens a shell in the pane's directory: a session
# of its own, ended when its pane closes.
#
# Each pane carries its session's name in its own @remote, which is how the
# watcher finds it (lib/remote-winmux/watch.js), its folder in @remote_cwd,
# which tab-label.sh names the tab by with the branch there and pick-dir.zsh
# lists among the open tabs', and its program in @remote_program (claude, pwsh
# or lazygit), which the status line names when Claude isn't in front. Pane options, not the window's, so
# a split is its own session beside the Claude; formats read a pane's before
# its window's, so #{@remote} anywhere a pane is in hand is that pane's.

zmodload zsh/datetime
dim=$'\e[38;5;244m' red=$'\e[31m' reset=$'\e[0m'
script_dir=${0:A:h}
recent=~/.local/state/remote-winmux/recent

fail() {
  print "\n  ${red}$1${reset}"
  print -n "\n  ${dim}Press any key to close.${reset}"
  read -sk 1
  exit 0
}

# The attach a pane runs: attach_command <name> <cwd> <program> [<more flags>].
# If the connection fails, the pane stays until a key is pressed, so its
# error can be read.
attach_command() {
  local attach="remote-winmux attach ${(q)1} --cwd ${(q)2} --program $3${4:+ $4} || { print -n '\n  Press any key to close.'; read -sk 1 }"
  print -r -- "zsh -i -c ${(q)attach}"
}

# The Mac's stand-in for a session's repository, which its pane runs in:
# prints its directory, making it first if need be (a repository of one empty
# commit, which lib/remote-winmux/watch.js keeps on the branch Windows is on,
# with its origin), so everything that asks git and gh about the pane's
# directory finds the branch's PR as for a local one.
standin() {
  local dir=~/.local/state/remote-winmux/repos/$1
  if [[ ! -d $dir/.git ]]; then
    mkdir -p $dir && git -C $dir init -q &&
      git -C $dir -c user.name=remote-winmux -c user.email=remote-winmux@localhost commit -q --allow-empty -m "stand-in for a Windows repository"
  fi
  print -r -- $dir
}

# A name for a new session on <cwd> no session there and no pane here has, in
# $name: its project's in ~/.config/remote-winmux/config.json, else its folder's
# last part, then "-2" and so on. With adopt, a Claude there on that folder no
# pane here has (its tab went with a tmux that stopped, say) is still your
# Claude, so the tab takes it back rather than starting another beside it.
pick_name() {
  local cwd=$1 adopt=${2:-} base running orphan n
  local -a panes taken
  base=$(jq -r --arg p "$cwd" '(.projects // {}) | to_entries | map(select(.value == $p)) | .[0].key // empty' ~/.config/remote-winmux/config.json 2>/dev/null)
  [[ -n $base ]] || base=$(remote-winmux name-for "$cwd")
  [[ -n $base ]] || fail "remote-winmux could not name a session for $cwd"
  print -n "  ${dim}Asking the Windows machine…${reset}"
  running=$(remote-winmux ls --json 2>&1) || fail "${running:-remote-winmux ls failed}"
  print -n "\r\e[K"
  panes=(${(f)"$(tmux list-panes -a -F '#{@remote}' 2>/dev/null)"})
  name=
  if [[ -n $adopt ]]; then
    for orphan in ${(f)"$(P=$cwd jq -r '.[] | select(.cwd == env.P and .program == "claude" and .clients == 0) | .name' <<<"$running")"}; do
      (( ${panes[(Ie)$orphan]} )) || { name=$orphan; return }
    done
  fi
  taken=(${(f)"$(jq -r '.[].name' <<<"$running")"} $panes)
  name=$base n=1
  while (( ${taken[(Ie)$name]} )); do name="${base:0:61}-$(( ++n ))"; done
}

# here <path> <session id>, for the sidebar's Closed view: makes the pane it
# runs in a Windows Claude on <path> resuming that conversation, as reopening a
# closed local tab runs claude --resume there.
if [[ $1 == here ]]; then
  cwd=$2 session=$3
  [[ $cwd == [A-Za-z]:\\* && $session =~ '^[A-Za-z0-9-]{1,100}$' && -n $TMUX_PANE ]] || fail "remote-tab.zsh here: not a Windows path and session"
  pick_name "$cwd"
  remote-winmux watch --start
  dir=$(standin "$name")
  tmux set -p -t "$TMUX_PANE" @remote "$name" \; set -p -t "$TMUX_PANE" @remote_cwd "$cwd" \; set -p -t "$TMUX_PANE" @remote_program claude
  "$script_dir/window-names.sh" "$(tmux display -p -t "$TMUX_PANE" '#{session_name}')"
  print >>~/.local/state/remote-winmux/nudge
  cd $dir
  remote-winmux attach "$name" --cwd "$cwd" --program claude --session "$session" || fail "remote-winmux attach failed"
  exit 0
fi

# After tmux-resurrect restores (its post-restore hook in tmux.conf), each
# pane that was attached to a Windows session comes back attached to it, as a
# local Claude tab comes back running claude-here: resurrect itself would type
# the saved command into the restored shell, which reads a Windows path's
# backslashes as escapes, and pane options aren't saved. The saved layout's
# pane lines carry what it needs: the session, window and pane index, and in
# the last field the attach's own command line. A session still running there
# is attached as it is; one that ended with the Mac starts again with Claude
# picking up the folder's last conversation (--resume).
if [[ $1 == restore ]]; then
  last=${XDG_DATA_HOME:-$HOME/.local/share}/tmux/resurrect/last
  [[ -r $last ]] || exit 0
  restored=0
  # Split on each tab, keeping empty fields, which read would merge away.
  while IFS= read -r line; do
    f=("${(@ps:\t:)line}")
    [[ ${f[1]} == pane ]] || continue
    full=${f[11]#:}
    [[ $full =~ 'remote-winmux attach ([A-Za-z0-9._-]+) --cwd ([A-Za-z]:\\.*)$' ]] || continue
    name=$match[1] cwd=$match[2] program=claude
    # Its program, and whatever else the attach was given after the folder.
    [[ $cwd =~ '^(.*) --program (claude|pwsh|lazygit)( .*)?$' ]] && cwd=$match[1] program=$match[2]
    [[ $cwd =~ '^(.*) --(resume|session) .*$' ]] && cwd=$match[1]
    # lazygit was in a pane's place; the pane itself comes back as itself.
    [[ $program == lazygit ]] && continue
    target="${f[2]}:${f[3]}.${f[6]}"
    pane=$(tmux display -p -t "$target" '#{pane_id}' 2>/dev/null) || continue
    tmux respawn-pane -k -t "$pane" -c "$(standin "$name")" "$(attach_command "$name" "$cwd" "$program" "--resume 1")" &&
      tmux set -p -t "$pane" @remote "$name" \; set -p -t "$pane" @remote_cwd "$cwd" \; set -p -t "$pane" @remote_program "$program" &&
      (( restored++ ))
  done <"$last"
  (( restored )) || exit 0
  remote-winmux watch --start
  print >>~/.local/state/remote-winmux/nudge
  exit 0
fi

if [[ $1 == split ]]; then
  flags=$2 origin=$3
  IFS=$'\x1f' read -r from cwd branch color <<<"$(tmux display -p -t "$origin" $'#{@remote}\x1f#{@remote_cwd}\x1f#{@remote_branch}\x1f#{@remote_color}')"
  [[ -n $from && $cwd == [A-Za-z]:\\* && $flags == (-h|-hb|-v|-vb) ]] || { tmux display-message "remote-tab.zsh: not a Windows pane"; exit 1 }
  # A name of its own: the pane's, and a random part, rather than asking the
  # machine for the names in use, so a split opens as fast as a local one.
  name="${from:0:56}-$(printf %06x $(( ((RANDOM << 15) | RANDOM) & 0xffffff )))"
  # In the same stand-in as the pane it splits, which has the same folder.
  pane=$(tmux split-window $flags -t "$origin" -c "$(tmux display -p -t "$origin" '#{pane_current_path}')" -P -F '#{pane_id}' "$(attach_command "$name" "$cwd" pwsh)") ||
    { tmux display-message "remote-tab.zsh: tmux could not split the pane"; exit 1 }
  # Its branch and color are the folder's, until the watcher hears otherwise.
  tmux set -p -t "$pane" @remote "$name" \; set -p -t "$pane" @remote_cwd "$cwd" \; set -p -t "$pane" @remote_program pwsh \; \
    set -p -t "$pane" @remote_branch "$branch" \; set -p -t "$pane" @remote_color "$color"
  remote-winmux watch --start
  exit 0
fi

[[ $1 == open && $2 == [A-Za-z]:\\* ]] || fail "Not a Windows path: $2"
cwd=$2

# Asked of the machine only once you have picked the folder, so M-t's list
# still opens at once.
pick_name "$cwd" adopt

mkdir -p ${recent:h}
# The watcher marks the tab with Claude's state there; the nudge hands this
# tab its session's state as soon as it exists (lib/remote-winmux/watch.js).
remote-winmux watch --start
# The path reaches awk through its environment: -v would read its
# backslashes as escapes, and no Windows path would ever match itself.
{ print -r -- "$EPOCHSECONDS"$'\t'"$cwd"; P=$cwd awk -F'\t' '$2 != ENVIRON["P"]' $recent 2>/dev/null | head -19 } >| $recent.tmp &&
  mv $recent.tmp $recent

# Exiting Claude leaves you at PowerShell in the folder, on Windows (see
# PROGRAMS in lib/remote-winmux/config.js), and exiting that closes the tab.
pane=$(tmux new-window -P -F '#{pane_id}' -c "$(standin "$name")" "$(attach_command "$name" "$cwd" claude)") || fail "tmux could not open a tab."
tmux set -p -t "$pane" @remote "$name" \; set -p -t "$pane" @remote_cwd "$cwd" \; set -p -t "$pane" @remote_program claude
"$script_dir/window-names.sh" "$(tmux display -p -t "$pane" '#{session_name}')"
print >>~/.local/state/remote-winmux/nudge

# Then asks for its name, still in M-t's popup, as new-tab.zsh does for a local
# directory; Enter or Esc skips it, and the tab keeps its folder and branch.
exec "$script_dir/tab-name.zsh" optional
