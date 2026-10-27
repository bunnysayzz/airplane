#!/usr/bin/env bash
# check-spec-drift.sh — fail if protocol constants in code drift from the docs.
#
# Source of truth for values: docs/spec/wire-format.md and docs/spec/flood.md
# (see the header comment of packages/protocol/src/events/types.ts).
# This script checks each frozen constant in two directions:
#   1. the declaration in packages/protocol/src/events/types.ts still matches,
#   2. the doc file still documents that exact value.
# Either side changing alone = drift = hard failure with a named diff message.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/packages/protocol/src/events/types.ts"
WF="$ROOT/docs/spec/wire-format.md"
FL="$ROOT/docs/spec/flood.md"
SD="$ROOT/docs/blueprint/SYSTEM_DESIGN.md"
FAIL=0

fail() { echo "::error::SPEC DRIFT: $1"; FAIL=1; }

# check <NAME> <ts_declaration_regex> <docfile> <doc_value_regex>
check() {
  local name="$1" ts_re="$2" docfile="$3" doc_pat="$4"
  if ! grep -Eq "$ts_re" "$SRC"; then
    fail "code changed — '$name' declaration in packages/protocol/src/events/types.ts no longer matches /$ts_re/ (update the docs, or this check)"
  fi
  if ! grep -Eq "$doc_pat" "$docfile"; then
    fail "docs changed — '$name' is no longer documented as /$doc_pat/ in $(basename "$docfile") (update the code, or the docs)"
  fi
}

# --- protocol version -------------------------------------------------------
check "PROTO_VER"             'export const PROTO_VER = 1;'            "$WF" '`PROTO_VER = 1`'

# --- event kinds ------------------------------------------------------------
check "EVENT_KIND_POST"       'export const EVENT_KIND_POST = 1;'     "$WF" '`kind=1`'
check "EVENT_KIND_RECEIPT"    'export const EVENT_KIND_RECEIPT = 2;'  "$WF" '`kind=2`'
check "EVENT_KIND_TOMBSTONE"  'export const EVENT_KIND_TOMBSTONE = 3;' "$WF" '`kind=3`'

# --- flood (docs/spec/flood.md) ---------------------------------------------
check "DEFAULT_TTL"           'export const DEFAULT_TTL = 7;'             "$FL" '^\| `DEFAULT_TTL` \| 7 \|'
check "FLOOD_JITTER_MS_MIN"   'export const FLOOD_JITTER_MS_MIN = 50;'   "$FL" '^\| `FLOOD_JITTER_MS_MIN` \| 50 \|'
check "FLOOD_JITTER_MS_MAX"   'export const FLOOD_JITTER_MS_MAX = 500;'  "$FL" '^\| `FLOOD_JITTER_MS_MAX` \| 500 \|'
check "SEEN_LRU_CAP"          'export const SEEN_LRU_CAP = 10000;'       "$FL" '^\| `SEEN_LRU_CAP` \| 10000 \|'
check "RECEIPT_DAY_BUCKET_S"  'export const RECEIPT_DAY_BUCKET_S = 86400;' "$FL" '^\| `RECEIPT_DAY_BUCKET_S` \| 86400 \|'

# --- wire format (docs/spec/wire-format.md) ---------------------------------
check "MAX_CONTENT_CHARS"     'export const MAX_CONTENT_CHARS = 280;'  "$WF" '^\| `MAX_CONTENT_CHARS` \| 280 chars \|'
check "MAX_EVENT_BYTES"       'export const MAX_EVENT_BYTES = 4096;'   "$WF" '^\| `MAX_EVENT_BYTES` \| 4096 bytes'
check "GEOHASH_PRECISION"     'export const GEOHASH_PRECISION = 5;'    "$WF" 'exactly 5 chars'
check "FRAG_WIRE_MAX"         'export const FRAG_WIRE_MAX = 469;'      "$WF" '^- `FRAG_WIRE_MAX` = 469\b'
check "FRAG_HEADER_LEN"       'export const FRAG_HEADER_LEN = 11;'     "$SD" '^\| `FRAG_HEADER_LEN` \| `11` B' # literal named only in SYSTEM_DESIGN §3; wire-format §5 states "11-byte big-endian header"
check "FRAG_PAYLOAD_MAX"      'export const FRAG_PAYLOAD_MAX = FRAG_WIRE_MAX - FRAG_HEADER_LEN;' "$WF" '\*\*458 bytes\*\*/fragment'
check "FRAG_MAGIC"            'export const FRAG_MAGIC = 0xa1;'        "$WF" '`0xA1`'
# reassembly timeout spans two lines in the doc ("... =\n30000 ms"),
# so it gets a two-pattern check instead of the generic single-pattern one.
check "REASSEMBLY_TIMEOUT_MS" 'export const REASSEMBLY_TIMEOUT_MS = 30000;' "$WF" 'REASSEMBLY_TIMEOUT_MS'
if ! grep -Eq '30000 ms' "$WF"; then
  fail "docs changed — REASSEMBLY_TIMEOUT_MS is no longer documented as 30000 ms in wire-format.md (update the code, or the docs)"
fi

# --- ranking (docs/blueprint/SYSTEM_DESIGN.md) -------------------------------
check "RANK_GRAVITY"          'export const RANK_GRAVITY = 1\.5;'       "$SD" '^\| `RANK_GRAVITY` \| `1\.5` \|'

if [ "$FAIL" -ne 0 ]; then
  echo "::error::Protocol constants drifted from the docs. Fix the code or the docs, then re-run."
  exit 1
fi
echo "Spec drift check passed: all protocol constants match the docs."
