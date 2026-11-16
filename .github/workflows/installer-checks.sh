# installer-checks.sh: sourced by installers.yml's bash steps (Linux and macOS), owner A9.
#
# Every check appends one line to the job summary and never stops the step: a failure is counted
# in $HSN_CHECKS/failures, and the job's last step fails when that file has any line. Logs are
# written only after `redact`, and only the redacted copies go into $HSN_CHECKS/logs, which is the
# one folder uploaded. Written for bash 3.2 (macOS) as well as bash 5 (Ubuntu).

set +e
HSN_CHECKS="${RUNNER_TEMP:?}/hsn-checks"
mkdir -p "$HSN_CHECKS/logs"
touch "$HSN_CHECKS/failures"

# say <line>…: each argument is one line of the summary.
say() { printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"; }
heading() { say "" "### $*" ""; }

# One line of detail, made safe for a Markdown list: redacted, on one line, at most 300 characters.
one_line() { redact | tr '\n\r' '  ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-300; }

pass() { say "- ✅ $1${2:+ — $2}"; }
fail() {
  say "- ❌ $1${2:+ — $2}"
  printf '%s\n' "$1" >>"$HSN_CHECKS/failures"
  echo "::error title=installer check failed::$1"
}
info() { say "- ℹ️ $1${2:+ — $2}"; }
warn() { say "- ⚠️ $1${2:+ — $2}"; }

# Hides anything that could be a secret: console and link addresses, link codes and tokens in
# JSON, the fragment of any URL, and every long run of base64, base64url or hex (keys, tokens,
# fingerprints). Package hashes are printed by the workflow itself, never through this.
redact() {
  sed -E \
    -e 's|hsn://[^[:space:]"]+|hsn://[redacted]|g' \
    -e 's|(https?://[^[:space:]"#]*)#[^[:space:]"]+|\1#[redacted]|g' \
    -e 's/("(code|token|secret|url|qr|key|psk|password|backupKey)"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"[redacted]"/g' \
    -e 's/[A-Za-z0-9_-]{32,}/[redacted]/g' \
    -e 's|[A-Za-z0-9+/]{40,}={0,2}|[redacted]|g'
}

# check <name> <command…>: passes when the command exits 0; on failure its last lines (redacted)
# are the detail.
check() {
  local name=$1
  shift
  local out code
  out=$("$@" 2>&1)
  code=$?
  if [ "$code" -eq 0 ]; then
    pass "$name"
  else
    fail "$name" "exit $code: $(printf '%s' "$out" | tail -n 4 | one_line)"
  fi
  return 0
}

# check_not <name> <command…>: passes when the command fails (something is absent or refused).
check_not() {
  local name=$1
  shift
  local out code
  out=$("$@" 2>&1)
  code=$?
  if [ "$code" -ne 0 ]; then
    pass "$name"
  else
    fail "$name" "it succeeded: $(printf '%s' "$out" | tail -n 4 | one_line)"
  fi
  return 0
}

# expect <name> <expected> <observed>
expect() {
  if [ "$2" = "$3" ]; then
    pass "$1" "\`$3\`"
  else
    fail "$1" "expected \`$2\`, observed \`$(printf '%s' "$3" | one_line)\`"
  fi
}

# wait_until <seconds> <command…>: runs the command every 2 s until it succeeds, at most that long.
wait_until() {
  local limit=$1
  shift
  local start=$SECONDS
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    if [ $((SECONDS - start)) -ge "$limit" ]; then return 1; fi
    sleep 2
  done
}

# The service's hub and launcher, by their command lines: the hub is
# `<package>/packaged/<version>/bin/hsn-hub --data …` (or `staged/` in the hub's program tree), the
# launcher `<package>/bin/hsn-launcher --package …`; `hsn` itself is `<package>/bin/hsn`.
hub_pid() { pgrep -f '/bin/hsn-hub --data' | head -n 1; }
launcher_pid() { pgrep -f 'hsn-launcher --package' | head -n 1; }
hub_runs() { [ -n "$(hub_pid)" ]; }
nothing_runs() { [ -z "$(hub_pid)" ] && [ -z "$(launcher_pid)" ]; }
# The command line of a process, or nothing.
args_of() { [ -n "$1" ] && ps -o args= -p "$1" 2>/dev/null; }

# hosted <step> [<args>…]: A8's hub/packaging/hosted/check.sh, as root. Its output (which can hold
# a linking code from `hsn open`) is redacted before it is shown or kept; one line per step.
hosted() {
  local step=$1 out code
  out=$(sudo sh hub/packaging/hosted/check.sh "$@" 2>&1)
  code=$?
  { echo "== check.sh $step (exit $code)"; printf '%s\n' "$out" | redact; } >>"$HSN_CHECKS/logs/hosted-checks.txt"
  if [ "$code" -eq 0 ]; then
    pass "A8's hosted check \`$step\`" "$(printf '%s' "$out" | tail -n 1 | one_line)"
  else
    fail "A8's hosted check \`$step\`" "exit $code: $(printf '%s' "$out" | tail -n 3 | one_line)"
  fi
  return 0
}

# A step for check.sh link-top that keeps the installer's output (check.sh throws it away), so
# the job can tell a refusal from a failure for another reason: step.sh <output file> <cmd…>.
printf '#!/bin/sh\nout=$1\nshift\n"$@" >"$out" 2>&1\n' >"$HSN_CHECKS/step.sh"

# absent <path>: the path does not exist (as root, since some parents are closed to the runner).
absent() { ! sudo test -e "$1" && ! sudo test -L "$1"; }

# A file's redacted copy into the uploaded logs, and its tail in the summary.
keep_log() {
  local name=$1 source=$2 lines=${3:-40}
  if sudo test -f "$source"; then
    sudo cat "$source" | redact >"$HSN_CHECKS/logs/$name"
    echo "::group::$name (whole, redacted)"
    cat "$HSN_CHECKS/logs/$name"
    echo "::endgroup::"
    say "" "<details><summary>$name (last $lines lines, redacted)</summary>" "" '```'
    tail -n "$lines" "$HSN_CHECKS/logs/$name" >>"$GITHUB_STEP_SUMMARY"
    say '```' "" "</details>"
  else
    info "$name" "not present at \`$source\`"
  fi
}

# Text already in hand (a command's output), redacted, into the logs and the summary.
keep_text() {
  local name=$1 lines=${3:-40}
  printf '%s\n' "$2" | redact >"$HSN_CHECKS/logs/$name"
  # The whole of it in the log too (redacted), so a first run reads from `gh run view --log` alone.
  echo "::group::$name (whole, redacted)"
  cat "$HSN_CHECKS/logs/$name"
  echo "::endgroup::"
  say "" "<details><summary>$name (last $lines lines, redacted)</summary>" "" '```'
  tail -n "$lines" "$HSN_CHECKS/logs/$name" >>"$GITHUB_STEP_SUMMARY"
  say '```' "" "</details>"
}

# The end of the job: the count, and the exit code.
finish() {
  local failures
  failures=$(grep -c . "$HSN_CHECKS/failures")
  heading "Result"
  if [ "$failures" -eq 0 ]; then
    say "All checks passed."
    return 0
  fi
  say "**$failures check(s) failed:**" ""
  sed 's/^/- /' "$HSN_CHECKS/failures" >>"$GITHUB_STEP_SUMMARY"
  return 1
}
