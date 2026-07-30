#!/usr/bin/env python3
"""Repo consistency checks, run in CI after the Jekyll build.

Checks:
  1. CHIRPY_VERSION in preview/index.html matches the jekyll-theme-chirpy
     version resolved in Gemfile.lock (the preview tool fetches theme files
     from the Chirpy gem via jsDelivr and silently drifts otherwise).
  2. Exactly one Shoelace version is referenced across the repo (multiple
     simultaneous versions double-load the library and can conflict).
  3. Every entry in tools/sync_code.py FILES_TO_SYNC exists locally (a
     missing entry means the manifest is stale or a file was deleted here
     without updating the manifest).

Exits non-zero on failure. Shoelace convergence is reported as a warning
until the dependency-pinning work lands; flip SHOELACE_STRICT to True then.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# All Shoelace references are converged on a single pinned version; any
# regression (new unversioned or divergent reference) fails CI.
SHOELACE_STRICT = True

# Directories that never contain framework source
SKIP_DIRS = {".git", "_site", ".jekyll-cache", "node_modules", "vendor"}
TEXT_SUFFIXES = {".html", ".js", ".css", ".md", ".yml", ".yaml", ".scss", ".json"}

errors: list[str] = []
warnings: list[str] = []


def check_chirpy_version() -> None:
    lock = (REPO / "Gemfile.lock").read_text()
    m = re.search(r"jekyll-theme-chirpy \((\d+\.\d+\.\d+)\)", lock)
    if not m:
        errors.append("Gemfile.lock: could not find jekyll-theme-chirpy version")
        return
    gem_version = m.group(1)

    preview = (REPO / "preview" / "index.html").read_text()
    m = re.search(r"CHIRPY_VERSION\s*=\s*['\"]v?(\d+\.\d+\.\d+)['\"]", preview)
    if not m:
        errors.append("preview/index.html: could not find CHIRPY_VERSION")
        return
    preview_version = m.group(1)

    if gem_version != preview_version:
        errors.append(
            f"CHIRPY_VERSION mismatch: preview/index.html pins {preview_version} "
            f"but Gemfile.lock resolves jekyll-theme-chirpy {gem_version}. "
            "Update CHIRPY_VERSION in preview/index.html when upgrading the gem."
        )


def iter_text_files():
    for path in REPO.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file() and path.suffix in TEXT_SUFFIXES:
            yield path


def check_shoelace_versions() -> None:
    versions: dict[str, set[str]] = {}
    pattern = re.compile(r"@shoelace-style/shoelace(?:@(\d+\.\d+\.\d+))?/")
    for path in iter_text_files():
        for m in pattern.finditer(path.read_text(errors="ignore")):
            ver = m.group(1) or "(unversioned)"
            versions.setdefault(ver, set()).add(str(path.relative_to(REPO)))
    if len(versions) > 1:
        detail = "; ".join(
            f"{v} in {', '.join(sorted(files))}" for v, files in sorted(versions.items())
        )
        msg = f"Shoelace referenced at {len(versions)} versions: {detail}"
        (errors if SHOELACE_STRICT else warnings).append(msg)
    elif "(unversioned)" in versions:
        files = ", ".join(sorted(versions["(unversioned)"]))
        msg = f"Shoelace referenced without a pinned version in: {files}"
        (errors if SHOELACE_STRICT else warnings).append(msg)


def check_sync_manifest() -> None:
    sync = (REPO / "tools" / "sync_code.py").read_text()
    m = re.search(r"FILES_TO_SYNC\s*=\s*\[(.*?)\]", sync, re.S)
    if not m:
        errors.append("tools/sync_code.py: could not parse FILES_TO_SYNC")
        return
    # Strip comments before scanning for quoted paths. FILES_TO_SYNC carries
    # explanatory comments by convention, and prose contains apostrophes
    # ("pages-deploy.yml's Setup Ruby step") and quoted error text — all of
    # which this deliberately naive quoted-string scan would otherwise read as
    # filenames, failing CI with entries that were never entries.
    body = re.sub(r"#[^\n]*", "", m.group(1))
    entries = re.findall(r"['\"]([^'\"]+)['\"]", body)
    for rel in entries:
        if not (REPO / rel).exists():
            errors.append(
                f"FILES_TO_SYNC entry does not exist locally: {rel} "
                "(stale manifest, or a file was deleted without updating it)"
            )


def main() -> int:
    check_chirpy_version()
    check_shoelace_versions()
    check_sync_manifest()

    for w in warnings:
        print(f"WARNING: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    if not errors and not warnings:
        print("All consistency checks passed.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
