#!/usr/bin/env python3
# tools/stt.py — transcribe one audio file to plain text on stdout, using
# faster-whisper (CTranslate2, CPU int8). Chosen over whisper.cpp because it needs
# no sudo/cmake to install (pip in a venv) and is faster on minmus's CPU. Called by
# scripts/crm-media-worker.js:  python stt.py <audiofile> [model]
#
# Install (no sudo), on the pipeline host:
#   python3 -m venv ~/.crm-stt && ~/.crm-stt/bin/pip install faster-whisper
#   export CRM_STT_PYTHON=~/.crm-stt/bin/python
import sys

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: stt.py <audiofile> [model]\n")
        return 2
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"
    from faster_whisper import WhisperModel
    # int8 on CPU: smallest footprint, good enough for short voice notes. Model files
    # are downloaded and cached on first use under ~/.cache/huggingface.
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(audio, beam_size=1, vad_filter=True)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    sys.stdout.write(text)
    return 0

if __name__ == "__main__":
    sys.exit(main())
