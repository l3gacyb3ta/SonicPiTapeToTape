#!/usr/bin/env bash
# upload-dashboard-r2.sh — mirror the dashboard spectrogram PNGs into a Cloudflare R2 bucket.
#
# The object key for each image is its path relative to SRC (default test_results/),
# which is exactly what build-dashboard-publish.mjs rewrites the references to. So after
# this upload, https://<R2-public-base>/<key> resolves for every <img> in the bundle.
#
# Prereqs:
#   - wrangler installed and authenticated:  npx wrangler login
#   - the bucket already created:            npx wrangler r2 bucket create <bucket>
#
# Usage:
#   tools/upload-dashboard-r2.sh <bucket-name> [src-dir]
#   tools/upload-dashboard-r2.sh sonicpi-dashboards test_results
#
# For 260 files the wrangler loop takes a few minutes. If you have an R2 S3 API token,
# `rclone sync` / `aws s3 sync` against the R2 S3 endpoint is much faster — see the
# runbook printed at the end.
set -euo pipefail

BUCKET="${1:?usage: upload-dashboard-r2.sh <bucket-name> [src-dir]}"
SRC="${2:-test_results}"

if [ ! -d "$SRC" ]; then echo "ERROR: src dir '$SRC' not found" >&2; exit 1; fi

total=$(find "$SRC" -type f -name '*.png' | wc -l | tr -d ' ')
echo "Uploading $total PNG(s) from '$SRC/' to r2://$BUCKET (key = path under $SRC) ..."

i=0
while IFS= read -r f; do
  i=$((i + 1))
  key="${f#"$SRC"/}"
  printf '[%d/%d] %s\n' "$i" "$total" "$key"
  npx wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type image/png --remote >/dev/null
done < <(find "$SRC" -type f -name '*.png' | sort)

echo "Done. $total objects uploaded to r2://$BUCKET."
