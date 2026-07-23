#!/usr/bin/env python3
import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


class PortraitMatting:
    def __init__(self, model_path: str, input_width: int = 192):
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, max(1, cv2.getNumberOfCPUs()))
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            model_path,
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        self.input_name = self.session.get_inputs()[0].name
        self.input_width = input_width

    def predict(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        input_width = self.input_width
        input_height = max(32, int(height / width * input_width))
        input_height -= input_height % 32

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        tensor = cv2.resize(
            rgb,
            (input_width, input_height),
            interpolation=cv2.INTER_AREA,
        ).astype(np.float32)
        tensor = tensor / 127.5 - 1.0
        tensor = np.transpose(tensor, (2, 0, 1))[None]

        matte = self.session.run(None, {self.input_name: tensor})[0][0, 0]
        matte = cv2.resize(matte, (width, height), interpolation=cv2.INTER_LINEAR)
        return self._clean_matte(frame, np.clip(matte, 0, 1))

    @staticmethod
    def _clean_matte(frame: np.ndarray, matte: np.ndarray) -> np.ndarray:
        height, width = matte.shape
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        rows = np.indices((height, width))[0]

        # MODNet finds the person. The second term recovers very dark clothing
        # near the lower body without bringing back unrelated dark objects.
        candidate = (matte > 0.24) | (
            (gray < 88)
            & (rows > height * 0.48)
            & (matte > 0.015)
        )
        count, labels, stats, _ = cv2.connectedComponentsWithStats(
            candidate.astype(np.uint8),
            connectivity=8,
        )
        if count > 1:
            largest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
            main_subject = labels == largest
            recovered_clothing = (
                (gray < 88)
                & (rows > height * 0.48)
                & main_subject
            )
            matte[recovered_clothing] = np.maximum(matte[recovered_clothing], 0.96)
            matte[~main_subject] = 0

        # Suppress faint background ghosts while preserving soft hair edges.
        return np.clip((matte - 0.10) / 0.78, 0, 1)


def write_frame(encoder, frame: np.ndarray, matte: np.ndarray):
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    alpha = (np.clip(matte, 0, 1) * 255).astype(np.uint8)
    rgba = np.dstack((rgb, alpha))
    encoder.stdin.write(rgba.tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--model",
        default=str(
            Path(__file__).resolve().parent.parent
            / "models"
            / "modnet_photographic.onnx"
        ),
    )
    parser.add_argument("--mask-every", type=int, default=12)
    args = parser.parse_args()

    capture = cv2.VideoCapture(args.input)
    if not capture.isOpened():
        raise RuntimeError("Não foi possível abrir o vídeo compacto.")

    fps = capture.get(cv2.CAP_PROP_FPS) or 12
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    model = PortraitMatting(args.model)

    ffmpeg = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0",
        "-i", args.input,
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0", "-crf", "31", "-b:v", "0",
        "-deadline", "realtime", "-cpu-used", "6",
        "-g", str(max(1, round(fps))),
        "-c:a", "libopus", "-b:a", "64k", "-shortest",
        args.output,
    ]
    encoder = subprocess.Popen(ffmpeg, stdin=subprocess.PIPE)

    interval = max(1, args.mask_every)
    buffered_frames: list[np.ndarray] = []
    previous_matte = None
    read_frames = 0
    written_frames = 0
    last_percent = -1
    print("PROGRESS:0", flush=True)

    def report_progress():
        nonlocal last_percent
        percent = min(100, round(written_frames * 100 / total))
        if percent != last_percent:
            print(f"PROGRESS:{percent}", flush=True)
            last_percent = percent

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break

            if previous_matte is None:
                previous_matte = model.predict(frame)
                write_frame(encoder, frame, previous_matte)
                read_frames += 1
                written_frames += 1
                report_progress()
                continue

            read_frames += 1
            buffered_frames.append(frame)
            if read_frames % interval != 0:
                continue

            next_matte = model.predict(frame)
            count = len(buffered_frames)
            for index, buffered_frame in enumerate(buffered_frames, start=1):
                mix = index / count
                interpolated = previous_matte * (1 - mix) + next_matte * mix
                write_frame(encoder, buffered_frame, interpolated)
                written_frames += 1
                report_progress()
            previous_matte = next_matte
            buffered_frames.clear()

        for buffered_frame in buffered_frames:
            write_frame(encoder, buffered_frame, previous_matte)
            written_frames += 1
            report_progress()
    finally:
        capture.release()
        if encoder.stdin:
            encoder.stdin.close()

    code = encoder.wait()
    if code != 0:
        raise RuntimeError(f"O encoder de vídeo terminou com código {code}.")
    if last_percent < 100:
        print("PROGRESS:100", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
