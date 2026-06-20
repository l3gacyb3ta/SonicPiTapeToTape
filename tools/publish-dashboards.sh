#!/usr/bin/env bash
# publish-dashboards.sh — regenerate every dashboard HTML in PUBLIC mode.
#
# "Public" = user-facing: no internal catalogue codes (SV/SP/SK…), no PRNG /
# random-walk / cross-engine-divergence framing, no developer methodology
# sections, no file:line code citations, no "Issues filed" lists. The verdict
# badges, spectrogram images, basic tempo/level stats, dates and commit IDs are
# kept. This is the "fix at the source" path — each builder gates the developer
# content behind --public (DASHBOARD_PUBLIC=1), instead of stripping it after.
#
# It regenerates ONLY the HTML from the already-captured JSON/MD/captures — it
# runs NO sweep and NO audio capture (those need desktop Sonic Pi).
#
# The local/dev dashboards (built WITHOUT --public) keep full diagnostic detail;
# only this script's output is public-clean.
#
# Usage:  bash tools/publish-dashboards.sh
#
# NOTE: the two sweep viewers (examples-sweep.html / book-examples-sweep.html)
# are hand-maintained static templates that build-examples-sweep.ts only injects
# the manifest into; in --public mode it ALSO strips their PRNG chrome in place.
# So we first restore the pristine git-tracked templates, ensuring a public build
# always starts from full content (and a later dev rebuild does too).
#
# macOS bash 3.2 compatible (no mapfile / associative arrays).
set -euo pipefail

cd "$(dirname "$0")/.."
export DASHBOARD_PUBLIC=1

echo "[publish-dashboards] regenerating dashboards in PUBLIC mode (no capture)…"

# 0) Inline-audio runtime — the same-origin engine bundle + tree-sitter wasm +
#    rand-stream wavs that make every snippet's Run button work on the deployed
#    site. build-dashboard-publish.mjs copies these from test_results/ into the
#    bundle (and keeps rand-stream*.wav past the WAV drop).
echo "[publish-dashboards] building inline-audio runtime (spw-engine.mjs + assets)…"
npm run dashboard:audio

# Restore pristine static viewer templates so public cleaning starts from full
# content. Only restores if the file is git-tracked (skips quietly otherwise).
for f in test_results/examples-sweep.html test_results/book-examples-sweep.html; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    git checkout -- "$f"
  fi
done

# 1) Per-roster sweep viewers (official + book). These inject the cleaned manifest
#    AND strip the static PRNG chrome (because DASHBOARD_PUBLIC=1).
npx tsx tools/build-examples-sweep.ts --public
npx tsx tools/build-examples-sweep.ts --public --roster book-examples

# 2) Event diff (fully generated HTML).
npx tsx tools/build-event-diff.ts --public

# 3) Launch gate + gate detail (fully generated HTML).
npx tsx tools/gate-report.ts --public
npx tsx tools/build-gate-detail.ts --public

# 4) Aggregate index LAST — it embeds the gate rows + per-roster counts, so it
#    must run after gate-report and the roster builders.
npx tsx tools/build-aggregate-index.ts --public

# 5) Dev-only investigation pages have no --public builder and stay full-detail
#    for development; drop them from the public bundle rather than mangle them.
#    (They are already delinked from the public index + not in the nav bar.)
for f in test_results/experiments.html \
         test_results/mono-sample-sp107.html \
         test_results/raw-lpf.html; do
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "[publish-dashboards] removed dev-only page from public bundle: $f"
  fi
done

echo "[publish-dashboards] done. Public dashboards written to test_results/."
echo "  (To restore full dev detail, re-run the builders without --public, or"
echo "   'git checkout -- test_results' for the static pages.)"
