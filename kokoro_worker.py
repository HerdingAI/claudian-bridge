import json
import sys
import time
import soundfile as sf
from kokoro_onnx import Kokoro


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: kokoro_worker.py <model_path> <voices_path>"}), flush=True)
        sys.exit(1)

    model_path = sys.argv[1]
    voices_path = sys.argv[2]
    kokoro = Kokoro(model_path, voices_path)
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text", "")
            voice = req.get("voice", "af_heart")
            speed = float(req.get("speed", 1.0))
            out_wav = req["out_wav"]

            t0 = time.perf_counter()
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
            sf.write(out_wav, samples, sample_rate)
            synth_ms = int((time.perf_counter() - t0) * 1000)
            audio_sec = round(len(samples) / float(sample_rate), 2) if sample_rate else 0.0

            print(
                json.dumps(
                    {
                        "ok": True,
                        "wav": out_wav,
                        "synth_ms": synth_ms,
                        "audio_sec": audio_sec,
                    }
                ),
                flush=True,
            )
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
