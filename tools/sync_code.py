#!/usr/bin/env python3
"""Sync StoryKit framework files from the canonical repo (rsnyder/storykit-starter).

storykit-starter is the canonical source of the StoryKit framework. This
script compares the local copies of the framework files against the pinned
upstream ref and either reports drift (--check) or overwrites the local
copies (--apply).

Usage:
    python3 tools/sync_code.py --check   # report drift, write nothing;
                                         # exit 0 = in sync, 1 = drift, 2 = errors
    python3 tools/sync_code.py --apply   # overwrite local files with upstream
    python3 tools/sync_code.py --apply --ref main   # sync from a different ref

Notes:
  - SRC_REF is pinned to a specific commit so syncs are reproducible and a
    surprise upstream push cannot silently change this site. To move to a
    newer upstream state: run with `--check --ref main` to review the drift,
    then `--apply --ref <new-sha>` and commit the SRC_REF bump here.
  - If this repo carries local improvements that have not yet been
    upstreamed to storykit-starter, --apply WILL DESTROY THEM. Run --check
    first and reconcile (upstream the changes) before applying.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import os
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

# ----------------------------
# Config: canonical source repo + pinned ref
# ----------------------------
SRC_USER = "rsnyder"
SRC_REPO = "storykit-starter"
# Pinned commit of storykit-starter that this repo was last baselined to.
# Bump deliberately (see module docstring), never point back at a branch name.
SRC_REF = "b2ff8127630f26eab2579537e9a012cd6d2cccfc"

# Optional: GitHub token (env var) to avoid rate limits / access private repos
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

# ----------------------------
# Files to sync (relative paths)
# ----------------------------
FILES_TO_SYNC = [
    "_admin/index.md",
    "_admin/2026-02-15-storykit-overview.md",
    "_admin/2026-02-15-storykit-image-viewer.md",
    "_admin/2026-02-15-storykit-image-compare-viewer.md",
    "_admin/2026-02-15-storykit-map-viewer.md",
    "_admin/2026-02-15-storykit-youtube-viewer.md",
    "_admin/2026-02-15-storykit-authors-guide.md",
    "_admin/2026-02-15-storykit-preview-setup.md",
    "_admin/2026-02-15-storykit-entity-info-popups.md",
    "_admin/2026-02-15-storykit-formatting-tips.md",
    "_admin/2026-02-15-storykit-viewers-overview.md",
    "_admin/2026-02-15-storykit-vis-network-viewer.md",
    "_admin/2026-02-15-storykit-iframe-viewer.md",
    "_admin/2026-02-15-storykit-action-links.md",
    "_admin/2026-02-15-storykit-display-modes.md",
    "_admin/2026-02-15-storykit-troubleshooting.md",
    "_includes/embed/_iframe.html",
    "_includes/embed/iframe.html",
    "_includes/embed/image-compare.html",
    "_includes/embed/image.html",
    "_includes/embed/map.html",
    "_includes/embed/vis-network.html",
    "_includes/embed/youtube.html",
    "_includes/cite-this.html",
    "_includes/col2-toggle.html",
    "_includes/featured_posts.html",
    "_includes/pdf-download.html",
    "_includes/post_index_item.html",
    "_includes/refactor-content.html",
    "_includes/media-url.html",
    "_includes/sidebar.html",
    "_layouts/admin.html",
    "_layouts/home.html",
    "_layouts/post.html",
    "_plugins/md5_filter.rb",
    "_posts/.template.md",
    "assets/components/image-compare.html",
    "assets/components/image.html",
    "assets/components/map.html",
    "assets/components/vis-network.html",
    "assets/components/youtube.html",
    "assets/css/storykit.css",
    "assets/js/storykit.js",
    "assets/js/storykit-component.js",
    "assets/js/vendor/Leaflet.SmoothWheelZoom.js",
    "assets/img/leaflet/marker-icon.png",
    "assets/img/leaflet/marker-icon-2x.png",
    "assets/img/leaflet/marker-shadow.png",
    "assets/img/devices-mockup.png",
    "assets/img/devtools-dark.png",
    "assets/img/devtools-light.png",
    "assets/img/mockup.png",
    "assets/img/pages-source-dark.png",
    "assets/img/pages-source-light.png",
    "assets/posts/storykit/image.png",
    "assets/posts/storykit/map.png",
    "assets/posts/image-compare/Westgate_Towers_c1905.jpg",
    "assets/posts/image-compare/Westgate_Towers_2021.jpg",
    "preview/index.html",
    "assets/js/skrender.js",
    # ── NOTE: preview/index.html REQUIRES assets/js/skrender.js from the
    #    same ref. The editor itself is NOT synced per-repo anymore — one
    #    central instance at https://rsnyder.github.io/storykit-editor/
    #    serves all repos (storykit-starter/docs/editor-central.md).
    "_admin/2026-07-06-storykit-authoring-a-visual-narrative.md",
    "tools/sync_code.py",
    # pages-deploy.yml runs exactly two repo scripts, sync_code.py above and
    # check_consistency.py here, so both have to travel with it. This one was
    # left out, meaning downstream copies froze at whenever the repo was created
    # and drifted silently from the manifest they validate. Same class of bug as
    # the .ruby-version omission below.
    "tools/check_consistency.py",
    "Gemfile",
    # The Setup Ruby step in pages-deploy.yml takes NO ruby-version input; it
    # reads .ruby-version, so that file has to travel with the workflow. Without
    # it a downstream deploy dies inside setup-ruby before reaching the build,
    # reporting that ruby-version must be specified when no .ruby-version or
    # .tool-versions file exists. Regression from b91ecdd, which replaced the
    # inline ruby-version 3.3 pin with the .ruby-version lookup and added the
    # file here but not to this list; the canonical repo kept building, so the
    # breakage was only ever visible downstream.
    #
    # Keep comments in this list free of apostrophes and quote characters:
    # check_consistency.py mines the list for quoted paths, and older copies of
    # it (downstream repos do not receive that file) read such prose as
    # filenames and fail the build.
    ".ruby-version",
    ".github/workflows/pages-deploy.yml",
]


@dataclass
class Result:
    changed: List[str] = field(default_factory=list)
    unchanged: List[str] = field(default_factory=list)
    failed: List[str] = field(default_factory=list)


def parse_manifest(source: str) -> set:
    """FILES_TO_SYNC entries declared in a copy of this script.

    Used to compare the manifest a run iterated against the one it just wrote
    over itself. Comments are stripped first: the list carries explanatory
    prose, and quoted text inside it would otherwise read as filenames (the
    same trap check_consistency.py fell into).
    """
    m = re.search(r"FILES_TO_SYNC\s*=\s*\[(.*?)\]", source, re.S)
    if not m:
        return set()
    body = re.sub(r"#[^\n]*", "", m.group(1))
    return set(re.findall(r"['\"]([^'\"]+)['\"]", body))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def raw_url(rel_path: str, ref: str) -> str:
    safe_path = "/".join(urllib.parse.quote(p) for p in rel_path.split("/"))
    return f"https://raw.githubusercontent.com/{SRC_USER}/{SRC_REPO}/{ref}/{safe_path}"


def fetch(url: str, token: str = "") -> bytes:
    def get(with_token: bool) -> bytes:
        req = urllib.request.Request(url)
        if with_token and token:
            req.add_header("Authorization", f"token {token}")
        req.add_header("User-Agent", "storykit-sync/2.0")
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            return resp.read()

    try:
        return get(with_token=True)
    except Exception:
        if token:
            # A token scoped to another repo/org can cause 404s on public raw
            # URLs; the canonical repo is public, so retry unauthenticated.
            try:
                return get(with_token=False)
            except Exception:
                pass
        # Freshly pushed commits can lag on the raw CDN for a few seconds —
        # one delayed retry rescues the common partial-sync case.
        import time
        time.sleep(3)
        return get(with_token=bool(token))


def is_text(rel: str) -> bool:
    return not rel.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp"))


def summarize_diff(rel: str, local: bytes, remote: bytes, max_lines: int = 10) -> str:
    if not is_text(rel):
        return f"    (binary: local {len(local)}B vs upstream {len(remote)}B)"
    try:
        diff = list(
            difflib.unified_diff(
                local.decode("utf-8", "replace").splitlines(),
                remote.decode("utf-8", "replace").splitlines(),
                fromfile=f"local/{rel}",
                tofile=f"upstream/{rel}",
                lineterm="",
                n=0,
            )
        )
    except Exception:
        return "    (diff unavailable)"
    shown = diff[:max_lines]
    more = len(diff) - len(shown)
    lines = [f"    {line}" for line in shown]
    if more > 0:
        lines.append(f"    ... ({more} more diff lines)")
    return "\n".join(lines)


def run(repo_root: Path, ref: str, apply: bool, verbose: bool) -> Result:
    result = Result()
    # Detect whether we're running INSIDE the canonical repo itself: its
    # working tree is by definition ahead of any pinned SRC_REF, and this
    # file cannot contain its own future commit hash, so self-comparison
    # would report permanent phantom drift. Skip self for --check in the
    # canonical repo; downstream copies still compare and sync everything.
    in_canonical = (repo_root / "docs" / "editor-plan.md").exists() and \
                   (repo_root / "tests" / "render" / "corpus.json").exists()
    for rel in FILES_TO_SYNC:
        if rel == "tools/sync_code.py" and in_canonical and not apply:
            result.unchanged.append(rel)
            continue
        target = repo_root / rel
        try:
            remote_data = fetch(raw_url(rel, ref), GITHUB_TOKEN)
        except Exception as e:
            result.failed.append(f"{rel} (download failed: {e})")
            continue

        if target.exists() and target.is_file():
            local_data = target.read_bytes()
            if sha256_bytes(local_data) == sha256_bytes(remote_data):
                result.unchanged.append(rel)
                continue
            if apply:
                target.write_bytes(remote_data)
                result.changed.append(rel)
            else:
                result.changed.append(rel)
                if verbose:
                    result.changed[-1] += "\n" + summarize_diff(rel, local_data, remote_data)
        else:
            if apply:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(remote_data)
            result.changed.append(f"{rel} (missing locally)")
    return result


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run with --check first. --apply overwrites local files.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="report drift; write nothing")
    mode.add_argument("--apply", action="store_true", help="overwrite local files with upstream")
    parser.add_argument("--ref", default=SRC_REF, help=f"upstream ref to compare/sync (default: pinned {SRC_REF[:12]})")
    parser.add_argument("--verbose", action="store_true", help="show diff summaries in --check mode")
    args = parser.parse_args(argv[1:])

    # Locate repo root (directory containing .git), falling back to cwd
    repo_root = Path.cwd()
    cur = repo_root
    while cur != cur.parent and not (cur / ".git").exists():
        cur = cur.parent
    if (cur / ".git").exists():
        repo_root = cur

    result = run(repo_root, args.ref, apply=args.apply, verbose=args.verbose)

    verb = "SYNCED" if args.apply else "DRIFTED"
    print(f"\nSource: {SRC_USER}/{SRC_REPO}@{args.ref}\n")
    print(f"{verb} ({len(result.changed)}):")
    for p in result.changed:
        print(f"  - {p}")
    print(f"\nUNCHANGED: {len(result.unchanged)}")
    if result.failed:
        print(f"\nFAILED ({len(result.failed)}):")
        for p in result.failed:
            print(f"  - {p}")

    if result.failed:
        if args.apply:
            print(
                "\n*** PARTIAL SYNC — the FAILED files above were NOT updated. ***"
                "\nRe-run the same command; freshly pushed commits can lag on"
                "\nthe raw CDN for a few seconds."
            )
        return 2

    # Self-pin maintenance: after a successful --apply from an EXPLICIT sha,
    # rewrite this file's own SRC_REF so a later bare --apply doesn't quietly
    # revert everything to the previous pin (real foot-gun: the synced copy
    # of this tool always self-pins one release behind the files it fetched).
    if args.apply and args.ref != SRC_REF and re.fullmatch(r"[0-9a-f]{7,40}", args.ref or ""):
        try:
            self_path = repo_root / "tools" / "sync_code.py"
            src_text = self_path.read_text()
            new_text = re.sub(r'SRC_REF = "[0-9a-f]+"', f'SRC_REF = "{args.ref}"', src_text, count=1)
            if new_text != src_text:
                self_path.write_text(new_text)
                print(f"\nSelf-pin updated: SRC_REF -> {args.ref[:12]} (commit this change).")
        except Exception as e:
            print(f"\nWARNING: could not update self-pin SRC_REF: {e} — bump it manually.")

    # The manifest is read from the RUNNING script, so when a sync replaces
    # this file the entries added upstream were never in the list this run
    # iterated -- they are silently skipped. --ref does not help: it chooses
    # where files come from, not which files. Say so, loudly, because the
    # symptom is a sync that reports success while leaving the repo broken.
    #
    # Gate on the MANIFEST actually differing, not on sync_code.py having
    # changed. The self-pin below rewrites SRC_REF on every explicit-ref apply,
    # so the file always differs from upstream afterwards and a change-based
    # test fired every single run -- advice that is always on is advice nobody
    # reads.
    if args.apply and "tools/sync_code.py" in result.changed:
        missed = sorted(parse_manifest((repo_root / "tools" / "sync_code.py").read_text())
                        - set(FILES_TO_SYNC))
        if missed:
            print(
                "\n*** RE-RUN THE SYNC ***"
                "\ntools/sync_code.py was updated by this run and the new manifest"
                "\nadds entries this run could not fetch, because it iterated the"
                "\nOLD list:"
            )
            for rel in missed:
                print(f"  - {rel}")
            print("Run the same command again to pick them up.")

    if result.changed and not args.apply:
        print(
            "\nLocal copies differ from the canonical repo. If the local changes are"
            "\nintentional, upstream them to storykit-starter and bump SRC_REF;"
            "\notherwise run with --apply to restore the upstream versions."
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
