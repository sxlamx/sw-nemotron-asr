import asyncio, websockets, pathlib, sys

async def test():
    audio = list(pathlib.Path("data/speakers").glob("*.wav"))
    if not audio:
        print("No test wav found in data/speakers/")
        return
    wav_bytes = audio[0]
    data = wav_bytes.read_bytes()
    print(f"Sending {len(data)} bytes from {wav_bytes.name}")
    try:
        async with websockets.connect("ws://localhost:3007/ws/transcribe") as ws:
            await ws.send(data)
            resp = await asyncio.wait_for(ws.recv(), timeout=120)
            print("Response:", resp)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

asyncio.run(test())
