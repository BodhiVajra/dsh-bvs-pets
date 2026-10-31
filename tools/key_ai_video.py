#!/usr/bin/env python3
"""Turn a near-white AI video into a transparent VP9-alpha pet clip.

Every source frame is kept. The matte comes from the local isnet-anime model
(rembg / ONNX Runtime). No per-frame API call.

  .venv/bin/python tools/key_ai_video.py docs/deepseek.mp4 assets/deepseek/shy.webm
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove

ROOT = Path(__file__).resolve().parents[1]
FFMPEG = ROOT / ".vendor" / "imageio_ffmpeg" / "binaries" / "ffmpeg-macos-aarch64-v7.1"
CANVAS = 640


def extract_frames(src: Path, folder: Path) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(FFMPEG),
        "-y",
        "-i",
        str(src),
        "-map",
        "0:v:0",
        str(folder / "src_%04d.png"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-2000:])
        raise RuntimeError(f"failed to extract frames from {src}")
    paths = sorted(folder.glob("src_*.png"))
    if not paths:
        raise RuntimeError("no frames extracted")
    return paths


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


def paint_out_watermark(im: Image.Image) -> Image.Image:
    """Cover the light corner credit so the matte does not keep the text."""
    arr = np.asarray(im.convert("RGB")).copy()
    h, w = arr.shape[:2]
    y0, x0 = int(h * 0.93), int(w * 0.76)
    region = arr[y0:, x0:]
    lum = region.astype(np.float32).mean(axis=2)
    sat = region.max(axis=2).astype(np.int16) - region.min(axis=2).astype(np.int16)
    region[(lum > 150) & (sat < 80)] = (253, 253, 253)
    arr[y0:, x0:] = region
    return Image.fromarray(arr, "RGB")


def defringe(rgba: np.ndarray) -> np.ndarray:
    """Unmix the white plate from the semi-transparent rim."""
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    edge = (alpha > 0.04) & (alpha < 0.96)
    if not edge.any():
        return rgba
    safe = np.clip(alpha, 0.12, 1.0)
    unmixed = (rgb - 255.0 * (1.0 - alpha)[..., None]) / safe[..., None]
    out = rgba.copy()
    out[:, :, :3][edge] = np.clip(unmixed[edge], 0, 255).astype(np.uint8)
    return out


def clear_floor_shadow(rgba: np.ndarray) -> np.ndarray:
    """Drop the pale blue contact shadow under the shoes. White socks stay."""
    rgb = rgba[:, :, :3].astype(np.int16)
    lum = rgb.mean(axis=2)
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    blue = rgb[:, :, 2] - rgb[:, :, 0]
    shadow = (blue > 8) & (sat < 60) & (lum > 185) & (lum < 250)
    y0 = int(rgba.shape[0] * 0.82)
    out = rgba.copy()
    out[y0:][shadow[y0:], 3] = 0
    return out


def square(rgba: np.ndarray, size: int) -> Image.Image:
    h, w = rgba.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    im = Image.fromarray(rgba, "RGBA").resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(im, ((size - nw) // 2, (size - nh) // 2), im)
    return canvas


def encode(frames_dir: Path, dest: Path, fps: float) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(FFMPEG),
        "-y",
        "-framerate",
        f"{fps:.6f}",
        "-i",
        str(frames_dir / "frame_%04d.png"),
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
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-2000:])
        raise RuntimeError(f"ffmpeg failed for {dest.name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("dest", type=Path)
    parser.add_argument("--model", default="isnet-anime")
    parser.add_argument("--size", type=int, default=CANVAS)
    parser.add_argument("--limit", type=int, default=0, help="encode only the first N frames")
    args = parser.parse_args()

    src = args.src.resolve()
    dest = args.dest if args.dest.is_absolute() else ROOT / args.dest
    fps = probe_fps(src)
    print(f"model {args.model}  fps {fps:.3f}", flush=True)
    session = new_session(args.model)

    with tempfile.TemporaryDirectory(prefix="pet-key-") as tmp:
        paths = extract_frames(src, Path(tmp) / "raw")
        if args.limit:
            paths = paths[: args.limit]
        print(f"frames {len(paths)}", flush=True)
        out = Path(tmp) / "out"
        out.mkdir()
        for i, path in enumerate(paths):
            plated = paint_out_watermark(Image.open(path))
            cut = remove(plated, session=session)
            rgba = clear_floor_shadow(defringe(np.asarray(cut.convert("RGBA"))))
            square(rgba, args.size).save(out / f"frame_{i:04d}.png")
            if i == 0 or (i + 1) % 15 == 0 or i + 1 == len(paths):
                print(f"  matted {i + 1}/{len(paths)}", flush=True)
        encode(out, dest, fps)
    print("wrote", dest)


if __name__ == "__main__":
    main()
