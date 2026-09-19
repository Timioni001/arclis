#!/usr/bin/env python3
"""Report locked crates that the Solana platform-tools rustc cannot compile.

`anchor build` compiles with the Rust bundled in platform-tools, not the one on
your PATH. Anything in Cargo.lock needing a newer rustc - or using edition 2024,
which the bundled Cargo cannot even parse - breaks the build with an error that
names a transitive crate rather than anything you wrote. This script finds those
before the build does.

    python3 scripts/audit_msrv.py [--max-rust 1.75]

Exits non-zero if any offender is found. Crates reported here are either pinned
back with `cargo update -p <crate>@<ver> --precise <older>`, or confirmed to be
target-gated with `cargo tree -i <crate>` (a crate only reachable under
cfg(target_os="wasi") is never fetched for the SBF target).
"""
import argparse
import concurrent.futures as cf
import json
import re
import sys
import urllib.request
from pathlib import Path

CRATES_IO = "https://crates.io/api/v1/crates/{name}/{version}"

# Crates that exceed the MSRV but are unreachable from the SBF build because
# they sit behind a target cfg. Cargo never fetches or parses them for
# sbf-solana-solana, so they cannot break `anchor build`.
#
# Verified with `cargo tree -i <crate>`, which reports "nothing to print" for
# any non-WASI target. Re-verify before adding to this list - an entry here is
# a claim that the crate is unreachable, not permission to ignore it.
TARGET_GATED = {
    "wasip2": "cfg(target_os = \"wasi\"), via getrandom",
    "wit-bindgen": "cfg(target_os = \"wasi\"), via wasip2",
}


def parse_lock(path: Path):
    text = path.read_text()
    out = set()
    blocks = re.findall(r"\[\[package\]\]\n(.*?)(?=\n\[\[package\]\]|\Z)", text, re.S)
    for b in blocks:
        if 'source = "registry' not in b:
            continue  # path/git deps have no crates.io metadata to check
        name = re.search(r'^name = "(.*?)"', b, re.M).group(1)
        version = re.search(r'^version = "(.*?)"', b, re.M).group(1)
        out.add((name, version))
    return sorted(out)


def version_key(v: str):
    if not v:
        return (0, 0)
    parts = v.split(".")
    try:
        return (int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
    except ValueError:
        return (0, 0)


def fetch(nv):
    name, version = nv
    req = urllib.request.Request(
        CRATES_IO.format(name=name, version=version),
        headers={"User-Agent": "perp-engine-msrv-audit"},
    )
    try:
        data = json.load(urllib.request.urlopen(req, timeout=30))["version"]
        return name, version, data.get("edition"), data.get("rust_version"), None
    except Exception as exc:  # network, 404 on a yanked build-metadata version
        return name, version, None, None, str(exc)[:60]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lock", default="Cargo.lock", type=Path)
    ap.add_argument(
        "--max-rust",
        default="1.75",
        help="platform-tools rustc; 1.75 for Solana 1.18, 1.84 for 2.1, 1.87 for 2.3",
    )
    args = ap.parse_args()

    ceiling = version_key(args.max_rust)
    pkgs = parse_lock(args.lock)
    print(f"auditing {len(pkgs)} registry crates against rustc {args.max_rust}\n")

    offenders, errors, gated = [], [], []
    with cf.ThreadPoolExecutor(max_workers=16) as pool:
        for name, version, edition, msrv, err in pool.map(fetch, pkgs):
            if err:
                errors.append((name, version, err))
            elif edition == "2024" or version_key(msrv) > ceiling:
                if name in TARGET_GATED:
                    gated.append((name, version, msrv))
                else:
                    offenders.append((name, version, edition, msrv))

    if offenders:
        print("crates the bundled toolchain cannot build:")
        for name, version, edition, msrv in sorted(offenders):
            print(f"  {name} {version}  edition={edition} msrv={msrv}")
        print("\nPin each with:  cargo update -p <crate>@<ver> --precise <older>")
        print("or confirm it is unreachable with:  cargo tree -i <crate>")
    else:
        print("clean: every locked crate builds on this toolchain")

    if gated:
        print("\nover the MSRV but unreachable for the SBF target:")
        for name, version, msrv in sorted(gated):
            print(f"  {name} {version} (msrv={msrv}) - {TARGET_GATED[name]}")

    if errors:
        print("\ncould not check (treat as unknown, not as clean):")
        for name, version, err in errors:
            print(f"  {name} {version}: {err}")

    return 1 if offenders else 0


if __name__ == "__main__":
    sys.exit(main())
