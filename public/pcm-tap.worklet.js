/**
 * Capture tap that replaces ScriptProcessorNode.
 * Chromium's ScriptProcessor often never fires for a MediaStream sourced
 * from another AudioContext (Playwright fakeMic). AudioWorklet does.
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);
