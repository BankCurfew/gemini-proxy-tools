#!/usr/bin/env python3
"""Real-ESRGAN x2 upscale on the local GPU (T2902, for designer T2890: Gemini 9:16 caps at 572x1024).

usage: upscale.py IN [IN ...] [--fit 1080x1920] [--out DIR]
  each IN → <out>/<stem>-x2.png (default out = the input's folder)
  --fit WxH: after x2, scale to cover WxH and centre-crop to exactly WxH (572x1024 x2 = 1144x2048 → 1080x1920)
Runs in ~/.oracle/tools/realesrgan/venv (torch CUDA + spandrel), weights RealESRGAN_x2plus.pth (sha256 49fafd45…).
"""
import argparse, os, sys, time
HOME = os.path.expanduser("~/.oracle/tools/realesrgan")
WEIGHTS = os.path.join(HOME, "RealESRGAN_x2plus.pth")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--fit", help="WxH cover-crop after upscaling, e.g. 1080x1920")
    ap.add_argument("--out", help="output folder (default: next to each input)")
    a = ap.parse_args()
    import torch, numpy as np
    from PIL import Image
    from spandrel import ModelLoader
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if dev == "cpu": print("WARN: no CUDA, running on CPU (slow)", file=sys.stderr)
    model = ModelLoader().load_from_file(WEIGHTS).to(dev).eval()
    fit = tuple(int(x) for x in a.fit.lower().split("x")) if a.fit else None
    for path in a.inputs:
        t0 = time.time()
        img = Image.open(path).convert("RGB")
        x = torch.from_numpy(np.array(img)).permute(2, 0, 1).float().div(255).unsqueeze(0).to(dev)
        with torch.no_grad():
            y = model(x).clamp(0, 1)
        out = Image.fromarray(y.squeeze(0).permute(1, 2, 0).mul(255).round().byte().cpu().numpy())
        if fit:
            w, h = fit
            s = max(w / out.width, h / out.height)
            out = out.resize((round(out.width * s), round(out.height * s)), Image.LANCZOS)
            l, t = (out.width - w) // 2, (out.height - h) // 2
            out = out.crop((l, t, l + w, t + h))
        d = a.out or os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, os.path.splitext(os.path.basename(path))[0] + "-x2.png")
        out.save(dst)
        print(f"{img.width}x{img.height} -> {out.width}x{out.height} {time.time() - t0:.1f}s {dev} {dst}")

if __name__ == "__main__":
    main()
