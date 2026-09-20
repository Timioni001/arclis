#!/usr/bin/env python3
"""Generate the Anchor IDL without `anchor build`'s IDL step.

Why this exists
---------------
`anchor build` on Anchor 0.30.1 runs its IDL generation inside the same
invocation that cross-compiles the program for Solana, and that step is fragile
- a dependency-resolution conflict there fails the whole build, even though the
program itself compiles fine. The usual workaround is `anchor build --no-idl`,
which gets you a working program and no IDL at all.

That is not a good trade, because the IDL is what every client needs. A frontend
cannot construct a single instruction without it.

Anchor's IDL generation does not actually need the Solana toolchain. It works by
compiling the program for the *host* with the `idl-build` feature, which emits a
set of `__anchor_private_print_idl_*` test functions that print their section of
the IDL as JSON. This script runs those and assembles the result, which means it
works whether or not `anchor build`'s own IDL step does.

    python3 scripts/build-idl.py

Writes target/idl/arclis.json and target/types/arclis.ts, then copies both into
idl/ so the committed client artifacts cannot drift from the program. They did
drift once: the committed IDL sat at 24 instructions while the program had 26,
and a client would only have discovered that at call time.
"""

from __future__ import annotations

import json
import shutil
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROGRAM_DIR = ROOT / "programs" / "arclis"
PROGRAM_NAME = "arclis"

SECTION = re.compile(r"--- IDL begin (\w+) ---\n(.*?)\n--- IDL end \1 ---", re.S)


def run_idl_tests() -> str:
    """Compile for the host with `idl-build` and capture the printed sections.

    `--test-threads=1` is not optional: the sections are printed to a shared
    stdout, and in parallel they interleave into unparseable soup.
    """
    print("compiling with --features idl-build (host target, not SBF)...")
    result = subprocess.run(
        [
            "cargo", "test",
            "--features", "idl-build",
            "__anchor_private_print_idl",
            "--", "--show-output", "--nocapture", "--test-threads=1",
        ],
        cwd=PROGRAM_DIR,
        # anchor-syn reads this to locate lib.rs for its `/// CHECK:` safety
        # lint. `anchor build` sets it; running cargo directly does not.
        env={**__import__("os").environ, "ANCHOR_IDL_BUILD_PROGRAM_PATH": str(PROGRAM_DIR)},
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout[-4000:])
        sys.stderr.write(result.stderr[-4000:])
        raise SystemExit("cargo test failed - see output above")
    return result.stdout


def short_name(full_path: str) -> str:
    """`arclis::events::PositionOpened` -> `PositionOpened`."""
    return full_path.rsplit("::", 1)[-1]


def shorten(node):
    """Rewrite every fully-qualified type path in the tree to its final segment.

    Anchor emits full Rust paths so that two same-named types in different
    modules stay distinct. Clients expect short names, and this program has no
    such collision - which the caller asserts before calling this.
    """
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key in ("name", "defined") and isinstance(value, str) and "::" in value:
                out[key] = short_name(value)
            elif key == "defined" and isinstance(value, dict) and "name" in value:
                out[key] = {**value, "name": short_name(value["name"])}
            else:
                out[key] = shorten(value)
        return out
    if isinstance(node, list):
        return [shorten(item) for item in node]
    return node


def assemble(raw: str) -> dict:
    sections: dict[str, list] = {}
    for name, body in SECTION.findall(raw):
        sections.setdefault(name, []).append(json.loads(body))

    if "program" not in sections:
        raise SystemExit("no program section found - did the idl-build feature compile?")

    program = sections["program"][0]

    # Anchor prints the address section double-encoded: the JSON payload is a
    # string that itself contains a quoted string. Unwrap until it is a bare
    # base58 address, or `new PublicKey()` rejects it on the client.
    address = sections.get("address", [program.get("address")])[0]
    while isinstance(address, str) and address.startswith('"') and address.endswith('"'):
        address = json.loads(address)

    idl = {
        "address": address,
        "metadata": program["metadata"],
        "instructions": program["instructions"],
        "accounts": list(program["accounts"]),
        "events": [],
        "errors": sections.get("errors", [[]])[0],
        "types": list(program["types"]),
    }

    # Each event prints its own descriptor plus the types it references. Merge
    # them, keeping the first definition of any type seen twice.
    seen_types = {t["name"] for t in idl["types"]}
    for event_section in sections.get("event", []):
        idl["events"].append(event_section["event"])
        for type_def in event_section.get("types", []):
            if type_def["name"] not in seen_types:
                idl["types"].append(type_def)
                seen_types.add(type_def["name"])

    # Refuse to shorten if two distinct types would collide, rather than
    # silently emitting an IDL where one shadows the other.
    collisions: dict[str, set[str]] = {}
    for type_def in idl["types"]:
        collisions.setdefault(short_name(type_def["name"]), set()).add(type_def["name"])
    clashing = {k: v for k, v in collisions.items() if len(v) > 1}
    if clashing:
        raise SystemExit(f"type name collisions, cannot shorten safely: {clashing}")

    idl = shorten(idl)
    idl["events"].sort(key=lambda e: e["name"])
    idl["types"].sort(key=lambda t: t["name"])
    idl["accounts"].sort(key=lambda a: a["name"])
    return idl


def to_typescript(idl: dict) -> str:
    """Emit the `target/types/<name>.ts` file Anchor clients import."""
    name = idl["metadata"]["name"]
    type_name = "".join(part.capitalize() for part in name.split("_"))
    body = json.dumps(idl, indent=2)
    return f'''/**
 * Program IDL in camelCase format for use with @coral-xyz/anchor.
 *
 * Generated by scripts/build-idl.py - do not edit by hand.
 * Regenerate with:  python3 scripts/build-idl.py
 */
export type {type_name} = {body};

export const IDL: {type_name} = {body};
'''


def main() -> None:
    raw = run_idl_tests()
    idl = assemble(raw)

    idl_dir = ROOT / "target" / "idl"
    types_dir = ROOT / "target" / "types"
    idl_dir.mkdir(parents=True, exist_ok=True)
    types_dir.mkdir(parents=True, exist_ok=True)

    idl_path = idl_dir / f"{PROGRAM_NAME}.json"
    types_path = types_dir / f"{PROGRAM_NAME}.ts"
    idl_path.write_text(json.dumps(idl, indent=2) + "\n")
    types_path.write_text(to_typescript(idl))

    # Copy into the committed location. Generating into target/ alone leaves
    # idl/ to be updated by hand, which is a step that gets forgotten exactly
    # when the instruction surface changes, which is exactly when it matters.
    committed = ROOT / "idl"
    committed.mkdir(exist_ok=True)
    shutil.copyfile(idl_path, committed / "arclis.json")
    shutil.copyfile(types_path, committed / "arclis.ts")

    # And into the app's own module graph. The frontend decodes accounts and
    # builds instructions straight from this file, so importing it from outside
    # the Vite root would mean either a filesystem-allow rule or an alias, both
    # of which are config that can silently go stale. A copy the generator owns
    # cannot drift, because regenerating is the only way to change it.
    app_idl = ROOT / "app/src/idl"
    app_idl.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(idl_path, app_idl / "arclis.json")

    # The program ID on its own, as a module.
    #
    # `config.ts` needs exactly one field out of the IDL, and importing the
    # whole file for it put 84KB of JSON into the entry chunk that every
    # visitor downloads, including the ones who only read the registry and
    # never decode an account. Generated rather than hand-copied so it cannot
    # disagree with `declare_id!`.
    (app_idl / "program-id.ts").write_text(
        "// Generated by scripts/build-idl.py - do not edit by hand.\n"
        "//\n"
        "// The address from `declare_id!`, split out so reading it does not\n"
        "// pull the whole IDL into the bundle.\n"
        f'export const PROGRAM_ADDRESS = "{idl["address"]}";\n'
    )

    print(f"\n  {idl_path.relative_to(ROOT)}")
    print(f"  {types_path.relative_to(ROOT)}")
    print("  idl/arclis.json")
    print("  idl/arclis.ts")
    print("  app/src/idl/arclis.json")
    print("  app/src/idl/program-id.ts\n")
    print(f"  {len(idl['instructions']):>3} instructions")
    print(f"  {len(idl['accounts']):>3} accounts")
    print(f"  {len(idl['events']):>3} events")
    print(f"  {len(idl['errors']):>3} errors")
    print(f"  {len(idl['types']):>3} types\n")


if __name__ == "__main__":
    main()
