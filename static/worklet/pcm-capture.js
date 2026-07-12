// AudioWorklet processor: forwards mono PCM chunks to the main thread.
// Replaces the deprecated ScriptProcessorNode. Capture happens at the
// context's native sample rate; the main thread resamples to 16 kHz when
// an utterance is sent.
class PcmCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length) {
            // Copy — the underlying buffer is reused by the audio engine
            this.port.postMessage(new Float32Array(channel));
        }
        return true;
    }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
