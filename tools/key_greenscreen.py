#!/usr/bin/env python3
"""Key a green-screen pet clip to transparent VP9, keeping every frame.

The plate is sampled from the frame border. This clip's green is about
#42AD4F, not pure #00FF00. Similarity stays tight and blend stays at 0 so
white lace is not turned translucent.

  .venv/bin/python tools/key_greenscreen.py "docs/deepseek_撒娇.mp4" assets/deepseek/sajiao.webm
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FFMPEG = ROOT / ".vendor" / "imageio_ffmpeg" / "binaries" / "ffmpeg-macos-aarch64-v7.1"
CANVAS = 640


def probe_fps(src: Path) -> float:
    proc = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-i", str(src)],
        capture_output=True,
        text=True,
    )
    for line in proc.stderr.splitlines():
        if "fps" not in line or "Video:" not in line:
            continue
        for part in line.split(","):
            part = part.strip()
            if part.endswith(" fps"):
                return float(part.split()[0])
    return 24.0


def sample_green(src: Path) -> str:
    with tempfile.TemporaryDirectory(prefix="pet-green-") as tmp:
        frame = Path(tmp) / "one.png"
        proc = subprocess.run(
            [str(FFMPEG), "-y", "-i", str(src), "-frames:v", "1", str(frame)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr[-1500:])
            raise RuntimeError("failed to read a frame for the green sample")
        rgb = np.asarray(Image.open(frame).convert("RGB")).astype(np.float32)
        border = np.concatenate(
            [
                rgb[:8].reshape(-1, 3),
                rgb[-8:].reshape(-1, 3),
                rgb[:, :8].reshape(-1, 3),
                rgb[:, -8:].reshape(-1, 3),
            ]
        )
        key = np.median(border, axis=0).astype(np.uint8)
    return "{:02x}{:02x}{:02x}".format(int(key[0]), int(key[1]), int(key[2]))


def key_frames(src: Path, folder: Path, color: str, similarity: float) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    vf = f"chromakey=0x{color}:{similarity:.3f}:0.0,despill=type=green:mix=0.8"
    proc = subprocess.run(
        [
            str(FFMPEG),
            "-y",
            "-i",
            str(src),
            "-map",
            "0:v:0",
            "-vf",
            vf,
            str(folder / "frame_%04d.png"),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-2000:])
        raise RuntimeError("chromakey failed")


def union_box(paths: list[Path]) -> tuple[int, int, int, int]:
    x0 = y0 = 10**9
    x1 = y1 = 0
    for path in paths:
        alpha = np.asarray(Image.open(path).convert("RGBA"))[:, :, 3]
        ys, xs = np.where(alpha > 24)
        if len(xs) == 0:
            continue
        x0 = min(x0, int(xs.min()))
        y0 = min(y0, int(ys.min()))
        x1 = max(x1, int(xs.max()))
        y1 = max(y1, int(ys.max()))
    if x1 <= x0:
        raise RuntimeError("chromakey removed the whole frame")
    return x0, y0, x1, y1


def place(im: Image.Image, box: tuple[int, int, int, int], size: int) -> Image.Image:
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    pad = max(12, int(max(bw, bh) * 0.06))
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(im.size[0] - 1, x1 + pad)
    y1 = min(im.size[1] - 1, y1 + pad)
    crop = im.crop((x0, y0, x1 + 1, y1 + 1))
    cw, ch = crop.size
    scale = min((size * 0.92) / cw, (size * 0.92) / ch)
    nw, nh = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    resized = crop.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def encode(frames_dir: Path, dest: Path, fps: float) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            str(FFMPEG),
            "-y",
            "-framerate",
            f"{fps:.6f}",
            "-i",
            str(frames_dir / "out_%04d.png"),
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-crf",
            "28",
            "-b:v",
            "0",
            "-row-mt",
            "1",
            "-auto-alt-ref",
            "0",
            "-an",
            str(dest),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-2000:])
        raise RuntimeError(f"ffmpeg failed for {dest.name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("dest", type=Path)
    parser.add_argument("--similarity", type=float, default=0.12)
    parser.add_argument("--size", type=int, default=CANVAS)
    args = parser.parse_args()

    src = args.src.resolve()
    dest = args.dest if args.dest.is_absolute() else ROOT / args.dest
    fps = probe_fps(src)
    color = sample_green(src)
    print(f"green #{color}  similarity {args.similarity:.2f}  fps {fps:.3f}", flush=True)

    with tempfile.TemporaryDirectory(prefix="pet-green-") as tmp:
        raw = Path(tmp) / "raw"
        key_frames(src, raw, color, args.similarity)
        paths = sorted(raw.glob("frame_*.png"))
        if not paths:
            raise RuntimeError("no frames keyed")
        box = union_box(paths)
        print(f"frames {len(paths)}  union {box}", flush=True)
        out = Path(tmp) / "out"
        out.mkdir()
        for i, path in enumerate(paths):
            place(Image.open(path).convert("RGBA"), box, args.size).save(out / f"out_{i:04d}.png")
        encode(out, dest, fps)
    print("wrote", dest)


if __name__ == "__main__":
    main()
