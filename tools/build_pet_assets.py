#!/usr/bin/env python3
"""Build transparent desktop-pet clips for the five characters.

AI frame-by-frame video drifts the face between actions. Each character is
locked to three keyed poses (idle, click, drag). Motion is procedural.
Click and drag both start on the idle rest pose and end on that same pose,
so the handoff back to the idle loop is continuous.

Output per character (512x512, 24 fps):
  idle.webm   3.0s seamless loop
  click.webm  2.0s one-shot, returns to idle
  drag.webm   3.5s one-shot, lift from the crown, swing, set back down
Plus transparent PNG masters of each pose.
"""

from __future__ import annotations

import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".vendor"))

import imageio_ffmpeg  # noqa: E402

SRC = ROOT / "assets" / "src"
OUT = ROOT / "assets"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

CHARACTERS = ("doubao", "deepseek", "chatgpt", "claude", "grok", "ds_claude", "glm", "gemini", "kimi")
POSES = ("idle", "click", "drag")
SIZE = 512
FPS = 24
IDLE_FRAMES = 72   # 3.0s
CLICK_FRAMES = 48  # 2.0s, includes the return to idle
DRAG_FRAMES = 84   # 3.5s, lift, swing, set down on idle
FACE_PX = 116
# Measured on the trimmed idle sprite. Auto eye-finding was locking onto hair
# and cheeks for these two, so the lid painted a bar across the face.
EYE_BOXES = {
    "doubao": [(190, 196, 258, 268), (328, 196, 396, 268)],
    "claude": [(136, 214, 208, 294), (252, 212, 330, 296)],
}


def chroma_key(im: Image.Image) -> np.ndarray:
    rgb = np.asarray(im.convert("RGB")).astype(np.float32)
    border = np.concatenate(
        [
            rgb[:8].reshape(-1, 3),
            rgb[-8:].reshape(-1, 3),
            rgb[:, :8].reshape(-1, 3),
            rgb[:, -8:].reshape(-1, 3),
        ]
    )
    key = np.median(border, axis=0)
    dist = np.linalg.norm(rgb - key, axis=2)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    dom = g - np.maximum(r, b)
    alpha = np.clip((dist - 40.0) / 55.0, 0.0, 1.0)
    greenish = np.clip((dom - 16.0) / 32.0, 0.0, 1.0)
    near = np.clip((170.0 - dist) / 90.0, 0.0, 1.0)
    alpha *= 1.0 - greenish * near
    alpha = np.clip(alpha, 0.0, 1.0)
    # Knock out the thin green rim, then despill so hair does not go lime.
    choke = alpha.copy()
    choke[1:-1, 1:-1] = np.minimum.reduce(
        [
            alpha[1:-1, 1:-1],
            alpha[:-2, 1:-1],
            alpha[2:, 1:-1],
            alpha[1:-1, :-2],
            alpha[1:-1, 2:],
        ]
    )
    alpha = np.where(greenish > 0.35, choke, alpha)
    g2 = np.where(alpha < 0.98, np.minimum(g, np.maximum(r, b)), g)
    return np.dstack([r, g2, b, alpha * 255.0]).astype(np.uint8)


def bbox(alpha: np.ndarray, thresh: int = 24) -> tuple[int, int, int, int]:
    ys, xs = np.where(alpha > thresh)
    if len(xs) == 0:
        h, w = alpha.shape
        return 0, 0, w - 1, h - 1
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def trim(arr: np.ndarray, pad: int = 8) -> np.ndarray:
    x0, y0, x1, y1 = bbox(arr[:, :, 3])
    h, w = arr.shape[:2]
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(w - 1, x1 + pad)
    y1 = min(h - 1, y1 + pad)
    return arr[y0 : y1 + 1, x0 : x1 + 1].copy()


def face_height(arr: np.ndarray) -> float:
    """Height of the face skin in the upper-middle of the sprite."""
    a = arr[:, :, 3]
    x0, y0, x1, y1 = bbox(a)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    fx0, fx1 = int(x0 + bw * 0.30), int(x0 + bw * 0.70)
    fy0, fy1 = int(y0 + bh * 0.02), int(y0 + bh * 0.42)
    sub = arr[fy0:fy1, fx0:fx1]
    if sub.size == 0:
        return float(bh) * 0.28
    r, g, b = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]
    skin = (sub[:, :, 3] > 180) & (r > 165) & (g > 120) & (b > 90) & (r > g - 5) & ((r.astype(int) - b) > 18)
    ys = np.where(skin.any(axis=1))[0]
    if len(ys) < 4:
        return float(bh) * 0.28
    return float(ys.max() - ys.min() + 1)


def find_eyes(arr: np.ndarray) -> list[tuple[int, int, int, int]]:
    a = arr[:, :, 3]
    x0, y0, x1, y1 = bbox(a, 128)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    fx0, fx1 = int(x0 + bw * 0.26), int(x0 + bw * 0.74)
    fy0, fy1 = int(y0 + bh * 0.06), int(y0 + bh * 0.38)
    sub = arr[fy0:fy1, fx0:fx1]
    if sub.size == 0:
        return []
    lum = sub[:, :, :3].astype(np.float32).mean(axis=2)
    dark = (lum < 90) & (sub[:, :, 3] > 170)
    rowcount = dark.sum(axis=1)
    if rowcount.max() < 5:
        return []
    peak = int(np.argmax(rowcount))
    thr = max(3, rowcount[peak] * 0.30)
    y_a = peak
    while y_a > 0 and rowcount[y_a - 1] > thr:
        y_a -= 1
    y_b = peak
    while y_b < len(rowcount) - 1 and rowcount[y_b + 1] > thr:
        y_b += 1
    band = dark[y_a : y_b + 1]
    mid = band.shape[1] // 2

    def box(sl, x_off: int):
        if sl.size == 0 or not sl.any():
            return None
        cols = np.where(sl.any(axis=0))[0]
        rows = np.where(sl.any(axis=1))[0]
        if len(cols) < 2 or len(rows) < 2:
            return None
        # Grow a pupil blob out to a chibi eye without swallowing the brows.
        cx = (cols.min() + cols.max()) / 2
        cy = (rows.min() + rows.max()) / 2
        half_w = max(6, (cols.max() - cols.min() + 1) * 1.15)
        half_h = max(5, (rows.max() - rows.min() + 1) * 1.35)
        ex0 = int(max(0, cx - half_w))
        ex1 = int(min(sl.shape[1] - 1, cx + half_w))
        ey0 = int(max(0, cy - half_h))
        ey1 = int(min(sl.shape[0] - 1, cy + half_h))
        if ex1 - ex0 > bw * 0.24:
            return None
        return (fx0 + x_off + ex0, fy0 + y_a + ey0, fx0 + x_off + ex1, fy0 + y_a + ey1)

    eyes = []
    for part, off in ((band[:, :mid], 0), (band[:, mid:], mid)):
        found = box(part, off)
        if found:
            eyes.append(found)
    return eyes


def apply_blink(arr: np.ndarray, eyes: list[tuple[int, int, int, int]], amount: float) -> np.ndarray:
    if amount <= 0.04 or len(eyes) < 2:
        return arr
    out = arr.copy()
    for x0, y0, x1, y1 in eyes:
        x0 = max(0, x0)
        y0 = max(0, y0)
        x1 = min(out.shape[1] - 1, x1)
        y1 = min(out.shape[0] - 1, y1)
        if x1 <= x0 or y1 <= y0:
            continue
        sy0, sy1 = min(out.shape[0] - 1, y1 + 2), min(out.shape[0], y1 + 10)
        patch = out[sy0:sy1, x0 : x1 + 1]
        mask = patch[:, :, 3] > 180
        if mask.sum() > 6:
            skin = np.median(patch[:, :, :3][mask], axis=0)
        else:
            skin = np.array([255, 214, 196], np.float32)
        region = out[y0 : y1 + 1, x0 : x1 + 1]
        h, w = region.shape[:2]
        yy, xx = np.ogrid[:h, :w]
        cx, cy = (w - 1) / 2, (h - 1) / 2
        nx = (xx - cx) / max(w / 2, 1)
        ny = (yy - cy) / max(h / 2, 1)
        eye = (nx * nx + ny * ny) <= 1.08
        lid_edge = -1.0 + 2.0 * amount
        lid = eye & (ny < lid_edge)
        lash = eye & (np.abs(ny - lid_edge) < 0.10) & (ny < lid_edge + 0.02)
        rgb = region[:, :, :3].astype(np.float32)
        aa = region[:, :, 3].astype(np.float32)
        rgb[lid] = skin
        aa[lid] = np.maximum(aa[lid], 235)
        rgb[lash] = (42, 30, 26)
        region[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        region[:, :, 3] = np.clip(aa, 0, 255).astype(np.uint8)
    return out


def label_floaters(arr: np.ndarray) -> list[np.ndarray]:
    """Return masks of detached props (Doubao's ghost). Downsampled union-find."""
    a = arr[:, :, 3] > 48
    small = a[::2, ::2]
    h, w = small.shape
    labels = np.zeros((h, w), np.int32)
    parent = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    current = 0
    for y in range(h):
        row = small[y]
        lab = labels[y]
        up = labels[y - 1] if y else None
        for x in range(w):
            if not row[x]:
                continue
            left = lab[x - 1] if x else 0
            above = int(up[x]) if up is not None else 0
            if left and above:
                ra, rb = find(left), find(above)
                lab[x] = ra
                if ra != rb:
                    parent[rb] = ra
            elif left or above:
                lab[x] = find(left or above)
            else:
                current += 1
                parent.append(current)
                lab[x] = current
    if current == 0:
        return []
    remap = {}
    areas: dict[int, int] = {}
    for y in range(h):
        for x in range(w):
            v = labels[y, x]
            if not v:
                continue
            r = find(v)
            labels[y, x] = r
            areas[r] = areas.get(r, 0) + 1
    if not areas:
        return []
    main = max(areas, key=areas.get)
    main_area = areas[main]
    masks = []
    for rid, area in areas.items():
        if rid == main:
            continue
        if area * 4 < 1800 or area > main_area * 0.22:
            continue
        ys, xs = np.where(labels == rid)
        # Ignore specks glued to the border.
        if xs.min() <= 1 or ys.min() <= 1 or xs.max() >= w - 2 or ys.max() >= h - 2:
            continue
        full = np.repeat(np.repeat(labels == rid, 2, axis=0), 2, axis=1)
        full = full[: arr.shape[0], : arr.shape[1]]
        masks.append(full)
    return masks


def extrude(arr: np.ndarray, radius: int = 6) -> np.ndarray:
    rgb = arr[:, :, :3].copy()
    known = arr[:, :, 3] > 16
    for _ in range(radius):
        grown = known.copy()
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src_known = np.roll(np.roll(known, dy, axis=0), dx, axis=1)
            src_rgb = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
            if dy == 1:
                src_known[0, :] = False
            elif dy == -1:
                src_known[-1, :] = False
            if dx == 1:
                src_known[:, 0] = False
            elif dx == -1:
                src_known[:, -1] = False
            take = (~known) & src_known
            rgb[take] = src_rgb[take]
            grown |= src_known
        known = grown
    out = arr.copy()
    out[:, :, :3] = rgb
    return out


def to_premul(arr: np.ndarray) -> Image.Image:
    a = arr.astype(np.float32)
    rgb = a[:, :, :3] * (a[:, :, 3:4] / 255.0)
    packed = np.dstack([rgb, a[:, :, 3]]).astype(np.uint8)
    return Image.fromarray(packed, "RGBA")


def from_premul(im: Image.Image) -> Image.Image:
    a = np.asarray(im).astype(np.float32)
    alpha = a[:, :, 3]
    rgb = np.zeros_like(a[:, :, :3])
    m = alpha > 0.5
    rgb[m] = np.clip(a[:, :, :3][m] * (255.0 / alpha[m, None]), 0, 255)
    packed = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(packed, "RGBA")


def render(premul: Image.Image, anchor, dest, scale_x, scale_y, rot_deg) -> Image.Image:
    ax, ay = anchor
    dx, dy = dest
    rot = math.radians(rot_deg)
    cos, sin = math.cos(rot), math.sin(rot)
    # Inverse map: output pixel -> source pixel. Rotation is clockwise on screen
    # for positive degrees so a positive angle swings to the right first? 
    # sin(phase) starts at 0 and goes positive; we want a symmetric swing.
    a = cos / scale_x
    b = sin / scale_x
    c = ax - a * dx - b * dy
    d = -sin / scale_y
    e = cos / scale_y
    f = ay - d * dx - e * dy
    out = premul.transform(
        (SIZE, SIZE),
        Image.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
        fillcolor=(0, 0, 0, 0),
    )
    return from_premul(out)


def scales_for(poses: dict[str, "Pose"]) -> dict[str, float]:
    """One scale per character, taken from the idle height so poses match.

    Face-box measurement was unreliable (hair and closed eyes changed it),
    which made Claude tiny and Doubao's drag a different person-size.
    """
    idle = poses["idle"]
    scale = 424.0 / idle.h
    for name, pose in poses.items():
        extra = pose.h * math.sin(math.radians(8.0)) if name == "drag" else 0.0
        scale = min(scale, (SIZE - 36) / (pose.w + 2 * extra), (SIZE - 48) / pose.h)
    return {name: float(scale) for name in poses}


def smoothstep(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


class Pose:
    def __init__(self, name: str, arr: np.ndarray, character: str = ""):
        self.name = name
        self.arr = arr
        self.character = character
        self.h, self.w = arr.shape[:2]
        self.face_h = face_height(arr)
        x0, y0, x1, y1 = bbox(arr[:, :, 3])
        self.foot = ((x0 + x1) / 2.0, float(y1))
        # Pin the crown, so raised hands beside the head are not the handle.
        bw = x1 - x0 + 1
        cx0 = x0 + int(bw * 0.30)
        cx1 = x0 + int(bw * 0.70)
        band = arr[:, cx0 : cx1 + 1, 3] > 48
        ys, xs = np.where(band)
        if len(ys) == 0:
            self.hold = ((x0 + x1) / 2.0, float(y0))
        else:
            crown = int(ys.min())
            cap = crown + max(3, int((y1 - y0) * 0.035))
            near = ys <= cap
            self.hold = (float(cx0 + np.median(xs[near])), float(crown))
        self.eyes = list(EYE_BOXES.get(character, ())) if name == "idle" else []
        self.floaters = label_floaters(arr) if name == "idle" else []
        body = arr
        if self.floaters:
            body = arr.copy()
            for mask in self.floaters:
                body[mask, 3] = 0
        self.body_premul = to_premul(extrude(body))
        self.floater_premuls = [to_premul(extrude(self._isolate(mask))) for mask in self.floaters]

    def _isolate(self, mask: np.ndarray) -> np.ndarray:
        out = np.zeros_like(self.arr)
        out[mask] = self.arr[mask]
        return out

    def frame(self, anchor_name, dest, sx, sy, rot, blink=0.0, ghost=(0.0, 0.0)) -> Image.Image:
        arr_premul = self.body_premul
        if blink > 0.04 and self.eyes:
            blinked = apply_blink(self.arr if not self.floaters else self._body_straight(), self.eyes, blink)
            if self.floaters:
                for mask in self.floaters:
                    blinked[mask, 3] = 0
            arr_premul = to_premul(extrude(blinked))
        anchor = self.foot if anchor_name == "foot" else self.hold
        base = render(arr_premul, anchor, dest, sx, sy, rot)
        gx, gy = ghost
        for floater in self.floater_premuls:
            layer = render(floater, anchor, (dest[0] + gx, dest[1] + gy), sx, sy, rot)
            base.alpha_composite(layer)
        return base

    def _body_straight(self) -> np.ndarray:
        body = self.arr.copy()
        for mask in self.floaters:
            body[mask, 3] = 0
        return body


def load_character(name: str) -> dict[str, Pose]:
    poses = {}
    for pose in POSES:
        rgba = trim(chroma_key(Image.open(SRC / f"{name}_{pose}.jpg")))
        poses[pose] = Pose(pose, rgba, character=name)
        print(
            f"  {name:9} {pose:5} {rgba.shape[1]}x{rgba.shape[0]}  "
            f"face {poses[pose].face_h:.0f}px  eyes {len(poses[pose].eyes)}  "
            f"floaters {len(poses[pose].floaters)}"
        )
    return poses


def idle_params(i, n):
    ph = 2 * math.pi * i / n
    s = math.sin(ph)
    return {
        "bob": s * 6.0,
        "rot": s * 1.7,
        "sx": 1.0 - s * 0.010,
        "sy": 1.0 + s * 0.020,
        "blink": blink_amount(i, n),
        "ghost": (math.sin(ph * 2) * 6.0, math.sin(ph + 1.2) * 10.0),
    }


def blink_amount(i: int, n: int) -> float:
    center = int(n * 0.58)
    half = 4
    dist = abs(i - center)
    if dist >= half:
        return 0.0
    return math.cos(dist / half * math.pi / 2)


def rest_params():
    return {"pose": "idle", "sx": 1.0, "sy": 1.0, "hop": 0.0, "rot": 0.0, "anchor": "foot"}


def settle(u: float) -> tuple[float, float]:
    """Land squash that is exactly the rest pose at u=1."""
    u = max(0.0, min(1.0, u))
    spring = math.exp(-7.0 * u) * math.cos(12.0 * u) * (1.0 - u) ** 2
    return 1.0 + 0.07 * spring, 1.0 - 0.09 * spring


def click_params(i, n):
    if i == 0 or i >= n - 1:
        return rest_params()
    intro, outro, land = 6, 5, 8
    happy_end = n - 1 - land - outro
    if i <= intro:
        u = smoothstep(i / intro)
        return {"pose": "idle", "sx": 1 + 0.14 * u, "sy": 1 - 0.14 * u, "hop": 0.0, "rot": 0.0, "anchor": "foot"}
    if i > happy_end + outro:
        u = (i - (happy_end + outro)) / land
        sx, sy = settle(u)
        return {"pose": "idle", "sx": sx, "sy": sy, "hop": 0.0, "rot": 0.0, "anchor": "foot"}
    if i > happy_end:
        u = smoothstep((i - happy_end) / outro)
        return {"pose": "click", "sx": 1 + 0.12 * u, "sy": 1 - 0.12 * u, "hop": 0.0, "rot": 0.0, "anchor": "foot"}
    span = max(1, happy_end - intro)
    u = (i - intro) / span
    spring = math.exp(-5.2 * u) * math.cos(10.0 * u)
    hop_len = min(14, span)
    hop = math.sin(math.pi * (i - intro) / hop_len) * 20.0 if (i - intro) < hop_len else 0.0
    return {
        "pose": "click",
        "sx": 1 - 0.04 * spring,
        "sy": 1 + 0.055 * spring,
        "hop": hop,
        "rot": math.sin(2 * math.pi * u) * 1.1,
        "anchor": "foot",
    }


def drag_params(i, n):
    if i == 0 or i >= n - 1:
        return rest_params()
    intro, arrive, drop, land = 7, 4, 5, 8
    swing_start = intro + arrive
    swing_end = n - 1 - land - drop
    if i <= intro:
        u = smoothstep(i / intro)
        return {"pose": "idle", "sx": 1 + 0.12 * u, "sy": 1 - 0.12 * u, "hop": 0.0, "rot": 0.0, "anchor": "foot"}
    if i > swing_end + drop:
        u = (i - (swing_end + drop)) / land
        sx, sy = settle(u)
        return {"pose": "idle", "sx": sx, "sy": sy, "hop": 0.0, "rot": 0.0, "anchor": "foot"}
    if i > swing_end:
        u = smoothstep((i - swing_end) / drop)
        return {"pose": "drag", "sx": 1 + 0.08 * u, "sy": 1 - 0.06 * u, "hop": 0.0, "rot": 0.0, "anchor": "hold"}
    if i < swing_start:
        spring = 1 - smoothstep((i - intro) / arrive)
        return {"pose": "drag", "sx": 1 - 0.05 * spring, "sy": 1 + 0.08 * spring, "hop": 0.0, "rot": 0.0, "anchor": "hold"}
    t = (i - swing_start) / (swing_end - swing_start)
    return {"pose": "drag", "sx": 1.0, "sy": 1.0, "hop": 0.0, "rot": math.sin(2 * math.pi * t) * 8.0, "anchor": "hold"}


def compose_idle(poses, i, n, scales) -> Image.Image:
    p = idle_params(i, n)
    pose = poses["idle"]
    dest = (SIZE / 2, SIZE - 18 + p["bob"])
    return pose.frame("foot", dest, scales["idle"] * p["sx"], scales["idle"] * p["sy"], p["rot"], p["blink"], p["ghost"])


def compose_action(poses, params, scales) -> Image.Image:
    pose = poses[params["pose"]]
    scale = scales[params["pose"]]
    if params["anchor"] == "foot":
        dest = (SIZE / 2, SIZE - 18 - params["hop"])
    else:
        dest = (SIZE / 2, 30)
    return pose.frame(params["anchor"], dest, scale * params["sx"], scale * params["sy"], params["rot"])


def compose_click(poses, i, n, scales) -> Image.Image:
    return compose_action(poses, click_params(i, n), scales)


def compose_drag(poses, i, n, scales) -> Image.Image:
    return compose_action(poses, drag_params(i, n), scales)


def save_master(arr: np.ndarray, path: Path):
    Image.fromarray(arr, "RGBA").save(path)


def encode(frames_dir: Path, dest: Path, fps: int):
    cmd = [
        FFMPEG,
        "-y",
        "-framerate",
        str(fps),
        "-i",
        str(frames_dir / "frame_%04d.png"),
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-crf",
        "30",
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


def write_clip(name, kind, count, draw, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"pet-{name}-{kind}-") as tmp:
        folder = Path(tmp)
        for i in range(count):
            frame = draw(i, count)
            frame.save(folder / f"frame_{i:04d}.png")
        encode(folder, dest, FPS)
    print(f"  wrote {dest.relative_to(ROOT)} ({count} frames)")


def checkerboard(im: Image.Image) -> Image.Image:
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    draw = ImageDraw.Draw(bg)
    s = 16
    for y in range(0, im.size[1], s):
        for x in range(0, im.size[0], s):
            if ((x // s) + (y // s)) % 2 == 0:
                draw.rectangle([x, y, x + s, y + s], fill=(196, 196, 196, 255))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def write_preview_page():
    cards = []
    labels = {
        "doubao": "豆包",
        "deepseek": "DeepSeek",
        "chatgpt": "ChatGPT",
        "claude": "Claude",
        "grok": "Grok",
        "ds_claude": "DS-Claude",
        "glm": "GLM",
        "gemini": "Gemini",
        "kimi": "Kimi",
    }
    for name in CHARACTERS:
        cards.append(
            f"""
      <section>
        <h2>{labels[name]}</h2>
        <div class="row">
          <figure><video src="{name}/idle.webm" autoplay loop muted playsinline></video><figcaption>idle · 待机循环</figcaption></figure>
          <figure><video class="once" src="{name}/click.webm" muted playsinline></video><figcaption>click · 开心后回到待机</figcaption></figure>
          <figure><video class="once" src="{name}/drag.webm" muted playsinline></video><figcaption>drag · 拎起摆动后放下</figcaption></figure>
        </div>
      </section>"""
        )
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>桌宠素材预览</title>
<style>
  body {{ margin: 0; font: 15px/1.4 -apple-system, sans-serif; background: #1c1c1f; color: #f4f1ea; }}
  main {{ max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }}
  h1 {{ font-size: 22px; font-weight: 650; margin: 0 0 8px; }}
  p {{ margin: 0 0 24px; color: #b9b4aa; }}
  h2 {{ font-size: 16px; margin: 28px 0 10px; }}
  .row {{ display: flex; gap: 16px; flex-wrap: wrap; }}
  figure {{ margin: 0; }}
  video {{
    width: 220px; height: 220px; display: block; cursor: pointer;
    background-color: #2a2a2e;
    background-image:
      linear-gradient(45deg, #3a3a40 25%, transparent 25%),
      linear-gradient(-45deg, #3a3a40 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #3a3a40 75%),
      linear-gradient(-45deg, transparent 75%, #3a3a40 75%);
    background-size: 24px 24px;
    background-position: 0 0, 0 12px, 12px -12px, -12px 0;
    border-radius: 12px;
  }}
  figcaption {{ color: #b9b4aa; font-size: 12px; margin-top: 6px; }}
</style>
</head>
<body>
<main>
  <h1>九只桌宠</h1>
  <p>透明底 VP9。点击和拖拽都会回到待机姿势，点画面可重播。</p>
  {''.join(cards)}
</main>
<script>
  for (const v of document.querySelectorAll('video.once')) {{
    v.play();
    v.addEventListener('click', () => {{ v.currentTime = 0; v.play(); }});
  }}
  for (const v of document.querySelectorAll('video:not(.once)')) {{
    v.addEventListener('click', () => {{ if (v.paused) v.play(); else v.pause(); }});
  }}
</script>
</body>
</html>
"""
    (OUT / "preview.html").write_text(html, encoding="utf-8")


def build_samples(loaded):
    qa = OUT / "_qa"
    qa.mkdir(exist_ok=True)
    tiles = []
    labels = []
    for name, poses in loaded:
        sc = scales_for(poses)
        shots = [
            ("idle0", compose_idle(poses, 0, IDLE_FRAMES, sc)),
            ("blink", compose_idle(poses, int(IDLE_FRAMES * 0.62), IDLE_FRAMES, sc)),
            ("bob", compose_idle(poses, IDLE_FRAMES // 4, IDLE_FRAMES, sc)),
            ("squash", compose_click(poses, 7, CLICK_FRAMES, sc)),
            ("happy", compose_click(poses, 12, CLICK_FRAMES, sc)),
            ("swing", compose_drag(poses, int(DRAG_FRAMES * 0.25), DRAG_FRAMES, sc)),
        ]
        for label, im in shots:
            tiles.append(checkerboard(im.resize((180, 180), Image.Resampling.BILINEAR)))
            labels.append(f"{name} {label}")
    cols = 6
    rows = len(tiles) // cols
    sheet = Image.new("RGB", (cols * 180, rows * 180), (30, 30, 30))
    for i, tile in enumerate(tiles):
        sheet.paste(tile, ((i % cols) * 180, (i // cols) * 180))
    path = qa / "samples.jpg"
    sheet.save(path, quality=86)
    print("sample sheet", path)


def build_all():
    print("keying poses")
    loaded = []
    for name in CHARACTERS:
        poses = load_character(name)
        loaded.append((name, poses))
        folder = OUT / name
        folder.mkdir(parents=True, exist_ok=True)
        for pose_name, pose in poses.items():
            save_master(pose.arr, folder / f"{pose_name}.png")
    if "--qa" in sys.argv:
        build_samples(loaded)
        return
    print("encoding webm")
    for name, poses in loaded:
        sc = scales_for(poses)
        folder = OUT / name
        write_clip(name, "idle", IDLE_FRAMES, lambda i, n, p=poses, s=sc: compose_idle(p, i, n, s), folder / "idle.webm")
        write_clip(name, "click", CLICK_FRAMES, lambda i, n, p=poses, s=sc: compose_click(p, i, n, s), folder / "click.webm")
        write_clip(name, "drag", DRAG_FRAMES, lambda i, n, p=poses, s=sc: compose_drag(p, i, n, s), folder / "drag.webm")
    write_preview_page()
    print("preview", OUT / "preview.html")


if __name__ == "__main__":
    build_all()
