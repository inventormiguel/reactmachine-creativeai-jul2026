#!/usr/bin/env python3
import argparse
from pathlib import Path
import sys

import cv2
from rembg import new_session, remove


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model", default="u2netp")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(input_dir.glob("*.png"))
    if not files:
        raise RuntimeError("Nenhum quadro foi encontrado para segmentação.")

    session = new_session(args.model)
    for index, source in enumerate(files):
        frame = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgba = remove(rgb, session=session, alpha_matting=False, post_process_mask=True)
        bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
        cv2.imwrite(str(output_dir / source.name), bgra)
        percent = round((index + 1) * 100 / len(files))
        print(f"PROGRESS:{percent}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
