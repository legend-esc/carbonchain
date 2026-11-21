#!/usr/bin/env python3
"""Compare Soroban gas / CPU / memory benchmarks between base and PR branches.

Supports JSON benchmark snapshots as well as raw text output from `cargo test`
or `cargo bench` containing Soroban budget metrics (`cpu_insns` / `mem_bytes`).
Outputs a formatted GitHub-flavored Markdown comparison table.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

COMMENT_MARKER = "<!-- gas-benchmark-report -->"

# Matches lines like:
#   bench_mint_credit ... cpu_insns=123456 mem_bytes=7890
#   [budget] credit_registry::mint: cpu_insns: 123456, mem_bytes: 7890
TEXT_METRIC_RE = re.compile(
    r"(?P<name>[A-Za-z0-9_:/.-]+).*?"
    r"cpu[_ ]insns\s*[:=]\s*(?P<cpu>\d+).*?"
    r"mem(?:ory)?[_ ]bytes\s*[:=]\s*(?P<mem>\d+)",
    re.IGNORECASE,
)

# Matches Criterion-style bench lines as a fallback:
#   test bench_foo ... bench:       1,234 ns/iter (+/- 56)
CRITERION_RE = re.compile(
    r"test\s+(?P<name>\S+)\s+\.\.\.\s+bench:\s+(?P<ns>[\d,]+)\s+ns/iter"
)


@dataclass
class BenchMetric:
    cpu_insns: int = 0
    mem_bytes: int = 0


def load_metrics(path: Path) -> dict[str, BenchMetric]:
    """Load benchmark metrics from a JSON file or raw command output text."""
    raw = path.read_text(encoding="utf-8")
    stripped = raw.lstrip()

    if stripped.startswith("{") or stripped.startswith("["):
        data = json.loads(raw)
        entries = data.get("benchmarks", data) if isinstance(data, dict) else data
        metrics: dict[str, BenchMetric] = {}
        if isinstance(entries, dict):
            for name, vals in entries.items():
                metrics[name] = BenchMetric(
                    cpu_insns=int(vals.get("cpu_insns", vals.get("cpu", 0))),
                    mem_bytes=int(vals.get("mem_bytes", vals.get("mem", 0))),
                )
        elif isinstance(entries, list):
            for item in entries:
                name = str(item["name"])
                metrics[name] = BenchMetric(
                    cpu_insns=int(item.get("cpu_insns", item.get("cpu", 0))),
                    mem_bytes=int(item.get("mem_bytes", item.get("mem", 0))),
                )
        return metrics

    metrics = {}
    for line in raw.splitlines():
        m = TEXT_METRIC_RE.search(line)
        if m:
            metrics[m.group("name")] = BenchMetric(
                cpu_insns=int(m.group("cpu")),
                mem_bytes=int(m.group("mem")),
            )
            continue
        c = CRITERION_RE.search(line)
        if c:
            ns_val = int(c.group("ns").replace(",", ""))
            metrics[c.group("name")] = BenchMetric(cpu_insns=ns_val, mem_bytes=0)
    return metrics


def format_delta(base_val: int, head_val: int, regression_pct: float) -> tuple[str, bool]:
    """Format an absolute + percentage delta cell and report if it regressed."""
    diff = head_val - base_val
    if base_val == 0:
        pct_str = "n/a" if head_val == 0 else "+∞%"
        regressed = head_val > 0
    else:
        pct = (diff / base_val) * 100.0
        pct_str = f"{pct:+.2f}%"
        regressed = pct > regression_pct

    if diff == 0:
        icon = "⚪"
    elif regressed:
        icon = "🔴"
    elif diff < 0:
        icon = "🟢"
    else:
        icon = "🟡"

    return f"{icon} {diff:+,} ({pct_str})", regressed


def build_report(
    base: dict[str, BenchMetric],
    head: dict[str, BenchMetric],
    regression_pct: float,
) -> tuple[str, bool]:
    """Build a markdown comparison table and return (markdown, has_regression)."""
    all_names = sorted(set(base) | set(head))
    has_regression = False

    lines = [
        COMMENT_MARKER,
        "## ⛽ Soroban Gas & Budget Benchmark Report",
        "",
    ]

    if not all_names:
        lines.append("_No benchmark metrics were recorded on either branch._")
        return "\n".join(lines) + "\n", False

    lines.extend([
        "| Benchmark | Base CPU Insns | PR CPU Insns | CPU Delta | Base Mem (B) | PR Mem (B) | Mem Delta |",
        "|---|---:|---:|---|---:|---:|---|",
    ])

    for name in all_names:
        b = base.get(name, BenchMetric())
        h = head.get(name, BenchMetric())
        cpu_delta, cpu_reg = format_delta(b.cpu_insns, h.cpu_insns, regression_pct)
        mem_delta, mem_reg = format_delta(b.mem_bytes, h.mem_bytes, regression_pct)
        if cpu_reg or mem_reg:
            has_regression = True

        lines.append(
            f"| `{name}` | {b.cpu_insns:,} | {h.cpu_insns:,} | {cpu_delta} "
            f"| {b.mem_bytes:,} | {h.mem_bytes:,} | {mem_delta} |"
        )

    lines.append("")
    if has_regression:
        lines.append(
            f"> ⚠️ **Regression detected:** One or more benchmarks exceeded the `+{regression_pct:.1f}%` threshold."
        )
    else:
        lines.append(
            f"> ✅ All benchmarks are within the `+{regression_pct:.1f}%` budget threshold."
        )

    return "\n".join(lines) + "\n", has_regression


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path, help="Base branch benchmark output")
    parser.add_argument("--head", required=True, type=Path, help="PR branch benchmark output")
    parser.add_argument("--output", type=Path, default=None, help="Write markdown report to file")
    parser.add_argument(
        "--regression-threshold",
        type=float,
        default=5.0,
        help="Percentage increase that triggers a regression warning (default: 5.0)",
    )
    parser.add_argument(
        "--fail-on-regression",
        action="store_true",
        help="Exit with code 1 if any benchmark regresses beyond the threshold",
    )
    args = parser.parse_args()

    base_metrics = load_metrics(args.base) if args.base.exists() else {}
    head_metrics = load_metrics(args.head) if args.head.exists() else {}
    report, has_regression = build_report(base_metrics, head_metrics, args.regression_threshold)

    if args.output:
        args.output.write_text(report, encoding="utf-8")
    else:
        sys.stdout.write(report)

    if args.fail_on_regression and has_regression:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
